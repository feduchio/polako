import { describe, expect, it } from "vitest";
import type { Finding, FindingValidation } from "../domain/finding.js";
import { describeDispositions, tallyDispositions } from "./dispositions.js";

function finding(id: string, status: Finding["status"], extra: Partial<Finding> = {}): Finding {
  return { id, status, blocking: true, ...extra } as Finding;
}

describe("tallyDispositions", () => {
  it("counts each finding by what decided it", () => {
    const validation = (outcome: FindingValidation["outcome"], reason: FindingValidation["reason"] = null) => ({ outcome, reason }) as FindingValidation;
    const tally = tallyDispositions({
      findings: [
        finding("a", "VALID"),
        finding("b", "REJECTED"),
        finding("c", "REJECTED"),
        finding("d", "UNCERTAIN"),
        finding("e", "NOTED", { evidenceMismatch: "evidence_mismatch: x:1 does not contain the quoted text" }),
        finding("f", "NOTED"),
        finding("g", "DUPLICATE"),
        finding("h", "RAW"),
      ],
      latestValidation: new Map([["b", validation("refuted")], ["c", validation("not_examined", "debate_dismissed")]]),
      investigationReason: new Map([["d", "killed"]]),
    });
    expect(tally).toEqual({
      total: 8, demonstrated: 1, refuted: 1, dismissed: 1, notExamined: { killed: 1, citation_unverifiable: 1 }, duplicate: 1, noted: 1, open: 1,
    });
    expect(describeDispositions(tally)).toBe(
      "8 findings: 1 demonstrated, 1 refuted, 1 dismissed, 2 not examined (citation_unverifiable 1, killed 1), 1 duplicate, 1 noted, 1 open",
    );
  });

  it("counts a rejection nothing executed as not examined, not as refuted or dismissed", () => {
    const tally = tallyDispositions({ findings: [finding("a", "REJECTED")], latestValidation: new Map(), investigationReason: new Map() });
    expect(tally).toMatchObject({ refuted: 0, dismissed: 0, notExamined: { rejected_without_execution: 1 } });
  });
});
