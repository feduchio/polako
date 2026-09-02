import { resolve, sep } from "node:path";
import { PolishError } from "../shared/errors.js";

/** Safe worktree id: single path segment under the sandbox root. */
const SANDBOX_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function assertSandboxId(id: string): void {
  if (!SANDBOX_ID.test(id)) {
    throw new PolishError("SANDBOX_ERROR", `invalid sandbox id: ${id}`);
  }
}

export function sandboxPath(root: string, id: string): string {
  assertSandboxId(id);
  const path = resolve(root, id);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (!path.startsWith(prefix)) {
    throw new PolishError("SANDBOX_ERROR", `sandbox id escapes root: ${id}`);
  }
  return path;
}

export function assertGitCommitish(commitish: string): void {
  if (!commitish || commitish.startsWith("-")) {
    throw new PolishError("SANDBOX_ERROR", `invalid git commitish: ${commitish}`);
  }
}

/** Resolve a relative cwd under a sandbox worktree; rejects escapes. */
export function sandboxCwd(worktreePath: string, cwd: string): string {
  if (cwd.startsWith("/") || cwd.includes("\0")) {
    throw new PolishError("SANDBOX_ERROR", `invalid cwd: ${cwd}`);
  }
  const resolved = resolve(worktreePath, cwd);
  const prefix = worktreePath.endsWith(sep) ? worktreePath : worktreePath + sep;
  if (resolved !== worktreePath && !resolved.startsWith(prefix)) {
    throw new PolishError("SANDBOX_ERROR", `cwd escapes sandbox: ${cwd}`);
  }
  return resolved;
}
