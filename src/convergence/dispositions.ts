import type { DispositionTally } from "../domain/convergence.js";
import type { Finding, FindingValidation } from "../domain/finding.js";

export type { DispositionTally };

export interface DispositionInput {
  findings: readonly Finding[];
  /** Latest validation per finding id, if any. */
  latestValidation: ReadonlyMap<string, FindingValidation>;
  /** Latest not-examined reason an investigation recorded per finding id. */
  investigationReason: ReadonlyMap<string, string>;
}

/**
 * What became of each finding, by what decided it. A round whose findings were never examined
 * reads differently from a round with none, and a DONE says which it rests on.
 */
export function tallyDispositions(input: DispositionInput): DispositionTally {
  const tally: DispositionTally = { total: 0, demonstrated: 0, refuted: 0, dismissed: 0, notExamined: {}, duplicate: 0, noted: 0, open: 0 };
  for (const finding of input.findings) {
    tally.total += 1;
    const validation = input.latestValidation.get(finding.id);
    switch (finding.status) {
      case "DUPLICATE":
        tally.duplicate += 1;
        break;
      case "NOTED":
        tally.noted += 1;
        break;
      case "VALID":
      case "RESOLVED":
        tally.demonstrated += 1;
        break;
      case "REJECTED":
        if (validation?.outcome === "refuted") tally.refuted += 1;
        else if (validation?.reason === "debate_dismissed") tally.dismissed += 1;
        else countNotExamined(tally, "rejected_without_execution");
        break;
      case "UNCERTAIN":
        countNotExamined(tally, input.investigationReason.get(finding.id) ?? validation?.reason ?? "no_executable_reproduction");
        break;
      case "RAW":
      case "VALIDATING":
        tally.open += 1;
    }
  }
  return tally;
}

function countNotExamined(tally: DispositionTally, reason: string): void {
  tally.notExamined[reason] = (tally.notExamined[reason] ?? 0) + 1;
}

export function notExaminedCount(tally: DispositionTally): number {
  return Object.values(tally.notExamined).reduce((sum, count) => sum + count, 0);
}

/** "8 findings: 0 demonstrated, 1 refuted, 2 dismissed, 5 not examined (environment 4, killed 1), …" */
export function describeDispositions(tally: DispositionTally): string {
  const reasons = Object.entries(tally.notExamined)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([reason, count]) => `${reason} ${String(count)}`);
  const notExamined = notExaminedCount(tally);
  return [
    `${String(tally.total)} finding${tally.total === 1 ? "" : "s"}: ${String(tally.demonstrated)} demonstrated`,
    `${String(tally.refuted)} refuted`,
    `${String(tally.dismissed)} dismissed`,
    `${String(notExamined)} not examined${reasons.length === 0 ? "" : ` (${reasons.join(", ")})`}`,
    `${String(tally.duplicate)} duplicate`,
    `${String(tally.noted)} noted`,
    ...(tally.open === 0 ? [] : [`${String(tally.open)} open`]),
  ].join(", ");
}
