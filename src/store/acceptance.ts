import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AcceptanceArtifact } from "../domain/acceptance.js";
import { sha256Hex } from "../shared/hash.js";
import { PolishError } from "../shared/errors.js";
import type { ArtifactStore } from "./artifacts.js";

export interface ProtectedPathProblem {
  path: string;
  reason: "missing" | "modified" | "not_a_file";
}

/**
 * Acceptance artifact content lives in the CAS (outside every worktree). This service
 * materializes artifacts into a checkout for gating and verifies that a checkout has not
 * tampered with protected paths.
 */
export class AcceptanceStorage {
  constructor(private readonly artifacts: ArtifactStore) {}

  /** Store content; returns the sha the AcceptanceArtifact must carry. */
  putContent(content: string | Uint8Array, label: string): string {
    return this.artifacts.put(content, "acceptance", label).sha256;
  }

  /**
   * Copy every artifact into `checkoutDir`, replacing whatever the candidate left there.
   * Symlinks (or directories) at the target path are removed first so we never write
   * through a link a candidate planted.
   */
  materialize(checkoutDir: string, artifacts: readonly AcceptanceArtifact[]): void {
    for (const a of artifacts) {
      const target = safeTarget(checkoutDir, a.relativePath);
      mkdirSync(dirname(target), { recursive: true });
      const st = lstatSafe(target);
      if (st && !st.isFile()) rmSync(target, { recursive: true, force: true });
      else if (st?.isSymbolicLink()) rmSync(target, { force: true });
      writeFileSync(target, this.artifacts.getBytes(a.sha256));
    }
  }

  /**
   * Compare protected paths in a checkout to the stored artifacts. Returns the paths that
   * differ, are missing, or are no longer regular files (directory / symlink swapped in).
   * Used by gates *before* materializing, to detect candidates that touched what they are judged by.
   */
  verify(checkoutDir: string, artifacts: readonly AcceptanceArtifact[]): ProtectedPathProblem[] {
    const problems: ProtectedPathProblem[] = [];
    for (const a of artifacts) {
      const target = safeTarget(checkoutDir, a.relativePath);
      const st = lstatSafe(target);
      if (!st) {
        problems.push({ path: a.relativePath, reason: "missing" });
        continue;
      }
      if (!st.isFile()) {
        problems.push({ path: a.relativePath, reason: "not_a_file" });
        continue;
      }
      if (sha256Hex(readFileSync(target)) !== a.sha256) problems.push({ path: a.relativePath, reason: "modified" });
    }
    return problems;
  }
}

function lstatSafe(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * Resolve `relativePath` inside `root`, refusing lexical escapes (`..`, absolute paths) and
 * symlink escapes: every existing ancestor of the target must realpath-resolve inside root.
 */
export function safeTarget(root: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new PolishError("INVARIANT_VIOLATION", "acceptance artifact path must be a non-empty relative path", { root, relativePath });
  }
  const rootAbs = resolve(root);
  const target = resolve(rootAbs, relativePath);
  const rel = relative(rootAbs, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new PolishError("INVARIANT_VIOLATION", "acceptance artifact path escapes checkout", { root, relativePath });
  }
  // deepest existing ancestor (the target itself may not exist yet)
  let probe = target;
  while (!existsSync(probe) && probe !== rootAbs) probe = dirname(probe);
  const rootReal = realpathSync(rootAbs);
  const probeReal = realpathSync(probe);
  if (probeReal !== rootReal && !probeReal.startsWith(rootReal + sep)) {
    throw new PolishError("INVARIANT_VIOLATION", "acceptance artifact path resolves outside checkout via symlink", {
      root,
      relativePath,
      resolved: probeReal,
    });
  }
  return target;
}
