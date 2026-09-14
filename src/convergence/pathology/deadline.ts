import { SYSTEM_ACTOR } from "../../domain/common.js";
import type { NewEvent } from "../../domain/event.js";
import type { PolishConfig } from "../../domain/config.js";
import type { Run } from "../../domain/run.js";
import type { Scheduler } from "../../scheduler/index.js";
import type { Store } from "../../store/index.js";
import type { Clock } from "../../shared/clock.js";
import { PolishError } from "../../shared/errors.js";
import { id } from "../../shared/ids.js";

export const BUDGET_EVALUATE_JOB = "budget.evaluate";

export function wallClockDueAt(runCreatedAt: number, maxRunWallClockMinutes: number): number {
  return runCreatedAt + maxRunWallClockMinutes * 60_000;
}

export function enqueueBudgetDeadlineJob(input: {
  scheduler: Scheduler;
  store: Store;
  run: Run;
  config: Pick<PolishConfig, "budget">;
}): void {
  const minutes = input.config.budget.maxRunWallClockMinutes;
  if (minutes === null) return;
  const deadlineJobs = input.store.repos.jobs.listByRun(input.run.id)
    .filter((job) => job.type === BUDGET_EVALUATE_JOB);
  // STOP cancels outstanding work. A later resume recreates only that cancelled deadline,
  // preserving the original dueAt derived from run.createdAt. Completed/failed jobs stay final.
  if (deadlineJobs.some((job) => job.state !== "CANCELLED")) return;
  const dueAt = wallClockDueAt(input.run.createdAt, minutes);
  input.scheduler.enqueue({
    runId: input.run.id,
    type: BUDGET_EVALUATE_JOB,
    lane: "supervisor",
    payload: { kind: "wall_clock", dueAt },
    dueAt,
  });
}

export function hasBudgetEvaluation(store: Store, runId: string, dueAt: number): boolean {
  return store.events.list(runId, { types: ["budget.evaluated"] }).some((event) => event.payload["dueAt"] === dueAt);
}

export function appendBudgetEvaluationBoundary(input: {
  store: Store;
  runId: string;
  dueAt: number;
  observedAt: number;
  causedBy?: string[];
}): boolean {
  if (hasBudgetEvaluation(input.store, input.runId, input.dueAt)) return false;
  const event: NewEvent = {
    id: id("evt", input.observedAt),
    runId: input.runId,
    ts: input.observedAt,
    type: "budget.evaluated",
    payload: { kind: "wall_clock", dueAt: input.dueAt, observedAt: input.observedAt },
    causedBy: input.causedBy ?? [],
    actor: SYSTEM_ACTOR,
    artifacts: [],
  };
  input.store.events.append([event]);
  return true;
}

export function appendDueBudgetEvaluationBoundaries(input: {
  store: Store;
  clock: Clock;
  config: Pick<PolishConfig, "budget">;
}): number {
  const minutes = input.config.budget.maxRunWallClockMinutes;
  if (minutes === null) return 0;
  let appended = 0;
  for (const run of input.store.repos.runs.listAll()) {
    const dueAt = wallClockDueAt(run.createdAt, minutes);
    if (input.clock.now() < dueAt) continue;
    if (appendBudgetEvaluationBoundary({ store: input.store, runId: run.id, dueAt, observedAt: input.clock.now() })) {
      appended += 1;
    }
  }
  return appended;
}

export function registerBudgetEvaluateHandler(scheduler: Scheduler, store: Store): void {
  try {
    scheduler.register(BUDGET_EVALUATE_JOB, (ctx) => {
      const dueAt = typeof ctx.job.payload["dueAt"] === "number" ? ctx.job.payload["dueAt"] : ctx.job.dueAt ?? ctx.clock.now();
      appendBudgetEvaluationBoundary({
        store,
        runId: ctx.job.runId,
        dueAt,
        observedAt: ctx.clock.now(),
        causedBy: [ctx.job.id],
      });
      return Promise.resolve({ evaluated: true, dueAt });
    });
  } catch (error) {
    if (!(error instanceof PolishError && error.code === "CONFLICT")) throw error;
  }
}
