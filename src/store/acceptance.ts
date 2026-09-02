import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { AcceptanceArtifact } from "../domain/acceptance.js";
import { sha256Hex } from "../shared/hash.js";
import { PolishError } from "../shared/errors.js";
import type { ArtifactStore } from "./artifacts.js";

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

  /** Copy every artifact into `checkoutDir`, overwriting whatever the candidate left there. */
  materialize(checkoutDir: string, artifacts: readonly AcceptanceArtifact[]): void {
    for (const a of artifacts) {
      const target = safeJoin(checkoutDir, a.relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, this.artifacts.getBytes(a.sha256));
    }
  }

  /**
   * Compare protected paths in a checkout to the stored artifacts. Returns the paths that
   * differ or are missing. Used by gates *before* materializing, to detect candidates that
   * touched what they are judged by.
   */
  verify(checkoutDir: string, artifacts: readonly AcceptanceArtifact[]): { path: string; reason: "missing" | "modified" }[] {
    const problems: { path: string; reason: "missing" | "modified" }[] = [];
    for (const a of artifacts) {
      const target = safeJoin(checkoutDir, a.relativePath);
      if (!existsSync(target)) {
        problems.push({ path: a.relativePath, reason: "missing" });
        continue;
      }
      if (sha256Hex(readFileSync(target)) !== a.sha256) problems.push({ path: a.relativePath, reason: "modified" });
    }
    return problems;
  }
}

function safeJoin(root: string, relativePath: string): string {
  const abs = resolve(root, relativePath);
  const rootAbs = resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
    throw new PolishError("INVARIANT_VIOLATION", "acceptance artifact path escapes checkout", { root, relativePath });
  }
  return join(abs);
}
