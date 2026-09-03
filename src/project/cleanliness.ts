import { execFileSync } from "node:child_process";
import { PolishError } from "../shared/errors.js";

export interface RepositoryCleanliness {
  clean: boolean;
  changedPaths: string[];
}

export interface RepositoryStartPolicy {
  includeDirty?: boolean;
  /** Reserved for a future isolated dirty-snapshot implementation; unsupported in Phase A. */
  syntheticSnapshotRef?: string;
}

/** Pure interpretation of `git status --porcelain` output. */
export function isRepositoryDirty(porcelain: string): boolean {
  return porcelain.split(/\r?\n/).some((line) => line.length > 0);
}

/** Read-only repository check. It never stashes, resets, stages, cleans, or commits. */
export function checkRepositoryClean(projectPath: string): RepositoryCleanliness {
  let output: string;
  try {
    output = execFileSync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      {
        cwd: projectPath,
        encoding: "utf8",
        env: {
          PATH: process.env["PATH"] ?? "/usr/bin:/bin",
          HOME: process.env["HOME"] ?? "/tmp",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
        },
        maxBuffer: 8 * 1024 * 1024,
      },
    );
  } catch (error) {
    throw new PolishError("INVARIANT_VIOLATION", "target project must be an accessible git worktree", {
      projectPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const changedPaths = output
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));
  return { clean: !isRepositoryDirty(output), changedPaths };
}

export function assertRepositoryClean(
  projectPath: string,
  policy: RepositoryStartPolicy = {},
): void {
  if (policy.includeDirty === true || policy.syntheticSnapshotRef !== undefined) {
    throw new PolishError(
      "CONFIG_ERROR",
      "includeDirty and synthetic snapshots are unsupported in Phase A; a clean tree is required",
      { projectPath },
    );
  }
  const result = checkRepositoryClean(projectPath);
  if (!result.clean) {
    throw new PolishError("CONFLICT", "target repository has uncommitted changes; Phase A requires a clean tree", {
      projectPath,
      changedPaths: result.changedPaths,
    });
  }
}
