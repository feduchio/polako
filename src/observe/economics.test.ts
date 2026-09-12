import { describe, expect, it } from "vitest";
import { SYSTEM_ACTOR } from "../domain/common.js";
import type { Event } from "../domain/event.js";
import type { Run } from "../domain/run.js";
import { id } from "../shared/ids.js";
import { classifyReviewFailure, projectRunEconomics, renderRunEconomics } from "./economics.js";

const RUN_ID = id("run", 1);
const TASK_ID = id("task", 1);
const OTHER_TASK_ID = id("task", 2);

describe("run economics", () => {
  it("keeps input and output separate across every breakdown and deduplicates logical calls", () => {
    const events = [
      modelCall(1, "worker", "agent_run", TASK_ID, 100, 10, 0.125, "worker-call"),
      modelCall(2, "reviewer", "review_correctness", TASK_ID, 20, 200, 0.25, "review-call"),
      modelCall(3, "planner", "council_intake_planner", null, 30, 5, 0, "council-call"),
      // Earlier null usage for the same logical call cannot suppress the usage-bearing record.
      modelCall(0, "reviewer", "review_correctness", TASK_ID, null, null, null, "review-call", false),
      // Later disagreement is not counted, but it raises the report-level conflict flag.
      modelCall(4, "reviewer", "review_correctness", TASK_ID, 999, 999, 0.9, "review-call"),
      // Missing callId falls back to event id, so these remain two calls rather than one null key.
      modelCall(5, "reviewer", "review_regression", TASK_ID, 7, 70, 0),
      modelCall(6, "reviewer", "review_adversarial", TASK_ID, 8, 80, 0),
    ];

    const report = projectRunEconomics(run("DONE"), events);

    expect(report.tokens).toEqual({ inputTokens: 165, outputTokens: 365, totalTokens: 530, calls: 5 });
    expect(report.byRole).toEqual({
      planner: { inputTokens: 30, outputTokens: 5, totalTokens: 35, calls: 1 },
      reviewer: { inputTokens: 35, outputTokens: 350, totalTokens: 385, calls: 3 },
      worker: { inputTokens: 100, outputTokens: 10, totalTokens: 110, calls: 1 },
    });
    expect(report.byPurpose).toEqual({
      agent_run: { inputTokens: 100, outputTokens: 10, totalTokens: 110, calls: 1 },
      council_intake_planner: { inputTokens: 30, outputTokens: 5, totalTokens: 35, calls: 1 },
      review_adversarial: { inputTokens: 8, outputTokens: 80, totalTokens: 88, calls: 1 },
      review_correctness: { inputTokens: 20, outputTokens: 200, totalTokens: 220, calls: 1 },
      review_regression: { inputTokens: 7, outputTokens: 70, totalTokens: 77, calls: 1 },
    });
    expect(report.byTask[TASK_ID]).toEqual({ inputTokens: 135, outputTokens: 360, totalTokens: 495, calls: 4 });
    expect(report.byTask["unassigned"]).toEqual({ inputTokens: 30, outputTokens: 5, totalTokens: 35, calls: 1 });
    for (const breakdown of [report.byRole, report.byPurpose, report.byTask]) {
      expect(sumBreakdown(breakdown)).toEqual(report.tokens);
    }
    expect(report.usd).toBe(0.375);
    expect(report.nullUsageCalls).toBe(0);
    expect(report.nullCostCalls).toBe(0);
    expect(report.usageConflict).toBe(true);
  });

  it("distinguishes free, null-cost and null-usage calls", () => {
    const free = projectRunEconomics(run("DONE"), [
      modelCall(1, "worker", "agent_run", TASK_ID, 1, 2, 0, "a"),
      modelCall(2, "worker", "agent_run", TASK_ID, 3, 4, 0, "b"),
    ]);
    expect(free.usd).toBe(0);
    expect(free.nullCostCalls).toBe(0);
    expect(free.nullUsageCalls).toBe(0);

    const nullCost = projectRunEconomics(run("DONE"), [
      modelCall(1, "worker", "agent_run", TASK_ID, 1, 2, null, "a", false),
    ]);
    expect(nullCost.usd).toBeNull();
    expect(nullCost.failedCalls).toBe(1);
    expect(nullCost.nullCostCalls).toBe(1);
    expect(nullCost.nullUsageCalls).toBe(0);
    expect(nullCost.tokens).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3, calls: 1 });
    expect(nullCost.byRole["worker"]).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3, calls: 1 });

    const nullUsage = projectRunEconomics(run("DONE"), [
      modelCall(1, "worker", "agent_run", TASK_ID, null, null, null, "a", false),
    ]);
    expect(nullUsage.usd).toBeNull();
    expect(nullUsage.failedCalls).toBe(1);
    expect(nullUsage.nullCostCalls).toBe(0);
    expect(nullUsage.nullUsageCalls).toBe(1);
    expect(nullUsage.tokens.totalTokens).toBe(0);

    const absentUsage = projectRunEconomics(run("DONE"), [
      event(1, "model.call", {
        callId: "absent",
        role: "worker",
        purpose: "agent_run",
        taskId: TASK_ID,
        ok: false,
      }),
    ]);
    expect(absentUsage.tokens).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 });
    expect(absentUsage.nullUsageCalls).toBe(1);
    expect(absentUsage.byRole).toEqual({});
    expect(absentUsage.byTask).toEqual({});
  });

  it("reports review cycles, causes, latest validation yield and candidate attempts", () => {
    const correctness = id("rvex", 1);
    const regression = id("rvex", 2);
    const orphan = id("rvex", 3);
    const findingA = id("find", 1);
    const findingB = id("find", 2);
    const events: Event[] = [
      reviewEvent(1, "review.started", correctness, 1, "correctness", false),
      reviewEvent(2, "review.finished", correctness, 1, "correctness", true, undefined, [rawFinding("a")]),
      reviewEvent(3, "review.started", regression, 1, "regression", false),
      reviewEvent(4, "review.finished", regression, 1, "regression", true),
      reviewEvent(5, "review.started", orphan, 2, "adversarial", false),
      incompleteReview(6, "correctness", "rate limited 429; provider_error_code: 400"),
      incompleteReview(7, "regression", "Expected ',' or ']' after array element in JSON at position 551"),
      incompleteReview(8, "adversarial", "bad request (400): JSON mode is not enabled"),
      incompleteReview(9, "correctness", "request timed out after 120000ms"),
      incompleteReview(10, "regression", ""),
      findingRaised(11, findingA, "correctness"),
      findingRaised(12, findingB, "correctness"),
      findingValidated(13, findingA, "UNCERTAIN", "correctness"),
      findingValidated(14, findingA, "VALID", "correctness"),
      findingValidated(15, findingB, "VALID", "correctness"),
      findingValidated(16, findingB, "REJECTED", "correctness"),
      modelCall(17, "reviewer", "review_correctness", TASK_ID, 10, 200, 0, "m1"),
      modelCall(18, "reviewer", "review_regression", TASK_ID, 20, 300, 0, "m2"),
      modelCall(19, "reviewer", "review_adversarial", TASK_ID, 30, 400, 0, "m3"),
      modelCall(20, "reviewer", "pairwise_verification", TASK_ID, 1, 50, 0, "m4"),
      ...[1, 1, 2, 2].map((attempt, index) => candidateCreated(21 + index, attempt, index)),
      event(30, "run.phase_changed", { run: { ...run("NEEDS_HUMAN"), phase: "NEEDS_HUMAN" } }),
      event(29, "task.created", { task: { id: TASK_ID, state: "READY" } }),
      event(30, "task.state_changed", { task: { id: TASK_ID, state: "GATED" }, from: "READY", to: "GATED" }),
      event(31, "task.state_changed", { task: { id: TASK_ID, state: "INTEGRATED" } }),
      event(32, "task.state_changed", { task: { id: OTHER_TASK_ID, state: "READY" } }),
    ];

    const report = projectRunEconomics(run("INTERPRETING_MISSION"), events);
    const total = report.review.total;
    expect(total.requested).toBe(8);
    expect(total.completed).toBe(2);
    expect(total.incomplete).toBe(6);
    expect(total.failureCauses).toEqual({
      rate_limit: 1,
      schema: 1,
      bad_request: 1,
      timeout: 1,
      other: 2,
    });
    expect(total.rawFindings).toBe(2);
    expect(total.validFindings).toBe(1);
    expect(total.rejectedFindings).toBe(1);
    expect(total.validationYield).toBe(0.5);
    expect(total.reviewerOutputTokens).toBe(950);
    expect(total.outputTokensPerRawFinding).toBe(475);
    expect(total.outputTokensPerValidFinding).toBe(950);
    expect(total.completionRate).toBe(0.25);

    const correctnessAxis = report.review.byAxis["correctness"];
    expect(correctnessAxis).toMatchObject({
      requested: 3,
      completed: 1,
      incomplete: 2,
      reviewerInputTokens: 10,
      reviewerOutputTokens: 200,
      completionRate: 1 / 3,
      rawFindings: 2,
      validFindings: 1,
      outputTokensPerRawFinding: 100,
      outputTokensPerValidFinding: 200,
    });
    const clean = report.review.byAxis["regression"];
    expect(clean).toMatchObject({
      requested: 3,
      completed: 1,
      incomplete: 2,
      reviewerInputTokens: 20,
      reviewerOutputTokens: 300,
      completionRate: 1 / 3,
    });
    expect(clean?.rawYield).toBe(0);
    expect(clean?.validationYield).toBeNull();
    expect(clean?.outputTokensPerRawFinding).toBeNull();
    expect(report.review.byAxis["adversarial"]).toMatchObject({
      requested: 2,
      completed: 0,
      incomplete: 2,
      reviewerInputTokens: 30,
      reviewerOutputTokens: 400,
      completionRate: 0,
      rawYield: null,
    });
    expect(report.review.byAxis["unassigned"]?.reviewerOutputTokens).toBe(50);
    expect(report.review.rounds).toEqual({
      "1": {
        requested: 7,
        completed: 2,
        incomplete: 5,
        byAxis: {
          adversarial: { requested: 1, completed: 0, incomplete: 1 },
          correctness: { requested: 3, completed: 1, incomplete: 2 },
          regression: { requested: 3, completed: 1, incomplete: 2 },
        },
      },
      "2": {
        requested: 1,
        completed: 0,
        incomplete: 1,
        byAxis: {
          adversarial: { requested: 1, completed: 0, incomplete: 1 },
        },
      },
    });
    expect(report.candidatesByTask[TASK_ID]).toEqual({ candidateCount: 4, maxAttempt: 2 });
    expect(report.outcome).toEqual({
      phase: "NEEDS_HUMAN",
      terminal: true,
      taskStates: { [OTHER_TASK_ID]: "READY", [TASK_ID]: "INTEGRATED" },
    });
  });

  it("is deterministic at a seq tie and reports active outcomes", () => {
    const a = modelCall(1, "worker", "agent_run", TASK_ID, 1, 10, 0.125, "same");
    const b = { ...modelCall(1, "worker", "agent_run", TASK_ID, 2, 20, 0.25, "same"), id: id("evt", 99) };
    const active = event(2, "run.phase_changed", { run: { ...run("INTERPRETING_MISSION") } });
    const forward = projectRunEconomics(run("CREATED"), [b, active, a]);
    const reverse = projectRunEconomics(run("CREATED"), [a, active, b]);
    expect(forward).toEqual(reverse);
    expect(forward.outcome.phase).toBe("INTERPRETING_MISSION");
    expect(forward.outcome.terminal).toBe(false);
    expect(forward.usageConflict).toBe(true);
  });

  it("reports corpus-shaped null-cost and null-usage counts together", () => {
    const report = projectRunEconomics(run("CREATED"), [
      modelCall(1, "worker", "agent_run", TASK_ID, 2, 3, 0, "free"),
      modelCall(2, "planner", "council_intake_planner", null, 5, 7, null, "unpriced"),
      modelCall(3, "reviewer", "review_correctness", TASK_ID, null, null, null, "failed", false),
      event(4, "run.phase_changed", { run: { ...run("NEEDS_HUMAN"), phase: "NEEDS_HUMAN" } }),
    ]);
    expect(report.tokens).toEqual({ inputTokens: 7, outputTokens: 10, totalTokens: 17, calls: 2 });
    expect(report.usd).toBeNull();
    expect(report.nullCostCalls).toBe(1);
    expect(report.nullUsageCalls).toBe(1);
    expect(report.byTask).toEqual({
      [TASK_ID]: { inputTokens: 2, outputTokens: 3, totalTokens: 5, calls: 1 },
      unassigned: { inputTokens: 5, outputTokens: 7, totalTokens: 12, calls: 1 },
    });
    expect(renderRunEconomics(report)).toContain("USD: unknown (1 null-cost, 1 null-usage calls)");
  });

  it("renders a dry report with cycles and role spend", () => {
    const report = projectRunEconomics(run("DONE"), [
      modelCall(1, "worker", "agent_run", TASK_ID, 100, 10, 0, "a"),
    ]);
    const text = renderRunEconomics(report);
    expect(text).toContain("Tokens: 110 total = 100 input + 10 output");
    expect(text).toContain("worker: 110 = 100 in + 10 out");
    expect(text).toContain("agent_run: 110 = 100 in + 10 out");
    expect(text).toContain(`${TASK_ID}: unknown, 110 tokens`);
    expect(text).toContain("Review: 0 requested, 0 completed, 0 incomplete");
    expect(text).toContain("Usage conflict: no");
    expect(text).not.toMatch(/great|excellent|hope|helpful/i);
  });
});

