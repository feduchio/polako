import { describe, expect, it, vi } from "vitest";
import { emptyFindingCounts, type Checkpoint, type EvidenceVector } from "../domain/checkpoint.js";
import { CleanRoundSchema, type CleanRound } from "../domain/convergence.js";
import type { ReviewExecution } from "../domain/review.js";
import { createTaskFromRequirement } from "../domain/task.js";
import { id } from "../shared/ids.js";
import {
  assertCodeChangeMissionMayComplete,
  missionRequiresCodeChange,
  missionSatisfiedWithoutChange,
  type MissionCompletionEvidence,
} from "./antiFakeDone.js";
import { ConvergenceController } from "./controller.js";
import { rollbackIfDominated, rollbackTarget } from "./dominance.js";
import {
  buildCleanRoundFromReview,
  cleanRoundsHaveReviewProof,
  nextUnconsumedCompletedReviewRound,
  recordCleanRoundEvent,
} from "./record.js";
import { createRollbackCheckpoint } from "./rollback.js";
const NOW = 1_700_000_000_000;
const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
const RUN_ID = id("run", NOW);

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
  const axisOffset = axis === "correctness" ? 0 : axis === "regression" ? 1 : 2;
  return {
    id: id("rvex", NOW + roundIndex * 8 + axisOffset),
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
    tasks: [{ ...task, state: "INTEGRATED" }],
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
        error: null,
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

  it("records a clean round when rate-limit failures share the completed review round", () => {
    const failed = {
      ...reviewExecution(HASH_B, 1, "correctness", "gemma-free"),
      id: id("rvex", NOW + 99),
      completed: false,
      finishedAt: null,
    };
    const cleanRound = buildCleanRoundFromReview({
      runId: RUN_ID,
      checkpointHash: HASH_B,
      requiredReviewers: 3,
      reviewExecutions: [
        failed,
        reviewExecution(HASH_B, 1, "correctness", "m1"),
        reviewExecution(HASH_B, 1, "regression", "m2"),
        reviewExecution(HASH_B, 1, "adversarial", "m3"),
      ],
      findings: [],
      existingCleanRounds: [],
      now: NOW,
    });
    expect(cleanRound.ensemble.map((entry) => entry.model)).toEqual(["m1", "m2", "m3"]);
    expect(cleanRound.rawFindings).toBe(0);
    expect(cleanRound.reviewRoundIndex).toBe(1);
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
    expect((event.payload as { cleanRound: CleanRound }).cleanRound.reviewRoundIndex).toBe(1);
  });

  function completeRound(hash: string, roundIndex: number, models: readonly [string, string, string] = ["m1", "m2", "m3"]): ReviewExecution[] {
    return [
      reviewExecution(hash, roundIndex, "correctness", models[0]),
      reviewExecution(hash, roundIndex, "regression", models[1]),
      reviewExecution(hash, roundIndex, "adversarial", models[2]),
    ];
  }

  function historicalCleanRound(roundIndex: number, reviewRoundIndex?: number): CleanRound {
    return {
      id: id("cr", NOW + roundIndex),
      runId: RUN_ID,
      checkpointHash: HASH_B,
      roundIndex,
      ...(reviewRoundIndex === undefined ? {} : { reviewRoundIndex }),
      axes: ["correctness", "regression", "adversarial"],
      ensemble: [
        { provider: "p", model: "m1" },
        { provider: "p", model: "m2" },
        { provider: "p", model: "m3" },
      ],
      rawFindings: 0,
      validatedBlocking: 0,
      novel: true,
      createdAt: NOW + roundIndex,
    };
  }

  it("A: three clean rounds plus one completed review round are not proof", () => {
    const executions = completeRound(HASH_B, 1);
    const lackingProvenance = [historicalCleanRound(1), historicalCleanRound(2), historicalCleanRound(3)];
    expect(cleanRoundsHaveReviewProof(lackingProvenance, HASH_B, executions, 3)).toBe(false);
    const allBoundToLatest = [1, 2, 3].map((roundIndex) => historicalCleanRound(roundIndex, 1));
    expect(cleanRoundsHaveReviewProof(allBoundToLatest, HASH_B, executions, 3)).toBe(false);
    const claimedDistinctRounds = [1, 2, 3].map((roundIndex) => historicalCleanRound(roundIndex, roundIndex));
    expect(cleanRoundsHaveReviewProof(claimedDistinctRounds, HASH_B, executions, 3)).toBe(false);
  });

  it("B: a failure-only later review round does not consume another clean round", () => {
    const failedOnly = {
      ...reviewExecution(HASH_B, 2, "correctness", "gemma-free"),
      id: id("rvex", NOW + 50),
      completed: false,
      finishedAt: null,
    };
    const executions = [...completeRound(HASH_B, 1), failedOnly];
    const existing = [buildCleanRoundFromReview({
      runId: RUN_ID,
      checkpointHash: HASH_B,
      requiredReviewers: 3,
      reviewExecutions: executions,
      findings: [],
      existingCleanRounds: [],
      reviewRoundIndex: 1,
      now: NOW,
    })];
    expect(nextUnconsumedCompletedReviewRound(existing, executions, HASH_B, 3)).toBeNull();
    expect(() =>
      buildCleanRoundFromReview({
        runId: RUN_ID,
        checkpointHash: HASH_B,
        requiredReviewers: 3,
        reviewExecutions: executions,
        findings: [],
        existingCleanRounds: existing,
        reviewRoundIndex: 2,
        now: NOW + 1,
      }),
    ).toThrow(/incomplete|without completed review executions/);
  });

  it("C: three distinct completed review rounds prove exactly three bound clean rounds", () => {
    const executions = [
      ...completeRound(HASH_B, 1),
      ...completeRound(HASH_B, 2, ["n1", "n2", "n3"]),
      ...completeRound(HASH_B, 3, ["p1", "p2", "p3"]),
    ];
    const recorded: CleanRound[] = [];
    for (const reviewRoundIndex of [1, 2, 3]) {
      recorded.push(
        buildCleanRoundFromReview({
          runId: RUN_ID,
          checkpointHash: HASH_B,
          requiredReviewers: 3,
          reviewExecutions: executions,
          findings: [],
          existingCleanRounds: recorded,
          reviewRoundIndex,
          now: NOW + reviewRoundIndex,
        }),
      );
    }
    expect(recorded.map((round) => round.reviewRoundIndex)).toEqual([1, 2, 3]);
    expect(recorded.map((round) => round.roundIndex)).toEqual([1, 2, 3]);
    expect(cleanRoundsHaveReviewProof(recorded, HASH_B, executions, 3)).toBe(true);
  });

  it("D: a clean round bound to a stale checkpoint review round is not proof", () => {
    const onA = completeRound(HASH_A, 1);
    const onB = completeRound(HASH_B, 1);
    const cleanRound = historicalCleanRound(1, 1);
    expect(cleanRoundsHaveReviewProof([cleanRound], HASH_B, onA, 3)).toBe(false);
    expect(cleanRoundsHaveReviewProof([cleanRound], HASH_B, [...onA, ...completeRound(HASH_B, 2)], 3)).toBe(false);
    expect(
      cleanRoundsHaveReviewProof(
        [{ ...cleanRound, ensemble: [{ provider: "p", model: "stale" }, { provider: "p", model: "wrong" }, { provider: "p", model: "models" }] }],
        HASH_B,
        onB,
        3,
      ),
    ).toBe(false);
  });

  it("rejects recording a second clean round against an already consumed review round", () => {
    const executions = completeRound(HASH_B, 1);
    const first = buildCleanRoundFromReview({
      runId: RUN_ID,
      checkpointHash: HASH_B,
      requiredReviewers: 3,
      reviewExecutions: executions,
      findings: [],
      existingCleanRounds: [],
      reviewRoundIndex: 1,
      now: NOW,
    });
    expect(() =>
      buildCleanRoundFromReview({
        runId: RUN_ID,
        checkpointHash: HASH_B,
        requiredReviewers: 3,
        reviewExecutions: executions,
        findings: [],
        existingCleanRounds: [first],
        reviewRoundIndex: 1,
        now: NOW + 1,
      }),
    ).toThrow(/already proves a clean round/);
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

  it("allows ending on the baseline only when every coding task is SATISFIED with gates on its base", () => {
    const evidence = baseEvidence();
    const task = { ...evidence.tasks[0]!, state: "SATISFIED" as const };
    const candidate = evidence.candidates[0]!;
    const proof = {
      ...candidate,
      headCommit: HASH_A,
      state: "DISCARDED" as const,
      error: "no_change_verified: already holds",
      gateReport: { ...candidate.gateReport!, gatedCommit: HASH_A, diffStat: { files: 0, insertions: 0, deletions: 0 } },
    };
    const reviewExecutions = [
      reviewExecution(HASH_A, 1, "correctness", "m1"),
      reviewExecution(HASH_A, 1, "regression", "m2"),
      reviewExecution(HASH_A, 1, "adversarial", "m3"),
    ];
    const cleanRound = buildCleanRoundFromReview({
      runId: RUN_ID,
      checkpointHash: HASH_A,
      requiredReviewers: 3,
      reviewExecutions,
      findings: [],
      existingCleanRounds: [],
      reviewRoundIndex: 1,
      now: NOW,
    });
    const noChange = {
      ...evidence,
      tasks: [task],
      candidates: [proof],
      checkpoints: [checkpoint(0, HASH_A)],
      reviewExecutions,
      cleanRounds: [cleanRound],
      currentCheckpointHash: HASH_A,
    };
    expect(missionSatisfiedWithoutChange(noChange.tasks)).toBe(true);
    expect(assertCodeChangeMissionMayComplete(noChange)).toEqual({ ok: true });

    const gatesFailed = assertCodeChangeMissionMayComplete({
      ...noChange,
      candidates: [{ ...proof, gateReport: { ...proof.gateReport, passed: false } }],
    });
    expect(gatesFailed).toMatchObject({ ok: false, reason: expect.stringMatching(/has no passing gates on its base/) });
    const gatedElsewhere = assertCodeChangeMissionMayComplete({
      ...noChange,
      candidates: [{ ...proof, gateReport: { ...proof.gateReport, gatedCommit: HASH_B } }],
    });
    expect(gatedElsewhere.ok).toBe(false);
    const unreviewed = assertCodeChangeMissionMayComplete({ ...noChange, reviewExecutions: [], cleanRounds: [] });
    expect(unreviewed).toMatchObject({ ok: false, reason: expect.stringMatching(/no actual review executions/) });
    const moved = assertCodeChangeMissionMayComplete({ ...noChange, currentCheckpointHash: HASH_B });
    expect(moved).toMatchObject({ ok: false, reason: expect.stringMatching(/moved off its baseline/) });

    const mixed = { ...evidence, tasks: [task, { ...evidence.tasks[0]!, id: id("task", NOW + 3) }] };
    expect(missionSatisfiedWithoutChange(mixed.tasks)).toBe(false);
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

  it("rejects one INTEGRATED coding task plus a READY sibling (check 4)", () => {
    const evidence = baseEvidence();
    const sibling = { ...evidence.tasks[0]!, id: id("task", NOW + 9), state: "READY" as const };
    const result = assertCodeChangeMissionMayComplete({ ...evidence, tasks: [...evidence.tasks, sibling] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/incomplete coding/);
      expect(result.terminal).toBe("PLANNING");
    }
  });

  it("rejects a non-terminal valid_finding coding sibling (check 5)", () => {
    const evidence = baseEvidence();
    const finding = {
      ...evidence.tasks[0]!,
      id: id("task", NOW + 10),
      state: "READY" as const,
      origin: {
        kind: "valid_finding" as const,
        findingId: id("find", NOW),
        validationId: id("fval", NOW),
        verdict: "VALID" as const,
      },
    };
    const result = assertCodeChangeMissionMayComplete({ ...evidence, tasks: [...evidence.tasks, finding] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.terminal).toBe("PLANNING");
  });

  it("allows the multi-task axis when every coding task is INTEGRATED (check 6)", () => {
    const second = { ...baseEvidence().tasks[0]!, id: id("task", NOW + 11), state: "INTEGRATED" as const };
    const result = assertCodeChangeMissionMayComplete({
      ...baseEvidence(),
      tasks: [...baseEvidence().tasks, second],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an INTEGRATED task plus a BLOCKED sibling as exhausted (check 7)", () => {
    const blocked = { ...baseEvidence().tasks[0]!, id: id("task", NOW + 12), state: "BLOCKED" as const };
    const result = assertCodeChangeMissionMayComplete({
      ...baseEvidence(),
      tasks: [...baseEvidence().tasks, blocked],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/exhausted/);
      expect(result.terminal).toBe("FAILED");
    }
  });

  it("does not fail the multi-task axis for pre-seeded REJECTED or CANCELLED siblings (check 8)", () => {
    const rejected = { ...baseEvidence().tasks[0]!, id: id("task", NOW + 13), state: "REJECTED" as const };
    const cancelled = { ...baseEvidence().tasks[0]!, id: id("task", NOW + 14), state: "CANCELLED" as const };
    const result = assertCodeChangeMissionMayComplete({
      ...baseEvidence(),
      tasks: [...baseEvidence().tasks, rejected, cancelled],
    });
    expect(result.ok).toBe(true);
  });

  it("does not force-fail review-only missions on the multi-task axis (check 10)", () => {
    const investigation = createTaskFromRequirement(id("interp", NOW), "R1", {
      id: id("task", NOW + 15),
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
      tasks: [{
        ...investigation,
        kind: "investigation",
        touchesProductCode: false,
        origin: { kind: "investigation", findingId: id("find", NOW + 1), round: 1 },
      }],
      candidates: [],
      checkpoints: [],
      reviewExecutions: [],
      cleanRounds: [],
    });
    expect(result.ok).toBe(true);
  });
});

function cleanRound(roundIndex: number, model: string): CleanRound {
  return CleanRoundSchema.parse({
    id: id("cr", NOW + roundIndex),
    runId: RUN_ID,
    checkpointHash: HASH_A,
    axes: ["correctness"],
    ensemble: [{ provider: "p", model }],
    rawFindings: 0,
    roundIndex,
    validatedBlocking: 0,
    novel: true,
    createdAt: NOW,
  });
}

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
    const first = cleanRound(1, "m1");
    const second = cleanRound(2, "m2");
    const state = {
      current,
      priorCheckpoints: [],
      cleanRounds: [first],
      requiredCleanRounds: 2,
      openBlockingFindings: 0,
      investigationExhausted: false,
      consecutiveNoProgress: 0,
      simplifyAfterNoProgress: 3,
    };
    expect(subject.decide(state).action).toBe("CONTINUE_REVIEW");
    expect(subject.decide({ ...state, cleanRounds: [first, second] }).action).toBe("DONE");
    expect(subject.decide({ ...state, cleanRounds: [first, second], openBlockingFindings: 1 }).action).toBe(
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
