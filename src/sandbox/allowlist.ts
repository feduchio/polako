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

/** Search/read-only tools whose argv may contain pattern tokens that look like shell names. */
const SEARCH_TOOLS = new Set(["rg", "ls", "cat", "wc", "head", "tail", "find", "git"]);

const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);

/** Flags that cause the following token to be executed as a child program. */
const EXECUTION_MARKERS = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "--pre",
  "--pre-glob",
  "--hostname-bin",
]);

function shellBasename(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash >= 0 ? token.slice(slash + 1) : token;
}

function isShellName(token: string): boolean {
  return SHELL_NAMES.has(shellBasename(token).toLowerCase());
}

function isSearchTool(token: string): boolean {
  return SEARCH_TOOLS.has(shellBasename(token).toLowerCase());
}

function isEnvWrapper(token: string): boolean {
  return shellBasename(token).toLowerCase() === "env";
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

/** True when a shell token at shellIndex is being executed, not used as a search pattern. */
function hasExecutionPrefix(argv: readonly string[], shellIndex: number): boolean {
  for (let j = shellIndex - 1; j >= 0; j--) {
    const a = argv[j];
    if (a === undefined) continue;
    if (EXECUTION_MARKERS.has(a)) return true;
    if (isEnvWrapper(a)) return true;
    if (a === "exec" && j >= 1) {
      const pm = shellBasename(argv[j - 1] ?? "").toLowerCase();
      if (PACKAGE_MANAGERS.has(pm)) {
        const invoked = argv[j + 1];
        if (invoked !== undefined && isShellName(invoked) && shellIndex === j + 1) return true;
      }
    }
  }
  return false;
}

/** True when a shell-like token is an argument to a search tool, not an invoked program. */
function isPatternContext(argv: readonly string[], shellIndex: number): boolean {
  if (shellIndex === 0) return false;
  if (isSearchTool(argv[0] ?? "")) return true;
  for (let j = 0; j < argv.length - 1; j++) {
    if (argv[j] !== "exec") continue;
    const pm = j >= 1 ? shellBasename(argv[j - 1] ?? "").toLowerCase() : "";
    if (!PACKAGE_MANAGERS.has(pm)) continue;
    const invoked = argv[j + 1];
    if (invoked !== undefined && isSearchTool(invoked) && shellIndex > j + 1) return true;
  }
  return false;
}

/** Git pager options run their value through a shell; reject any parse-options spelling. */
function gitExternalCommandDenial(argv: readonly string[]): string | null {
  if (shellBasename(argv[0] ?? "").toLowerCase() !== "git") return null;
  for (const a of argv) {
    // Short -O alone, fused, spaced, or clustered with other short flags (-iOtouch, -inO…).
    if (/^-[a-z0-9]*O/.test(a)) return "git pager/external-command options are not allowed";
    if (!a.startsWith("--")) continue;
    const name = a.slice(2).split("=", 1)[0] ?? "";
    if (name.length === 0) continue;
    // Unique prefixes of --open-files-in-pager (--op…; not --oneline / --output).
    if (name.startsWith("op") && "open-files-in-pager".startsWith(name)) {
      return "git pager/external-command options are not allowed";
    }
    // Unique prefixes of --pager (--pag…; not --patch / --parents).
    if (name.length >= 3 && "pager".startsWith(name)) {
      return "git pager/external-command options are not allowed";
    }
  }
  return null;
}

/** True when argv invokes a shell to run a script string (-c / combined short opts). */
export function invokesShellScript(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined || !isShellName(token)) continue;
    if (!shellScriptFlagsAfter(argv, i)) continue;
    if (i === 0) return true;
    if (hasExecutionPrefix(argv, i)) return true;
    if (isPatternContext(argv, i)) continue;
    return true;
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
    const gitDenial = gitExternalCommandDenial(argv);
    if (gitDenial) return gitDenial;
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
