import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import type { SandboxConfig } from "../domain/config.js";
import { PolishError } from "../shared/errors.js";
import type { CommandPolicy } from "./allowlist.js";
import { scrubEnv } from "./env.js";
import { Git, type DiffStat } from "./git.js";
import { assertGitCommitish, sandboxCwd, sandboxPath } from "./ids.js";
import { runProcess, type ProcessResult } from "./process.js";

export interface SandboxHandle {
  readonly id: string;
  readonly path: string;
  readonly branch: string | null;
  readonly baseCommit: string;
  readonly git: Git;
  /** run an allowlisted command inside the sandbox */
  run(argv: readonly string[], opts?: { timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string>; bypassPolicy?: boolean; cwd?: string }): Promise<ProcessResult>;
  headCommit(): Promise<string>;
  commitAll(message: string): Promise<string | null>;
  changedFiles(): Promise<string[]>;
  diffStat(): Promise<DiffStat>;
  diff(): Promise<string>;
  destroy(): Promise<void>;
}

export interface CreateSandboxInput {
  id: string;
  /** commit the sandbox starts from */
  baseCommit: string;
  /** create and check out this branch (candidates); when omitted the worktree is detached (gating checkouts) */
  branch?: string;
  policy: CommandPolicy;
  /** extra env for the project (e.g. declared in its profile) */
  projectEnv?: Record<string, string>;
}

export interface Sandbox {
  readonly kind: "worktree" | "sandbox-exec" | "container";
  /** true only when the backend provides real filesystem isolation */
  readonly isolates: boolean;
  create(input: CreateSandboxInput): Promise<SandboxHandle>;
  list(): Promise<string[]>;
  destroyAll(): Promise<void>;
}

/**
 * v1 backend: git worktrees under `<root>/<id>`. Workspace isolation only — see ADR-0003.
 */
export class WorktreeSandbox implements Sandbox {
  readonly kind = "worktree" as const;
  readonly isolates = false;
  private readonly repo: Git;
  private readonly root: string;

  constructor(
    repoPath: string,
    root: string,
    private readonly config: SandboxConfig,
  ) {
    this.repo = new Git(repoPath);
    mkdirSync(root, { recursive: true });
    // git reports realpaths (macOS: /var -> /private/var); normalize once so list() can compare
    this.root = realpathSync(root);
  }

  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    assertGitCommitish(input.baseCommit);
    const path = sandboxPath(this.root, input.id);
    if (existsSync(path)) throw new PolishError("CONFLICT", `sandbox path already exists: ${path}`);
    if (input.branch) {
      if (await this.repo.branchExists(input.branch)) {
        throw new PolishError("CONFLICT", `branch already exists: ${input.branch}`);
      }
      await this.repo.worktreeAdd(path, input.baseCommit, { branch: input.branch });
    } else {
      await this.repo.worktreeAdd(path, input.baseCommit, { detach: true });
    }
    const git = new Git(path);
    const baseEnv = scrubEnv(
      process.env,
      { allowlist: this.config.envAllowlist, denyPatterns: this.config.envDenyPatterns },
      input.projectEnv ?? {},
    );
    const cfg = this.config;
    const repo = this.repo;
    const handle: SandboxHandle = {
      id: input.id,
      path,
      branch: input.branch ?? null,
      baseCommit: input.baseCommit,
      git,
      run(argv, opts = {}) {
        if (!opts.bypassPolicy) {
          const denial = input.policy.check(argv);
          if (denial) return Promise.reject(new PolishError("SANDBOX_ERROR", denial, { argv }));
        }
        let cwd = path;
        if (opts.cwd !== undefined) {
          try {
            cwd = sandboxCwd(path, opts.cwd);
          } catch (err) {
            return Promise.reject(err instanceof Error ? err : new PolishError("SANDBOX_ERROR", String(err)));
          }
        }
        return runProcess({
          argv,
          cwd,
          env: {
            ...scrubEnv(
              {},
              { allowlist: Object.keys(opts.env ?? {}), denyPatterns: cfg.envDenyPatterns, fixed: {} },
              opts.env ?? {},
            ),
            ...baseEnv,
          },
          timeoutMs: opts.timeoutMs ?? cfg.commandTimeoutMs,
          maxOutputBytes: cfg.maxOutputBytes,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
      },
      headCommit: () => git.revParse(),
      commitAll: (message) => git.commitAll(message),
      changedFiles: () => git.changedFiles(),
      diffStat: () => git.diffStat(input.baseCommit),
      diff: () => git.diff(input.baseCommit),
      destroy: async () => {
        await repo.worktreeRemove(path, true);
        rmSync(path, { recursive: true, force: true });
      },
    };
    return handle;
  }

  async list(): Promise<string[]> {
    const all = await this.repo.worktreeList();
    return all.filter((p) => p.startsWith(this.root + "/"));
  }

  async destroyAll(): Promise<void> {
    for (const p of await this.list()) await this.repo.worktreeRemove(p, true);
    rmSync(this.root, { recursive: true, force: true });
    mkdirSync(this.root, { recursive: true });
  }
}