describe("review failure classifier", () => {
  it.each([
    ["rate limited 429; provider_error_code: 400", "rate_limit"],
    ["request timed out after 120000ms", "timeout"],
    ["bad request (400): JSON mode is not enabled", "bad_request"],
    ["review response must contain a findings array", "schema"],
    ["Expected ',' or ']' after array element in JSON at position 551", "schema"],
    ['{"code":"invalid_value"}', "schema"],
    ["", "other"],
    [undefined, "other"],
  ] as const)("classifies %s as %s", (error, expected) => {
    expect(classifyReviewFailure(error)).toBe(expected);
  });
});

function run(phase: Run["phase"]): Run {
  return {
    id: RUN_ID,
    missionId: id("msn", 1),
    projectPath: "/tmp/project",
    runBranch: "polish/run",
    phase,
    control: "RUNNING",
    currentCheckpointHash: null,
    baselineId: null,
    interpretationId: null,
    createdAt: 1,
    updatedAt: 1,
    terminalReason: null,
  };
}

function event(seq: number, type: string, payload: Record<string, unknown>, eventId = id("evt", seq)): Event {
  return {
    schemaVersion: 1,
    id: eventId,
    runId: RUN_ID,
    seq,
    ts: seq,
    type,
    payload,
    causedBy: [],
    actor: SYSTEM_ACTOR,
    artifacts: [],
  };
}

