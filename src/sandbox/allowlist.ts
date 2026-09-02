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

const SHELL_METACHARS = /[;&|<>`$(){}\\]/;

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
    if (argv.some((a) => a === "sh" || a === "bash" || a === "zsh") && argv.some((a) => a === "-c")) {
      return "shell -c is not allowed; call the program directly";
    }
    if (argv.some((a) => SHELL_METACHARS.test(a) && !a.startsWith("-"))) {
      // metachars in bare arguments are fine for e.g. rg patterns, but forbid obvious redirections/chains
      if (argv.some((a) => /^(\||&&|;|>|>>|<)$/.test(a))) return "shell operators are not allowed";
    }
    if (this.allowArbitrary) return null;
    const matched = this.rules.some((r) => r.prefix.length <= argv.length && r.prefix.every((p, i) => argv[i] === p));
    return matched ? null : `command not in allowlist: ${argv.join(" ")}`;
  }

  describe(): string[] {
    return this.rules.map((r) => r.description);
  }
}
