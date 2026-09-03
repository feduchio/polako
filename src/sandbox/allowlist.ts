/**
 * Command policy for worker-initiated shell commands. Grants are exact argv vectors.
 * Dedicated validators cover a deliberately small read-only git/search vocabulary.
 */
export interface CommandRule {
  prefix: readonly string[];
  description: string;
  /** Project checks are exact; explicit task/package capabilities may accept trailing argv. */
  match?: "exact" | "prefix";
}

export interface ProjectCommandCapabilities {
  /** Exact package.json script names permitted through `<manager> run <name>`. */
  packageScripts?: readonly string[];
  /**
   * Named package scripts that may receive extra argv after `<manager> run <name>`.
   * Default worker policy is exact: trailing `--config` / `--` is denied.
   */
  packageScriptsAllowTrailingArgs?: readonly string[];
  /** Additional task-scoped argv prefixes; absent unless explicitly granted by the caller. */
  taskGrants?: readonly CommandRule[];
  /**
   * Grant the dedicated search/read vocabulary (`SEARCH_RULES`) with option and
   * operand confinement. Default policy does not include these; safe tools own
   * read/search rather than arbitrary shell.
   */
  search?: boolean;
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
];

const SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** Search/read-only tools whose argv may contain pattern tokens that look like shell names. */
const SEARCH_TOOLS = new Set(["rg", "ls", "cat", "wc", "head", "tail", "git"]);

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
    // Short -O alone, fused, spaced, or clustered with other short flags (-iOtouch, -IOsh, -inO…).
    if (/^-[A-Za-z0-9]*O/.test(a)) return "git pager/external-command options are not allowed";
    if (a === "--") break;
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
    if (rules.some((rule) => rule.prefix.length === 0)) {
      throw new TypeError("command rules must have a non-empty argv prefix");
    }
    this.rules = [...rules];
  }

  static forProject(
    checkCommands: readonly (readonly string[])[],
    packageManager: string | null,
    allowArbitrary = false,
    capabilities: ProjectCommandCapabilities = {},
  ): CommandPolicy {
    const rules: CommandRule[] = [];
    for (const argv of checkCommands) {
      rules.push({ prefix: argv, description: `project check: ${argv.join(" ")}`, match: "exact" });
    }
    if (packageManager !== null) {
      const trailing = new Set(capabilities.packageScriptsAllowTrailingArgs ?? []);
      for (const script of capabilities.packageScripts ?? []) {
        rules.push({
          prefix: [packageManager, "run", script],
          description: `${packageManager} package script: ${script}`,
          match: trailing.has(script) ? "prefix" : "exact",
        });
      }
    }
    if (capabilities.search) {
      for (const rule of SEARCH_RULES) {
        rules.push({ ...rule, match: "prefix" });
      }
    }
    for (const grant of capabilities.taskGrants ?? []) {
      rules.push({ ...grant, match: "prefix" });
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
    const toolSafety = checkKnownToolSafety(argv);
    if (toolSafety) return toolSafety;
    if (this.allowArbitrary) return null;
    if (shellBasename(argv[0] ?? "").toLowerCase() === "git") {
      return checkGit(argv) ?? checkEscapingOperands(argv, 2);
    }
    const matched = this.rules.some((r) => {
      const lengthMatches = r.match === "prefix"
        ? r.prefix.length <= argv.length
        : r.prefix.length === argv.length;
      return lengthMatches && r.prefix.every((p, i) => argv[i] === p);
    });
    return matched ? null : `command not in allowlist: ${argv.join(" ")}`;
  }

  describe(): string[] {
    return this.rules.map((r) => r.description);
  }
}

function checkKnownToolSafety(argv: readonly string[]): string | null {
  const command = shellBasename(argv[0] ?? "").toLowerCase();
  if (command === "git") return checkEscapingOperands(argv, 2);
  if (command === "rg") return checkOptions(argv, RG_OPTIONS, "rg") ?? checkEscapingOperands(argv, 1);
  if (command === "ls") return checkOptions(argv, LS_OPTIONS, "ls") ?? checkEscapingOperands(argv, 1);
  if (command === "cat") return checkOptions(argv, CAT_OPTIONS, "cat") ?? checkEscapingOperands(argv, 1);
  if (command === "wc") return checkOptions(argv, WC_OPTIONS, "wc") ?? checkEscapingOperands(argv, 1);
  if (command === "head" || command === "tail") return checkHeadTail(argv) ?? checkEscapingOperands(argv, 1);
  return null;
}

