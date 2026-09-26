import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
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

export interface ChangedFileStatus {
  status: string;
  path: string;
}

/**
 * Thin, argv-based git wrapper bound to one working directory. No shell, fixed identity,
 * no prompts. Every call is a subprocess so it is trivially loggable by callers.
 */
export class Git {
  private readonly excluded = new Set<string>();

  constructor(
    readonly cwd: string,
    private readonly timeoutMs = 120_000,
    private readonly maxOutputBytes = 8 * 1024 * 1024,
  ) {}

  /**
   * Leave these worktree-relative paths out of commits, working-tree diffs and untracked listings.
   * They are what a dependency install wrote into a checkout, not anyone's work.
   */
  exclude(paths: readonly string[]): void {
    for (const path of paths) {
      if (path !== "" && !isAbsolute(path) && !path.split(/[\\/]/).includes("..")) this.excluded.add(path);
    }
  }

  excludedPaths(): string[] {
    return [...this.excluded].sort();
  }

  private pathspec(): string[] {
    return this.excluded.size === 0 ? [] : ["--", ".", ...this.excludedPaths().map((path) => `:(exclude)${path}`)];
  }

  /** Tracked or addable files under `path`: not ignored, not excluded. */
  async listFiles(path = "."): Promise<string[]> {
    const spec = this.excluded.size === 0 ? ["--", path] : ["--", path, ...this.excludedPaths().map((p) => `:(exclude)${p}`)];
    const text = (await this.run(["ls-files", "-z", "--cached", "--others", "--exclude-standard", ...spec])).stdout;
    return [...new Set(text.split("\0").filter(Boolean))];
  }

