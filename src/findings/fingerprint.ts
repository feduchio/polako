import type { RawFinding } from "../domain/finding.js";
import { findingFingerprint } from "../domain/finding.js";

/**
 * Canonical B5 entry point for finding identity. The domain helper deliberately ignores
 * line numbers and evidence ordering, making the result stable across reviewer formatting.
 */
export function fingerprintFinding(raw: Pick<RawFinding, "criterion" | "claim" | "evidence">): string {
  return findingFingerprint({
    criterion: raw.criterion.trim(),
    claim: raw.claim.trim().replace(/\s+/g, " "),
    evidence: raw.evidence.map((ref) => ({ path: ref.path.replaceAll("\\", "/").replace(/^\.\//, "") })),
  });
}
