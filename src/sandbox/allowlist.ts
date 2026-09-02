/**
 * Command policy for worker-initiated shell commands. Each rule is an argv prefix; a command
 * is allowed if some rule's prefix matches its leading argv elements exactly. Read-only git
 * commands are allowed by default; anything that rewrites history or touches remotes is not.
 */
export interface CommandRule {
  prefix: readonly string[];
  description: string;
}

export const READONLY_GIT_RULES: readonly CommandRule[] = [
  { prefix: ["git", "status"], description: "git status" },
  { prefix: ["git", "diff"], description: "git diff" },
  { prefix: ["git", "log"], description: "git log" },
  { prefix: ["git", "show"], description: "git show" },
  { prefix: ["git", "blame"], description: "git blame" },
  { prefix: ["git", "grep"], description: "git grep" },
  { prefix: ["git", "ls-files"], description: "git ls-files" },
  { prefix: ["git", "rev-parse"], description: "git rev-parse" },
];

export const SEARCH_RULES: readonly CommandRule[] = [
  { prefix: ["rg"], description: "ripgrep" },
  { prefix: ["ls"], description: "ls" },
  { prefix: ["cat"], description: "cat" },
  { prefix: ["wc"], description: "wc" },
  { prefix: ["head"], description: "head" },
  { prefix: ["tail"], description: "tail" },
  { prefix: ["find"], description: "find" },
];

const SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

function shellBasename(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash >= 0 ? token.slice(slash + 1) : token;
}

function isShellName(token: string): boolean {
  return SHELL_NAMES.has(shellBasename(token).toLowerCase());
}

function shellScriptFlagsAfter(argv: readonly string[], shellIndex: number): boolean {
  for (let j = shellIndex + 1; j < argv.length; j++) {
    const a = argv[j];
    if (a === undefined) continue;
    if (a === "-c" || a === "--command") return true;
    if (a.startsWith("-") && !a.startsWith("--") && a.slice(1).includes("c")) return true;
  }
  return false;
}

/** True when argv invokes a shell to run a script string (-c / combined short opts). */
export function invokesShellScript(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  const candidates: number[] = [0];
  if (argv[0]?.toLowerCase() === "env" && argv.length > 1) candidates.push(1);
  for (const i of candidates) {
    const token = argv[i];
    if (token === undefined || !isShellName(token)) continue;
    if (shellScriptFlagsAfter(argv, i)) return true;
  }
  return false;
}

export class CommandPolicy {
  private readonly rules: CommandRule[];

  constructor(rules: readonly CommandRule[], private readonly allowArbitrary = false) {
    this.rules = [...rules];
  }

  static forProject(checkCommands: readonly (readonly string[])[], packageManager: string | null, allowArbitrary = false): CommandPolicy {
    const rules: CommandRule[] = [...READONLY_GIT_RULES, ...SEARCH_RULES];
    for (const argv of checkCommands) rules.push({ prefix: argv, description: `project check: ${argv.join(" ")}` });
    if (packageManager) {
      rules.push({ prefix: [packageManager, "run"], description: `${packageManager} run <script>` });
      rules.push({ prefix: [packageManager, "test"], description: `${packageManager} test` });
      rules.push({ prefix: [packageManager, "exec"], description: `${packageManager} exec <bin>` });
      rules.push({ prefix: [packageManager, "ls"], description: `${packageManager} ls` });
      rules.push({ prefix: [packageManager, "why"], description: `${packageManager} why` });
    }
    return new CommandPolicy(rules, allowArbitrary);
  }

  /** Returns null when allowed, otherwise a human-readable denial reason. */
  check(argv: readonly string[]): string | null {
    if (argv.length === 0) return "empty command";
    if (invokesShellScript(argv)) {
      return "shell -c is not allowed; call the program directly";
    }
    if (argv.some((a) => /^(\||&&|;|>|>>|<)$/.test(a))) return "shell operators are not allowed";
    if (this.allowArbitrary) return null;
    const matched = this.rules.some((r) => r.prefix.length <= argv.length && r.prefix.every((p, i) => argv[i] === p));
    return matched ? null : `command not in allowlist: ${argv.join(" ")}`;
  }

  describe(): string[] {
    return this.rules.map((r) => r.description);
  }
}
