import { describe, expect, it, vi } from "vitest";
import { emptyFindingCounts, type Checkpoint, type EvidenceVector } from "../domain/checkpoint.js";
import type { CleanRound } from "../domain/convergence.js";
import type { ReviewExecution } from "../domain/review.js";
import { createTaskFromRequirement } from "../domain/task.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import {
  assertCodeChangeMissionMayComplete,
  missionRequiresCodeChange,
  type MissionCompletionEvidence,
} from "./antiFakeDone.js";
import { ConvergenceController } from "./controller.js";
import { rollbackIfDominated, rollbackTarget } from "./dominance.js";
import {
  buildCleanRoundFromReview,
  recordCleanRoundEvent,
} from "./record.js";
import { createRollbackCheckpoint } from "./rollback.js";
import { CleanRoundTracker, preferRotatedEnsemble } from "./tracker.js";

const NOW = 1_700_000_000_000;
const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
const RUN_ID = id("run", NOW);

function tracker(hash = HASH_A): CleanRoundTracker {
  return new CleanRoundTracker(RUN_ID, hash, new FakeClock(NOW));
}

function record(subject: CleanRoundTracker, hash: string, model = "m1"): CleanRound {
  return subject.record({
    checkpointHash: hash,
    axes: ["correctness"],
    ensemble: [{ provider: "p", model }],
    rawFindings: 0,
  });
}

function evidence(overrides: Partial<EvidenceVector> = {}): EvidenceVector {
  return {
    gates: { test: "pass", lint: "pass" },
    testsPassed: 10,
    testsFailed: 0,
    testsTotal: 10,
    openValidatedFindings: emptyFindingCounts(),
    diffLinesFromBaseline: 10,
    ...overrides,
  };
}

function checkpoint(seq: number, hash: string, vector = evidence()): Checkpoint {
  return {
    id: id("cp", NOW + seq),
    runId: RUN_ID,
    seq,
    commitHash: hash,
    parentId: seq === 0 ? null : id("cp", NOW + seq - 1),
    source: seq === 0 ? "baseline" : "integration",
    taskId: null,
    evidence: vector,
    createdAt: NOW + seq,
  };
}

function reviewExecution(
  hash: string,
  roundIndex: number,
  axis: ReviewExecution["axis"],
  model: string,
  findingsCount = 0,
): ReviewExecution {
  return {
    id: id("rvex", NOW + roundIndex),
    runId: RUN_ID,
    checkpointHash: hash,
    roundIndex,
    axis,
    requestedModel: { provider: "p", model },
    completed: true,
    findings: Array.from({ length: findingsCount }, () => ({
      criterion: "c",
      severity: "low" as const,
      blocking: false,
      claim: "claim",
      evidence: [],
      reproduction: [],
      suggestedCheck: undefined,
    })),
    startedAt: NOW,
    finishedAt: NOW,
  };
}

