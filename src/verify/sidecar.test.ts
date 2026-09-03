import { describe, expect, it } from "vitest";
import type { CandidateMetrics } from "./metrics.js";
import { decomposeCriteria, VerifierAdapter } from "./sidecar.js";
import type { TournamentCandidate } from "./strategy.js";

function candidate(id: string, linesChanged: number): TournamentCandidate {
  const metrics: CandidateMetrics = {
    candidateId: id,
    filesChanged: 1,
    linesChanged,
    insertions: linesChanged,
    deletions: 0,
    checksPassed: 2,
    checksTotal: 2,
    newFailures: 0,
    newFailureKeys: [],
  };
  return { id, metrics };
}

describe("VerifierAdapter", () => {
  it("falls back to TypeScript pairwise scoring when the sidecar is down", async () => {
    const adapter = new VerifierAdapter({
      command: "__polish_missing_python__",
      requestTimeoutMs: 100,
    });
    try {
      await expect(
        adapter.comparePair(candidate("a", 2), candidate("b", 20), { runId: "run_fallback" }),
      ).resolves.toMatchObject({ winner: "a" });
    } finally {
      adapter.close();
    }
  });

  it("decomposes criteria and supplies safe defaults", () => {
    expect(decomposeCriteria("Pass tests.\nAvoid regressions; keep scope small")).toEqual([
      "Pass tests",
      "Avoid regressions",
      "keep scope small",
    ]);
    expect(decomposeCriteria(undefined)).toEqual(["correctness", "regression safety", "simplicity"]);
  });
});
