import { PolishError } from "../shared/errors.js";
import { runProcess, type ProcessResult } from "./process.js";

const GIT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  LC_ALL: "C",
  GIT_AUTHOR_NAME: "polish",
  GIT_AUTHOR_EMAIL: "polish@localhost",
  GIT_COMMITTER_NAME: "polish",
  GIT_COMMITTER_EMAIL: "polish@localhost",
};

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

/**
 * Thin, argv-based git wrapper bound to one working directory. No shell, fixed identity,
 * no prompts. Every call is a subprocess so it is trivially loggable by callers.
 */
export class Git {
  constructor(
    readonly cwd: string,
    private readonly timeoutMs = 120_000,
  ) {}

  static async init(dir: string, initialBranch = "main"): Promise<Git> {
    const git = new Git(dir);
    await git.run(["init", "-q", "-b", initialBranch]);
    return git;
  }

  async run(args: readonly string[], opts: { allowFailure?: boolean; signal?: AbortSignal } = {}): Promise<ProcessResult> {
    const result = await runProcess({
      argv: ["git", ...args],
      cwd: this.cwd,
      env: { ...GIT_ENV, PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: process.env["HOME"] ?? "/tmp" },
      timeoutMs: this.timeoutMs,
      maxOutputBytes: 8 * 1024 * 1024,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (result.exitCode !== 0 && !opts.allowFailure) {
      throw new PolishError("SANDBOX_ERROR", `git ${args.join(" ")} failed (${result.exitCode})`, {
        cwd: this.cwd,
        stderr: result.stderr.slice(0, 2000),
      });
    }
    return result;
  }

  async out(args: readonly string[]): Promise<string> {
    return (await this.run(args)).stdout.trim();
  }

  revParse(ref = "HEAD"): Promise<string> {
    return this.out(["rev-parse", "--verify", `${ref}^{commit}`]);
  }

  async isRepo(): Promise<boolean> {
    const r = await this.run(["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
    return r.exitCode === 0 && r.stdout.trim() === "true";
  }

  async toplevel(): Promise<string> {
    return this.out(["rev-parse", "--show-toplevel"]);
  }

  async isClean(): Promise<boolean> {
    return (await this.out(["status", "--porcelain", "--untracked-files=all"])) === "";
  }

  async changedFiles(base?: string): Promise<string[]> {
    const args = base ? ["diff", "--name-only", base] : ["status", "--porcelain", "--untracked-files=all"];
    const text = await this.out(args);
    if (!text) return [];
    return base ? text.split("\n") : text.split("\n").map((l) => l.slice(3).trim());
  }

  async diffStat(base: string, head = "HEAD"): Promise<DiffStat> {
    const text = await this.out(["diff", "--shortstat", `${base}..${head}`]);
    const files = /(\d+) files? changed/.exec(text);
    const ins = /(\d+) insertions?/.exec(text);
    const del = /(\d+) deletions?/.exec(text);
    return { files: num(files), insertions: num(ins), deletions: num(del) };
  }

  diff(base: string, head = "HEAD"): Promise<string> {
    return this.out(["diff", "--no-color", `${base}..${head}`]);
  }

  /** Stage everything and commit; returns the new commit or null when nothing changed. */
  async commitAll(message: string): Promise<string | null> {
    await this.run(["add", "-A"]);
    const staged = await this.run(["diff", "--cached", "--quiet"], { allowFailure: true });
    if (staged.exitCode === 0) return null;
    await this.run(["commit", "-q", "--no-verify", "-m", message]);
    return this.revParse();
  }

  async branchExists(name: string): Promise<boolean> {
    const r = await this.run(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], { allowFailure: true });
    return r.exitCode === 0;
  }

  createBranch(name: string, startPoint: string): Promise<ProcessResult> {
    return this.run(["branch", "-q", name, startPoint]);
  }

  updateRef(ref: string, commit: string): Promise<ProcessResult> {
    return this.run(["update-ref", ref, commit]);
  }

  async worktreeAdd(path: string, commitish: string, opts: { branch?: string; detach?: boolean } = {}): Promise<void> {
    const args = ["worktree", "add", "-q"];
    if (opts.detach) args.push("--detach");
    if (opts.branch) args.push("-b", opts.branch);
    args.push(path, commitish);
    await this.run(args);
  }

  async worktreeRemove(path: string, force = true): Promise<void> {
    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(path);
    await this.run(args, { allowFailure: true });
    await this.run(["worktree", "prune"], { allowFailure: true });
  }

  async worktreeList(): Promise<string[]> {
    const text = await this.out(["worktree", "list", "--porcelain"]);
    return text
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length));
  }

  /** Fast-forward `branch` to `commit` if possible; returns false if not an ancestor. */
  async fastForward(branch: string, commit: string): Promise<boolean> {
    const tip = await this.revParse(branch);
    const anc = await this.run(["merge-base", "--is-ancestor", tip, commit], { allowFailure: true });
    if (anc.exitCode !== 0) return false;
    await this.run(["update-ref", `refs/heads/${branch}`, commit, tip]);
    return true;
  }

  /** Apply the changes of `commit` (relative to its parent) onto the current HEAD in this worktree. */
  async cherryPick(commit: string): Promise<{ ok: boolean; conflicts: string[] }> {
    const r = await this.run(["cherry-pick", "--no-commit", "--allow-empty", commit], { allowFailure: true });
    if (r.exitCode === 0) return { ok: true, conflicts: [] };
    const conflicts = (await this.out(["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
    await this.run(["cherry-pick", "--abort"], { allowFailure: true });
    await this.run(["reset", "-q", "--hard"], { allowFailure: true });
    return { ok: false, conflicts };
  }
}

function num(m: RegExpExecArray | null): number {
  return m?.[1] !== undefined ? Number(m[1]) : 0;
}
