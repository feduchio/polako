import type { Finding } from "../domain/finding.js";
import { fingerprintFinding } from "./fingerprint.js";

export type FindingTriage =
  | { disposition: "validate"; fingerprint: string }
  | { disposition: "noise"; fingerprint: string; reason: string }
  | { disposition: "duplicate"; fingerprint: string; duplicateOf: string };

/**
 * RAW findings need an inspectable location, reproduction, or proposed deterministic check.
 * Unsupported opinions remain useful notes, but must not consume evidence-agent capacity.
 */
export function triageFinding(finding: Finding, existing: readonly Finding[]): FindingTriage {
  const fingerprint = fingerprintFinding(finding);
  const duplicate = existing.find(
    (candidate) =>
      candidate.id !== finding.id &&
      candidate.runId === finding.runId &&
      candidate.status !== "RAW" &&
      candidate.status !== "DUPLICATE" &&
      (candidate.fingerprint === fingerprint || fingerprintFinding(candidate) === fingerprint),
  );
  if (duplicate !== undefined) {
    return { disposition: "duplicate", fingerprint, duplicateOf: duplicate.id };
  }

  if (finding.evidence.length === 0 && finding.reproduction.length === 0 && finding.suggestedCheck === undefined) {
    return {
      disposition: "noise",
      fingerprint,
      reason: "finding has no inspectable evidence, reproduction, or suggested check",
    };
  }
  return { disposition: "validate", fingerprint };
}