  /** Untracked, not ignored, and not excluded. */
  async untrackedFiles(): Promise<string[]> {
    const text = await this.out(["ls-files", "--others", "--exclude-standard", ...this.pathspec()]);
    return text.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  static async init(dir: string, initialBranch = "main"): Promise<Git> {
    const git = new Git(dir);
    await git.run(["init", "-q", "-b", initialBranch]);
    return git;
  }

  async run(
    args: readonly string[],
    opts: { allowFailure?: boolean; signal?: AbortSignal; captureOutputBytes?: boolean } = {},
  ): Promise<ProcessResult> {
    const result = await runProcess({
      argv: ["git", ...args],
      cwd: this.cwd,
      env: { ...GIT_ENV, PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: process.env["HOME"] ?? "/tmp" },
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.captureOutputBytes === undefined ? {} : { captureOutputBytes: opts.captureOutputBytes }),
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
    if (!base) {
      const text = await this.out(["status", "--porcelain", "--untracked-files=all"]);
      if (!text) return [];
      return text.split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
    }
    const [diff, untracked] = await Promise.all([
      this.out(["diff", "--name-only", base, ...this.pathspec()]),
      this.untrackedFiles(),
    ]);
    const seen = new Set<string>();
    const files: string[] = [];
    for (const line of [...diff.split("\n"), ...untracked]) {
      const path = line.trim();
      if (!path || seen.has(path)) continue;
      seen.add(path);
      files.push(path);
    }
    return files;
  }

  /** File content at a commit, without checking anything out. */
  async showFile(commit: string, path: string): Promise<string> {
    return (await this.run(["show", `${commit}:${path}`])).stdout;
  }

  /** Exact blob bytes at a commit. Output above the subprocess cap is rejected, never hashed partially. */
  async showFileBytes(commit: string, path: string): Promise<Uint8Array> {
    const result = await this.run(["show", `${commit}:${path}`], { captureOutputBytes: true });
    if (result.truncated || result.stdoutBytes === undefined) {
      throw new PolishError("IO_ERROR", `git show output was truncated for ${path}`, {
        commit,
        path,
        maxOutputBytes: this.maxOutputBytes,
      });
    }
    return result.stdoutBytes;
  }

  async changedFilesBetween(base: string, head: string): Promise<string[]> {
    const text = await this.out(["diff", "--name-only", "-z", `${base}..${head}`]);
    return text.split("\0").filter((path) => path.length > 0);
  }

  async changedFileStatusesBetween(base: string, head: string): Promise<ChangedFileStatus[]> {
    const fields = (await this.out(["diff", "--name-status", "-z", `${base}..${head}`]))
      .split("\0")
      .filter((field) => field.length > 0);
    const changes: ChangedFileStatus[] = [];
    for (let index = 0; index < fields.length;) {
      const status = fields[index++];
      if (status === undefined) break;
      const firstPath = fields[index++];
      if (firstPath === undefined) break;
      if (status.startsWith("R") || status.startsWith("C")) {
        const destination = fields[index++];
        if (destination === undefined) break;
        changes.push({ status, path: destination });
      } else {
        changes.push({ status, path: firstPath });
      }
    }
    return changes;
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

  /**
   * Working-tree diff vs `base`, **tracked files only**.
   *
   * The counterpart to `diffAgainst`, for asking what the checkout looks like after something other
   * than the candidate has written to it. An install creates an untracked `node_modules`, which a
   * repository is entitled not to ignore; limiting the question to tracked files asks about the
   * project rather than about what we installed into it. Finding 54.
   */
  trackedDiffAgainst(base: string): Promise<string> {
    return this.out(["diff", "--no-color", base]);
  }

  /**
   * Working-tree diff vs `base`, including untracked files as added-file hunks.
   * Unlike `diff(base, head)` this is not limited to the committed range.
   */
  async diffAgainst(base: string): Promise<string> {
    const tracked = await this.out(["diff", "--no-color", base, ...this.pathspec()]);
    const untracked = await this.untrackedFiles();
    if (untracked.length === 0) return tracked;
    const parts: string[] = tracked === "" ? [] : [tracked];
    for (const rel of untracked) {
      if (!rel || isAbsolute(rel) || rel.includes("\0") || rel.split(/[\\/]/).includes("..")) continue;
      const target = resolve(this.cwd, rel);
      const fromRoot = relative(this.cwd, target);
      if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) continue;
      let content: string;
      try {
        content = readFileSync(target, "utf8");
      } catch {
        continue;
      }
      parts.push(
        `diff --git a/${rel} b/${rel}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${rel}`,
        ...content.split("\n").map((line) => `+${line}`),
      );
    }
    return parts.join("\n");
  }

  /** Stage everything and commit; returns the new commit or null when nothing changed. */
  async commitAll(message: string): Promise<string | null> {
    await this.run(["add", "-A", ...this.pathspec()]);
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
    args.push("--", path, commitish);
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
    const dirty = !(await this.isClean());
    if (dirty) await this.run(["stash", "push", "-u", "-m", "polish:pre-cherry-pick"]);
    const r = await this.run(["cherry-pick", "--no-commit", "--allow-empty", commit], { allowFailure: true });
    if (r.exitCode !== 0) {
      const conflicts = (await this.out(["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
      await this.run(["reset", "-q", "--hard"], { allowFailure: true });
      await this.run(["clean", "-fd"], { allowFailure: true });
      if (dirty) await this.run(["stash", "pop"], { allowFailure: true });
      return { ok: false, conflicts };
    }
    if (dirty) {
      const pop = await this.run(["stash", "pop"], { allowFailure: true });
      const unmerged = (await this.out(["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
      if (pop.exitCode !== 0 || unmerged.length > 0) {
        await this.run(["reset", "-q", "--hard"], { allowFailure: true });
        await this.run(["clean", "-fd"], { allowFailure: true });
        const stashList = await this.run(["stash", "list"], { allowFailure: true });
        if (stashList.stdout.includes("polish:pre-cherry-pick")) {
          await this.run(["stash", "pop"], { allowFailure: true });
        }
        return { ok: false, conflicts: unmerged.length > 0 ? unmerged : ["stash pop conflict"] };
      }
    }
    return { ok: true, conflicts: [] };
  }
}

function num(m: RegExpExecArray | null): number {
  return m?.[1] !== undefined ? Number(m[1]) : 0;
}
