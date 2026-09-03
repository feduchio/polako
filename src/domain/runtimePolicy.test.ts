import { describe, expect, it } from "vitest";
import { isStaleRuntimeEvidence, runtimeAllowsDone, type RuntimeEvidence } from "./acceptance.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

function evidence(status: RuntimeEvidence["status"], hash: string): RuntimeEvidence {
  return {
    id: "rte_0000000000abcdefghjkmn",
    runId: "run_0000000000abcdefghjkmn",
    scenarioId: "s",
    validator: "fixture-runtime",
    kind: "node_script",
    status,
    summary: status,
    observations: {},
    checkpointHash: hash,
    sideEffects: { policy: "safe", destructiveExternalEffectsAllowed: false },
    artifactHashes: [],
    startedAt: 1,
    finishedAt: 2,
  };
}

describe("runtimeAllowsDone", () => {
  it("off never blocks", () => {
    expect(runtimeAllowsDone("off", null, A)).toBe(true);
    expect(runtimeAllowsDone("off", evidence("failed", A), A)).toBe(true);
  });

  it("auto skips when no evidence but fails on a failed current-checkpoint run", () => {
    expect(runtimeAllowsDone("auto", null, A)).toBe(true);
    expect(runtimeAllowsDone("auto", evidence("skipped", A), A)).toBe(true);
    expect(runtimeAllowsDone("auto", evidence("failed", A), A)).toBe(false);
    expect(runtimeAllowsDone("auto", evidence("passed", A), A)).toBe(true);
  });

  it("auto does not treat stale skip/unavailable evidence as a final skip", () => {
    expect(runtimeAllowsDone("auto", evidence("skipped", A), B)).toBe(false);
    expect(runtimeAllowsDone("auto", evidence("unavailable", A), B)).toBe(false);
    expect(runtimeAllowsDone("auto", evidence("passed", A), B)).toBe(false);
  });

  it("required demands passed evidence of the final checkpoint", () => {
    expect(runtimeAllowsDone("required", null, A)).toBe(false);
    expect(runtimeAllowsDone("required", evidence("passed", A), B)).toBe(false);
    expect(runtimeAllowsDone("required", evidence("failed", B), B)).toBe(false);
    expect(runtimeAllowsDone("required", evidence("passed", B), B)).toBe(true);
  });

  it("stale means checkpoint mismatch", () => {
    expect(isStaleRuntimeEvidence(evidence("passed", A), B)).toBe(true);
    expect(isStaleRuntimeEvidence(evidence("passed", A), A)).toBe(false);
  });
});
