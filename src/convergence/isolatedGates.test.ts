import { describe, expect, it } from "vitest";
import { emptyFindingCounts, type Checkpoint } from "../domain/checkpoint.js";
import type { ReviewExecution } from "../domain/review.js";
import { assertCodeChangeMissionMayComplete, assertDeterministicGatesPassed, checkpointReviewIndependence, type MissionCompletionEvidence } from "./antiFakeDone.js";

const HASH = "c".repeat(40);

function checkpoint(overrides: Partial<Checkpoint["evidence"]>): Checkpoint {
  return {
    id: "cp_1",
    runId: "run_1",
    seq: 1,
    commitHash: HASH,
    parentId: null,
    source: "integration",
    taskId: null,
    evidence: { gates: { test: "pass" }, testsPassed: 1, testsFailed: 0, testsTotal: 1, openValidatedFindings: emptyFindingCounts(), diffLinesFromBaseline: 1, ...overrides },
    createdAt: 1,
  };
}

function evidence(cp: Checkpoint, reviewIndependence: MissionCompletionEvidence["reviewIndependence"]): MissionCompletionEvidence {
  return {
    tasks: [],
    candidates: [],
    checkpoints: [cp],
    reviewExecutions: [],
    cleanRounds: [],
    baselineCommitHash: null,
    currentCheckpointHash: HASH,
    requiredReviewers: 2,
    ...(reviewIndependence === undefined ? {} : { reviewIndependence }),
  };
}

describe("deterministic gates for same-model-isolated review", () => {
  it("does not apply to lineage reviews", () => {
    expect(assertDeterministicGatesPassed(evidence(checkpoint({ gates: {} }), "lineage"))).toEqual({ ok: true });
    expect(assertDeterministicGatesPassed(evidence(checkpoint({ gates: {} }), undefined))).toEqual({ ok: true });
  });

  it("passes when a gate passed and nothing failed", () => {
    expect(assertDeterministicGatesPassed(evidence(checkpoint({ gates: { test: "pass", lint: "skipped" } }), "same-model-isolated"))).toEqual({ ok: true });
  });

  it.each<[string, Partial<Checkpoint["evidence"]>, RegExp]>([
    ["no gate at all (model verdicts alone)", { gates: {} }, /model verdicts alone/],
    ["only skipped gates", { gates: { test: "skipped" } }, /model verdicts alone/],
    ["a failing gate", { gates: { test: "pass", build: "fail" } }, /failing: build/],
    ["a timed-out gate", { gates: { test: "timeout" } }, /failing: test/],
    ["failing tests", { testsFailed: 2 }, /tests are failing/],
  ])("refuses %s", (_name, override, reason) => {
    const result = assertDeterministicGatesPassed(evidence(checkpoint(override), "same-model-isolated"));
    expect(result).toMatchObject({ ok: false, terminal: "NEEDS_HUMAN" });
    expect(result.ok ? "" : result.reason).toMatch(reason);
  });

  it("is enforced by the anti-fake-DONE gate, even for a mission with no coding task", () => {
    const result = assertCodeChangeMissionMayComplete(evidence(checkpoint({ gates: {} }), "same-model-isolated"));
    expect(result).toMatchObject({ ok: false, terminal: "NEEDS_HUMAN" });
  });

  it("derives independence from the executions of the checkpoint", () => {
    const execution = (hash: string, independence?: ReviewExecution["independence"]): ReviewExecution => ({
      id: "rvex_1", runId: "run_1", checkpointHash: hash, roundIndex: 1, axis: "correctness",
      requestedModel: { provider: "p", model: "m" }, completed: true, findings: [], startedAt: 1, finishedAt: 2,
      ...(independence === undefined ? {} : { independence }),
    });
    expect(checkpointReviewIndependence([execution(HASH), execution(HASH, "same-model-isolated")], HASH)).toBe("same-model-isolated");
    expect(checkpointReviewIndependence([execution("d".repeat(40), "same-model-isolated"), execution(HASH)], HASH)).toBe("lineage");
    expect(checkpointReviewIndependence([], HASH)).toBe("lineage");
  });
});