function baseEvidence(overrides: Partial<MissionCompletionEvidence> = {}): MissionCompletionEvidence {
  const baseline = HASH_A;
  const integrated = HASH_B;
  const interpretationId = id("interp", NOW);
  const task = createTaskFromRequirement(interpretationId, "R1", {
    id: id("task", NOW),
    runId: RUN_ID,
    title: "fix",
    description: "d",
    kind: "bugfix",
    acceptance: ["done"],
    complexity: "normal",
    baseCheckpointHash: baseline,
    now: NOW,
  });
  return {
    tasks: [task],
    candidates: [
      {
        id: id("cand", NOW),
        runId: RUN_ID,
        taskId: task.id,
        attempt: 1,
        model: { provider: "p", model: "m" },
        baseCheckpointHash: baseline,
        branch: "cand/1",
        worktreePath: "/tmp/wt",
        headCommit: integrated,
        state: "PASSED_GATES",
        gateReport: {
          gatedCommit: integrated,
          checks: [],
          injectedAcceptance: [],
          failures: [],
          passed: true,
          diffStat: { files: 1, insertions: 1, deletions: 0 },
          createdAt: NOW,
        },
        transcriptRef: null,
        diffRef: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    checkpoints: [checkpoint(0, baseline), checkpoint(1, integrated)],
    reviewExecutions: [
      reviewExecution(integrated, 1, "correctness", "m1"),
      reviewExecution(integrated, 1, "regression", "m2"),
      reviewExecution(integrated, 1, "adversarial", "m3"),
    ],
    cleanRounds: [],
    baselineCommitHash: baseline,
    currentCheckpointHash: integrated,
    requiredReviewers: 3,
    ...overrides,
  };
}

describe("CleanRoundTracker", () => {
  it("accumulates clean rounds and enforces required_clean_rounds", () => {
    const subject = tracker();
    record(subject, HASH_A);
    record(subject, HASH_A, "m2");
    expect(subject.currentRounds().map((round) => round.roundIndex)).toEqual([1, 2]);
    expect(subject.hasRequired(2)).toBe(true);
    expect(subject.hasRequired(3)).toBe(false);
  });

  it("invalidates prior counts on checkpoint change while retaining history", () => {
    const subject = tracker();
    record(subject, HASH_A);
    record(subject, HASH_A, "m2");
    subject.setCheckpoint(HASH_B);
    expect(subject.currentRounds()).toHaveLength(0);
    expect(subject.hasRequired(1)).toBe(false);
    const next = record(subject, HASH_B);
    expect(next.roundIndex).toBe(1);
    expect(subject.allRounds()).toHaveLength(3);
    expect(() => record(subject, HASH_A)).toThrow(/stale checkpoint/);
  });

  it("uses rotation only to break quality ties", () => {
    const subject = tracker();
    record(subject, HASH_A, "m1");
    const previous = subject.currentRounds();
    expect(
      preferRotatedEnsemble(
        [
          { ensemble: [{ provider: "p", model: "m1" }], quality: 0.9 },
          { ensemble: [{ provider: "p", model: "m2" }], quality: 0.8 },
        ],
        previous,
        HASH_A,
        ["correctness"],
        0.6,
      ),
    ).toEqual([{ provider: "p", model: "m1" }]);
    expect(
      preferRotatedEnsemble(
        [
          { ensemble: [{ provider: "p", model: "m1" }], quality: 0.9 },
          { ensemble: [{ provider: "p", model: "m2" }], quality: 0.9 },
        ],
        previous,
        HASH_A,
        ["correctness"],
        0.6,
      ),
    ).toEqual([{ provider: "p", model: "m2" }]);
  });
});

describe("clean round proof-of-review", () => {
  it("rejects recording without review executions", () => {
    expect(() =>
      buildCleanRoundFromReview({
        runId: RUN_ID,
        checkpointHash: HASH_B,
        requiredReviewers: 3,
        reviewExecutions: [],
        findings: [],
        existingCleanRounds: [],
        now: NOW,
      }),
    ).toThrow(/without completed review executions/);
  });

  it("rejects review executions for a different checkpoint hash", () => {
    expect(() =>
      buildCleanRoundFromReview({
        runId: RUN_ID,
        checkpointHash: HASH_B,
        requiredReviewers: 1,
        reviewExecutions: [reviewExecution(HASH_A, 1, "correctness", "m1")],
        findings: [],
        existingCleanRounds: [],
        now: NOW,
      }),
    ).toThrow(/without completed review executions/);
  });

  it("rejects when required reviewers are incomplete", () => {
    const incomplete = reviewExecution(HASH_B, 1, "adversarial", "m3");
    expect(() =>
      buildCleanRoundFromReview({
        runId: RUN_ID,
        checkpointHash: HASH_B,
        requiredReviewers: 3,
        reviewExecutions: [
          reviewExecution(HASH_B, 1, "correctness", "m1"),
          reviewExecution(HASH_B, 1, "regression", "m2"),
          { ...incomplete, completed: false, finishedAt: null },
        ],
        findings: [],
        existingCleanRounds: [],
        reviewRoundIndex: 1,
        now: NOW,
      }),
    ).toThrow(/incomplete/);
  });

  it("rejects when validated blocking findings remain", () => {
    expect(() =>
      buildCleanRoundFromReview({
        runId: RUN_ID,
        checkpointHash: HASH_B,
        requiredReviewers: 3,
        reviewExecutions: [
          reviewExecution(HASH_B, 1, "correctness", "m1"),
          reviewExecution(HASH_B, 1, "regression", "m2"),
          reviewExecution(HASH_B, 1, "adversarial", "m3"),
        ],
        findings: [
          {
            id: id("find", NOW),
            runId: RUN_ID,
            checkpointHash: HASH_B,
            axis: "correctness",
            criterion: "c",
            severity: "high",
            blocking: true,
            claim: "bug",
            evidence: [],
            reproduction: [],
            suggestedCheck: undefined,
            status: "VALID",
            fingerprint: "fp",
            duplicateOf: null,
            investigationRounds: 0,
            reportedBy: { kind: "reviewer" },
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        existingCleanRounds: [],
        now: NOW,
      }),
    ).toThrow(/blocking findings remain/);
  });

  it("records a clean round event when proof is valid", () => {
    const event = recordCleanRoundEvent({
      runId: RUN_ID,
      checkpointHash: HASH_B,
      requiredReviewers: 3,
      reviewExecutions: [
        reviewExecution(HASH_B, 1, "correctness", "m1"),
        reviewExecution(HASH_B, 1, "regression", "m2"),
        reviewExecution(HASH_B, 1, "adversarial", "m3"),
      ],
      findings: [],
      existingCleanRounds: [],
      now: NOW,
    });
    expect(event.type).toBe("clean_round.recorded");
    expect((event.payload as { cleanRound: CleanRound }).cleanRound.validatedBlocking).toBe(0);
  });
});

describe("anti-fake-DONE", () => {
  it("allows review-only missions without code evidence", () => {
    const investigation = createTaskFromRequirement(id("interp", NOW), "R1", {
      id: id("task", NOW + 1),
      runId: RUN_ID,
      title: "investigate",
      description: "d",
      kind: "bugfix",
      acceptance: ["done"],
      complexity: "normal",
      baseCheckpointHash: HASH_A,
      now: NOW,
    });
    const result = assertCodeChangeMissionMayComplete({
      ...baseEvidence(),
      tasks: [{ ...investigation, kind: "investigation", touchesProductCode: false, origin: { kind: "investigation", findingId: id("find", NOW), round: 1 } }],
      candidates: [],
      checkpoints: [],
      reviewExecutions: [],
      cleanRounds: [],
    });
    expect(result.ok).toBe(true);
    expect(missionRequiresCodeChange(baseEvidence().tasks)).toBe(true);
  });

  it("rejects change-required missions with empty diff (checkpoint equals baseline)", () => {
    const result = assertCodeChangeMissionMayComplete({
      ...baseEvidence(),
      currentCheckpointHash: HASH_A,
      checkpoints: [checkpoint(0, HASH_A), checkpoint(1, HASH_A)],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/baseline/);
  });

  it("rejects change-required missions with zero workers, candidates, gates, and reviews", () => {
    const empty = assertCodeChangeMissionMayComplete({
      ...baseEvidence(),
      candidates: [],
      checkpoints: [checkpoint(0, HASH_A), checkpoint(1, HASH_B)],
      reviewExecutions: [],
      cleanRounds: [],
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(resultReasons(empty)).toContain("worker");
  });
});

function resultReasons(result: { ok: false; reason: string }): string {
  return result.reason;
}

describe("dominance and ConvergenceController", () => {
  it("selects and applies the latest dominating prior checkpoint", async () => {
    const strongest = checkpoint(1, HASH_A);
    const older = checkpoint(0, "c".repeat(40));
    const current = checkpoint(
      2,
      HASH_B,
      evidence({ gates: { test: "fail", lint: "pass" }, testsPassed: 9, testsFailed: 1 }),
    );
    expect(rollbackTarget(current, [older, strongest])).toBe(strongest);
    const apply = vi.fn();
    expect(await rollbackIfDominated(current, [older, strongest], apply)).toBe(strongest);
    expect(apply).toHaveBeenCalledWith(strongest);
  });

  it("returns DONE only at required_clean_rounds for the current hash", () => {
    const current = checkpoint(1, HASH_A);
    const subject = new ConvergenceController();
    const rounds = tracker();
    record(rounds, HASH_A);
    const state = {
      current,
      priorCheckpoints: [],
      cleanRounds: rounds.allRounds(),
      requiredCleanRounds: 2,
      openBlockingFindings: 0,
      investigationExhausted: false,
      consecutiveNoProgress: 0,
      simplifyAfterNoProgress: 3,
    };
    expect(subject.decide(state).action).toBe("CONTINUE_REVIEW");
    record(rounds, HASH_A, "m2");
    expect(subject.decide({ ...state, cleanRounds: rounds.allRounds() }).action).toBe("DONE");
    expect(subject.decide({ ...state, cleanRounds: rounds.allRounds(), openBlockingFindings: 1 }).action).toBe(
      "CONTINUE_REVIEW",
    );
  });

  it("creates a rollback checkpoint on the integration lane without touching the user tree", async () => {
    const strongest = checkpoint(1, HASH_A);
    const current = checkpoint(2, HASH_B, evidence({ gates: { test: "fail", lint: "pass" }, testsPassed: 8, testsFailed: 2 }));
    const runHead = {
      read: vi.fn(async () => HASH_B),
      compareAndSet: vi.fn(async () => true),
    };
    const run = {
      id: RUN_ID,
      missionId: id("msn", NOW),
      projectPath: "/tmp/project",
      runBranch: "polish/run",
      phase: "CONVERGENCE_CHECK" as const,
      control: "RUNNING" as const,
      currentCheckpointHash: HASH_B,
      baselineId: null,
      interpretationId: null,
      createdAt: NOW,
      updatedAt: NOW,
      terminalReason: null,
    };
    const result = await createRollbackCheckpoint({
      run,
      current,
      target: strongest,
      runHead,
      now: NOW,
    });
    expect(result.advanced).toBe(true);
    expect(result.checkpoint?.source).toBe("rollback");
    expect(result.checkpoint?.commitHash).toBe(HASH_A);
    expect(runHead.compareAndSet).toHaveBeenCalledWith(HASH_B, HASH_A);
    expect(result.events.some((event) => event.type === "checkpoint.created")).toBe(true);
  });

  it("does not record a rollback checkpoint when run-head CAS fails", async () => {
    const strongest = checkpoint(1, HASH_A);
    const current = checkpoint(2, HASH_B, evidence({ gates: { test: "fail", lint: "pass" }, testsPassed: 8, testsFailed: 2 }));
    const runHead = {
      read: vi.fn(async () => HASH_B),
      compareAndSet: vi.fn(async () => false),
    };
    const run = {
      id: RUN_ID,
      missionId: id("msn", NOW),
      projectPath: "/tmp/project",
      runBranch: "polish/run",
      phase: "CONVERGENCE_CHECK" as const,
      control: "RUNNING" as const,
      currentCheckpointHash: HASH_B,
      baselineId: null,
      interpretationId: null,
      createdAt: NOW,
      updatedAt: NOW,
      terminalReason: null,
    };
    const result = await createRollbackCheckpoint({
      run,
      current,
      target: strongest,
      runHead,
      now: NOW,
    });
    expect(result.advanced).toBe(false);
    expect(result.checkpoint).toBeNull();
    expect(result.events).toEqual([]);
  });
});