function modelCall(
  seq: number,
  role: string,
  purpose: string,
  taskId: string | null,
  inputTokens: number | null,
  outputTokens: number | null,
  costUsd: number | null,
  callId?: string,
  ok = true,
): Event {
  return event(seq, "model.call", {
    ...(callId === undefined ? {} : { callId }),
    role,
    purpose,
    taskId,
    ok,
    usage: inputTokens === null || outputTokens === null
      ? null
      : { inputTokens, outputTokens, costUsd },
  });
}

function reviewEvent(
  seq: number,
  type: "review.started" | "review.finished",
  executionId: string,
  roundIndex: number,
  axis: string,
  completed: boolean,
  error?: string,
  findings: unknown[] = [],
): Event {
  return event(seq, type, {
    execution: {
      id: executionId,
      runId: RUN_ID,
      checkpointHash: "a".repeat(40),
      roundIndex,
      axis,
      requestedModel: { provider: "p", model: "m" },
      completed,
      findings,
      ...(error === undefined ? {} : { error }),
      startedAt: 1,
      finishedAt: type === "review.finished" ? seq : null,
    },
  });
}

function incompleteReview(seq: number, axis: string, error: string): Event {
  const executionId = id("rvex", seq + 100);
  return reviewEvent(seq, "review.finished", executionId, 1, axis, false, error);
}

function rawFinding(claim: string): Record<string, unknown> {
  return {
    criterion: "correctness",
    severity: "high",
    blocking: true,
    claim,
    evidence: [{ path: "x.ts", line: 1 }],
    reproduction: ["run test"],
  };
}

function findingRaised(seq: number, findingId: string, axis: string): Event {
  return event(seq, "finding.raised", {
    finding: { id: findingId, axis, status: "RAW" },
  });
}

function findingValidated(seq: number, findingId: string, verdict: string, axis: string): Event {
  return event(seq, "finding.validated", {
    validation: { id: id("fval", seq), findingId, verdict },
    finding: { id: findingId, axis },
  });
}

function candidateCreated(seq: number, attempt: number, index: number): Event {
  return event(seq, "candidate.created", {
    candidate: { id: id("cand", 100 + index), taskId: TASK_ID, attempt },
  });
}

function sumBreakdown(values: Record<string, {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  calls: number;
}>): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  calls: number;
} {
  return Object.values(values).reduce((sum, value) => ({
    inputTokens: sum.inputTokens + value.inputTokens,
    outputTokens: sum.outputTokens + value.outputTokens,
    totalTokens: sum.totalTokens + value.totalTokens,
    calls: sum.calls + value.calls,
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 });
}