function isEscapingPathOperand(token: string): boolean {
  if (!token) return false;
  const norm = token.replaceAll("\\", "/");
  if (norm.startsWith("/") || /^[A-Za-z]:\//.test(norm)) return true;
  if (norm.startsWith("~/") || norm === "~") return true;
  if (norm.split("/").includes("..")) return true;
  if (norm.includes(":../") || norm.endsWith(":..")) return true;
  return false;
}

function checkEscapingOperands(argv: readonly string[], start: number): string | null {
  let operands = false;
  for (let i = start; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!operands && arg === "--") {
      operands = true;
      continue;
    }
    if (!operands && arg.startsWith("-")) continue;
    if (isEscapingPathOperand(arg)) return `path operand is outside the worktree: ${arg}`;
  }
  return null;
}

const RG_OPTIONS = new Set([
  "-n", "--line-number", "-i", "--ignore-case", "-S", "--smart-case", "-F", "--fixed-strings",
  "-l", "--files-with-matches", "-L", "--files-without-match", "-c", "--count", "--count-matches",
  "--hidden", "--no-ignore", "--no-messages",
]);
const LS_OPTIONS = new Set(["-a", "-A", "-l", "-la", "-al", "-1", "--all"]);
const CAT_OPTIONS = new Set(["-n", "--number", "-b", "--number-nonblank"]);
const WC_OPTIONS = new Set(["-l", "--lines", "-w", "--words", "-c", "--bytes"]);

function checkOptions(argv: readonly string[], allowed: ReadonlySet<string>, name: string): string | null {
  let operands = false;
  for (const arg of argv.slice(1)) {
    if (arg === "--") {
      operands = true;
      continue;
    }
    if (!operands && arg.startsWith("-") && !allowed.has(arg)) return `${name} option not allowed: ${arg}`;
  }
  return null;
}

function checkHeadTail(argv: readonly string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--") break;
    if (arg === "-n" || arg === "--lines" || arg === "-c" || arg === "--bytes") {
      const count = argv[++i];
      if (!count || !/^\d+$/.test(count)) return `${argv[0]} requires a non-negative count`;
      continue;
    }
    if (/^-\d+$/.test(arg)) continue;
    if (arg.startsWith("-")) return `${argv[0]} option not allowed: ${arg}`;
  }
  return null;
}

const GIT_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  status: new Set(["--short", "-s", "--branch", "-b", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--untracked-files=all", "--untracked-files=no"]),
  diff: new Set(["--no-color", "--stat", "--shortstat", "--name-only", "--name-status", "--cached", "--staged", "--check", "--exit-code", "--quiet"]),
  log: new Set(["--oneline", "--no-color", "--decorate", "--no-decorate"]),
  show: new Set(["--oneline", "--no-color", "--stat", "--name-only", "--name-status"]),
  blame: new Set(["--porcelain", "--line-porcelain"]),
  "ls-files": new Set(["--cached", "--others", "--deleted", "--modified", "--exclude-standard"]),
  "rev-parse": new Set(["--verify", "--show-toplevel", "--is-inside-work-tree", "--show-prefix", "--show-cdup"]),
};

function checkGit(argv: readonly string[]): string | null {
  const subcommand = argv[1];
  if (!subcommand || !(subcommand in GIT_OPTIONS)) return `git command not read-only allowlisted: ${subcommand ?? ""}`;
  const allowed = GIT_OPTIONS[subcommand];
  if (!allowed) return `git command not read-only allowlisted: ${subcommand}`;
  let operands = false;
  for (const arg of argv.slice(2)) {
    if (arg === "--") {
      operands = true;
      continue;
    }
    if (operands || !arg.startsWith("-")) continue;
    if (allowed.has(arg)) continue;
    if (subcommand === "log" && (/^-n\d+$/.test(arg) || /^--max-count=\d+$/.test(arg))) continue;
    if ((subcommand === "diff" || subcommand === "show") && /^-U\d+$/.test(arg)) continue;
    return `git option not allowed for ${subcommand}: ${arg}`;
  }
  return null;
}
