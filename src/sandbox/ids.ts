import { realpathSync } from "node:fs";
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

/** Resolve a relative cwd under a sandbox worktree; rejects escapes (including via symlinks). */
export function sandboxCwd(worktreePath: string, cwd: string): string {
  if (cwd.startsWith("/") || cwd.includes("\0")) {
    throw new PolishError("SANDBOX_ERROR", `invalid cwd: ${cwd}`);
  }
  const worktreeReal = realpathSync(worktreePath);
  const resolved = resolve(worktreeReal, cwd);
  const prefix = worktreeReal.endsWith(sep) ? worktreeReal : worktreeReal + sep;
  let resolvedReal: string;
  try {
    resolvedReal = realpathSync(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
    if (resolved !== worktreeReal && !resolved.startsWith(prefix)) {
      throw new PolishError("SANDBOX_ERROR", `cwd escapes sandbox: ${cwd}`);
    }
    return resolved;
  }
  if (resolvedReal !== worktreeReal && !resolvedReal.startsWith(prefix)) {
    throw new PolishError("SANDBOX_ERROR", `cwd escapes sandbox: ${cwd}`);
  }
  return resolvedReal;
}
