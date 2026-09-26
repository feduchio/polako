import { SYSTEM_ACTOR } from "../domain/common.js";
import type { ModelInfo } from "../broker/types.js";
import type { NewEvent } from "../domain/event.js";
import type { ProjectProfile } from "../project/profile.js";
import { PolishError, isResumableCouncilFailure } from "../shared/errors.js";
import { id } from "../shared/ids.js";
import { SupervisorCouncil, type CouncilEventSink, type CouncilRoleConfigs } from "../council/index.js";
import { emitNeedsHumanReport } from "../report/emit.js";
import type { TerminalReason } from "../domain/run.js";
import { dependenciesSettled, TASK_TABLE, type Task } from "../domain/task.js";
import type { TaskDag } from "../council/types.js";
import type { IntakeResult } from "../council/types.js";
import type { PhaseContext, PhaseDriver, PhaseDriverResult } from "./types.js";
import { transitionTask } from "./taskTransition.js";

export interface CouncilDriverOptions {
  roles: CouncilRoleConfigs | ((ctx: PhaseContext) => CouncilRoleConfigs);
  resolveProfile?: (ctx: PhaseContext) => ProjectProfile | Promise<ProjectProfile>;
}

function storeEventSink(ctx: PhaseContext): CouncilEventSink {
  return {
    append(events) {
      return ctx.store.events.append(
        events.map((event) => ({
          ...event,
          runId: ctx.run.id,
          ts: event.ts,
        })),
      );
    },
  };
}

function resolveRoles(ctx: PhaseContext, options: CouncilDriverOptions): CouncilRoleConfigs {
  return typeof options.roles === "function" ? options.roles(ctx) : options.roles;
}

function defaultProfile(ctx: PhaseContext): ProjectProfile {
  return {
    projectPath: ctx.run.projectPath,
    alias: null,
    packageManager: "pnpm",
    framework: "vitest",
    checks: [{ name: "test", kind: "test", command: ["pnpm", "test"], mandatory: true }],
    manifestHashes: {},
    scriptsHash: "0".repeat(64),
    discoveredAt: ctx.clock.now(),
  };
}

function createCouncil(ctx: PhaseContext, options: CouncilDriverOptions): SupervisorCouncil {
  const baseline = ctx.store.repos.baselines.listByRun(ctx.run.id)[0];
  return new SupervisorCouncil({
    roles: resolveRoles(ctx, options),
    eventSink: storeEventSink(ctx),
    now: () => ctx.clock.now(),
    runId: ctx.run.id,
    ...(baseline === undefined ? {} : { baseCheckpointHash: baseline.commitHash }),
  });
}

function appendRunSnapshot(ctx: PhaseContext, patch: Partial<typeof ctx.run>): void {
  const event: NewEvent = {
    id: id("evt", ctx.clock.now()),
    runId: ctx.run.id,
    ts: ctx.clock.now(),
    type: "run.phase_changed",
    payload: { run: { ...ctx.run, ...patch, updatedAt: ctx.clock.now() } },
    causedBy: [],
    actor: SYSTEM_ACTOR,
    artifacts: [],
  };
  ctx.store.events.append([event]);
}

/** Production INTERPRETING_MISSION driver: council intake, persist interpretation, set interpretationId. */
export function createInterpretingMissionDriver(options: CouncilDriverOptions): PhaseDriver {
  return async (ctx) => {
    const mission = ctx.store.repos.missions.get(ctx.run.missionId);
    if (mission === null) return { status: "waiting" };
    const baseline = ctx.store.repos.baselines.listByRun(ctx.run.id)[0];
    if (baseline === undefined) return { status: "waiting" };
    const profile = await (options.resolveProfile ?? defaultProfile)(ctx);
    const council = createCouncil(ctx, options);
    const humanAnswer = latestHumanAnswer(ctx);
    let result: IntakeResult;
    try {
      result = await council.intake(mission, profile, baseline, {
        readCheckOutput: (sha256) => {
          try {
            return ctx.store.artifacts.getText(sha256);
          } catch {
            return null;
          }
        },
        ...(humanAnswer === undefined ? {} : { humanAnswer }),
      });
    } catch (error) {
      recordCouncilUnavailable(ctx, error);
      throw error;
    }

    if (result.interpretation !== null) {
      const causedBy = result.decision.events.map((event) => event.id);
      const interpreted: NewEvent = {
        id: id("evt", ctx.clock.now()),
        runId: ctx.run.id,
        ts: ctx.clock.now(),
        type: "mission.interpreted",
        payload: { interpretation: result.interpretation },
        causedBy,
        actor: { kind: "supervisor", role: "council" },
        artifacts: [],
      };
      ctx.store.events.append([interpreted]);
      appendRunSnapshot(ctx, { interpretationId: result.interpretation.id });
    }

    if (result.status === "NEEDS_HUMAN") {
      const reason = terminalReasonFromIntake(result);
      emitNeedsHumanReport(ctx, reason, result.decision.events.map((event) => event.id));
      appendRunSnapshot(ctx, {
        interpretationId: result.interpretation?.id ?? ctx.run.interpretationId,
        terminalReason: reason,
      });
      return { status: "complete", nextPhase: "NEEDS_HUMAN" };
    }
    return { status: "complete", nextPhase: "DISCOVERING_MODELS" };
  };
}

/**
 * The decomposition already claimed for this interpretation, or `null`. Read from the log rather
 * than held in memory, so a daemon restart cannot lose it and a second daemon cannot miss it.
 */
/**
 * How long a claim is honoured. A claim with no owner is a claim nobody can release: a process that
 * dies between claiming and decomposing would otherwise leave PLANNING returning `waiting` forever,
 * with no event ever changing and nothing to recover from. So it is a lease, not a lock.
 *
 * Ten minutes is far longer than a decomposition — three council calls — and far shorter than a
 * person noticing a stuck run.
 */
const DECOMPOSE_CLAIM_LEASE_MS = 10 * 60_000;

/**
 * The live claim on decomposing this interpretation, or `null`. Counted from the log, so a restart
 * cannot lose it; leased, so a crash cannot keep it.
 */
function liveDecomposeClaim(ctx: PhaseContext, interpretationId: string): { claimedAt: number } | null {
  let claimedAt: number | null = null;
  for (const event of ctx.store.events.list(ctx.run.id, {
    types: ["planning.decompose_claimed", "planning.decompose_released"],
  })) {
    if (event.payload["interpretationId"] !== interpretationId) continue;
    // Last write wins, rather than a counter: a counter lets an unmatched release cancel a later
    // legitimate claim, and the log is append-only so an unmatched release cannot be removed.
    claimedAt = event.type === "planning.decompose_claimed" ? event.ts : null;
  }
  if (claimedAt === null) return null;
  return { claimedAt };
}

/**
 * A claim that produced no tasks is released, or the run could never decompose again: an answered
 * `NEEDS_HUMAN` re-enters PLANNING with the task list still empty, and a lock nobody can release
 * is a run that waits forever. Released rather than deleted, because the log is append-only and
 * the attempt is worth seeing.
 */
function releaseDecomposeClaim(ctx: PhaseContext, interpretationId: string, reason: string): void {
  ctx.store.events.append([{
    id: id("evt", ctx.clock.now()),
    runId: ctx.run.id,
    ts: ctx.clock.now(),
    type: "planning.decompose_released",
    payload: { interpretationId, reason },
    causedBy: [],
    actor: SYSTEM_ACTOR,
    artifacts: [],
  }]);
}

/** Production PLANNING driver: first-plan decompose only; re-entry restores and continues. */
export function createPlanningDriver(options: CouncilDriverOptions): PhaseDriver {
  return async (ctx) => {
    const interpretationId = ctx.run.interpretationId;
    if (interpretationId === null) return { status: "waiting" };
    const interpretation = ctx.store.repos.interpretations.get(interpretationId);
    if (interpretation === null) return { status: "waiting" };

    const existing = ctx.store.repos.tasks.listByRun(ctx.run.id);
    if (existing.length >= 1) {
      restoreIntegrationFailedForRetry(ctx, existing);
      await splitRequestedTasks(ctx, options, existing);
      return nextPhaseForPlanningReentry(ctx);
    }

    // R4. The check above is a read, and `council.decompose` below is an await: two drivers that
    // both reach it while the task list is empty both decompose and both append. D1 did exactly
    // that — `run_01m2gy5yg30631j247sn13` holds two `decompose APPROVED` decisions and ten tasks
    // with five distinct titles, the second set landing after the run had already left for
    // EXECUTING. Half the quota that run spent bought nothing.
    //
    // The claim is an event, not a field: it survives a restart, which an in-memory latch does not,
    // and it is visible to anyone reading the log afterwards.
    const held = liveDecomposeClaim(ctx, interpretationId);
    if (held !== null) {
      if (ctx.clock.now() - held.claimedAt < DECOMPOSE_CLAIM_LEASE_MS) return { status: "waiting" };
      releaseDecomposeClaim(ctx, interpretationId, "claim expired without producing tasks");
    }
    ctx.store.events.append([{
      id: id("evt", ctx.clock.now()),
      runId: ctx.run.id,
      ts: ctx.clock.now(),
      type: "planning.decompose_claimed",
      payload: { interpretationId },
      causedBy: [],
      actor: SYSTEM_ACTOR,
      artifacts: [],
    }]);

    const council = createCouncil(ctx, options);
    let dag: TaskDag;
    try {
      const humanAnswer = latestHumanAnswer(ctx);
      dag = await council.decompose(
        interpretation,
        humanAnswer === undefined ? {} : { humanAnswer },
      );
    } catch (error) {
      releaseDecomposeClaim(ctx, interpretationId, "decompose failed");
      recordCouncilUnavailable(ctx, error);
      throw error;
    }
    if (dag.decision.decision === "NEEDS_HUMAN") {
      releaseDecomposeClaim(ctx, interpretationId, "decompose asked for a human");
      const reason = terminalReasonFromDecompose(dag);
      emitNeedsHumanReport(ctx, reason, dag.decision.events.map((event) => event.id));
      appendRunSnapshot(ctx, { terminalReason: reason });
      return { status: "complete", nextPhase: "NEEDS_HUMAN" };
    }
    // Read again, in the same synchronous step as the append. The claim above stops a second
    // driver starting; this stops one that started before the claim existed from finishing into a
    // run that already has its tasks. Both are needed: the first is a lock, the second is the
    // check that does not depend on the lock having been there first.
    if (ctx.store.repos.tasks.listByRun(ctx.run.id).length >= 1) {
      releaseDecomposeClaim(ctx, interpretationId, "another driver had already created the tasks");
      ctx.store.events.append([{
        id: id("evt", ctx.clock.now()),
        runId: ctx.run.id,
        ts: ctx.clock.now(),
        type: "planning.decompose_discarded",
        payload: { interpretationId, discardedTasks: dag.tasks.length },
        causedBy: dag.decision.events.map((event) => event.id),
        actor: SYSTEM_ACTOR,
        artifacts: [],
      }]);
      return nextPhaseForPlanningReentry(ctx);
    }
    const causedBy = dag.decision.events.map((event) => event.id);
    const taskEvents: NewEvent[] = dag.tasks.map((task) => ({
      id: id("evt", ctx.clock.now()),
      runId: ctx.run.id,
      ts: ctx.clock.now(),
      type: "task.created",
      payload: { task },
      causedBy,
      actor: { kind: "supervisor", role: "council" },
      artifacts: [],
    }));
    if (taskEvents.length > 0) ctx.store.events.append(taskEvents);

    const codingTasks = dag.tasks.filter((task) => isCodingTask(task));
    if (codingTasks.length > 0) return { status: "complete", nextPhase: "EXECUTING" };
    return { status: "complete", nextPhase: "REVIEWING" };
  };
}

const TERMINAL_TASK_STATES = new Set<Task["state"]>(TASK_TABLE.terminal);

function latestHumanAnswer(ctx: PhaseContext): string | undefined {
  return ctx.store.events
    .list(ctx.run.id, { types: ["run.answer_recorded"] })
    .map((event) => event.payload["answer"])
    .filter((answer): answer is string => typeof answer === "string")
    .at(-1);
}

function isCodingTask(task: Task): boolean {
  return task.touchesProductCode && task.kind !== "investigation";
}

function isTerminalTask(task: Task): boolean {
  return TERMINAL_TASK_STATES.has(task.state);
}

function planningDependenciesMet(ctx: PhaseContext, task: Task): boolean {
  return dependenciesSettled(task, ctx.store.repos.tasks.listByRun(ctx.run.id));
}

function isExhaustedCodingTask(task: Task, maxAttempts: number): boolean {
  return isCodingTask(task) && (
    task.state === "BLOCKED" ||
    (task.state === "INTEGRATION_FAILED" && task.attempts >= maxAttempts)
  );
}

/**
 * A task whose worker asked for a split goes to the council with the worker's parts. Approved, it
 * becomes SPLIT and its subtasks join the plan; refused, it is retried whole, or blocked once its
 * attempts are spent.
 */
async function splitRequestedTasks(ctx: PhaseContext, options: CouncilDriverOptions, tasks: readonly Task[]): Promise<void> {
  const requested = tasks.filter((task) => task.state === "NEEDS_SPLIT");
  if (requested.length === 0) return;
  const council = createCouncil(ctx, options);
  for (const task of requested) {
    const request = ctx.store.repos.candidates
      .listByTask(task.id)
      .find((candidate) => candidate.state === "NEEDS_SPLIT" && candidate.attempt === task.attempts && candidate.splitRequest !== undefined)
      ?.splitRequest;
    let dag: TaskDag | null = null;
    if (request !== undefined) {
      try {
        dag = await council.split(task, request);
      } catch (error) {
        recordCouncilUnavailable(ctx, error);
        throw error;
      }
    }
    const subtasks = dag?.tasks ?? [];
    const causedBy = dag?.decision.events.map((event) => event.id) ?? [];
    ctx.store.transaction(() => {
      const current = ctx.store.repos.tasks.get(task.id);
      if (current?.state !== "NEEDS_SPLIT") return;
      if (subtasks.length >= 2) {
        const base = ctx.run.currentCheckpointHash ?? current.baseCheckpointHash;
        ctx.store.events.append(subtasks.map((subtask) => ({
          id: id("evt", ctx.clock.now()),
          runId: ctx.run.id,
          ts: ctx.clock.now(),
          type: "task.created" as const,
          payload: { task: { ...subtask, baseCheckpointHash: base } },
          causedBy,
          actor: { kind: "supervisor" as const, role: "council" as const },
          artifacts: [],
        })));
        transitionTask(ctx.store, ctx.clock, ctx.run.id, { ...current, state: "SPLIT", updatedAt: ctx.clock.now() }, causedBy);
        return;
      }
      const state = current.attempts < ctx.config.retry.maxAttempts ? "READY" : "BLOCKED";
      transitionTask(ctx.store, ctx.clock, ctx.run.id, { ...current, state, updatedAt: ctx.clock.now() }, causedBy);
    });
  }
}

function restoreIntegrationFailedForRetry(ctx: PhaseContext, tasks: readonly Task[]): void {
  const maxAttempts = ctx.config.retry.maxAttempts;
  for (const task of tasks) {
    if (!isCodingTask(task) || task.state !== "INTEGRATION_FAILED" || task.attempts >= maxAttempts) continue;
    transitionTask(ctx.store, ctx.clock, ctx.run.id, {
      ...task,
      state: "READY",
      baseCheckpointHash: ctx.run.currentCheckpointHash ?? task.baseCheckpointHash,
      selectedCandidateId: null,
      updatedAt: ctx.clock.now(),
    });
  }
}

function nextPhaseForPlanningReentry(ctx: PhaseContext): PhaseDriverResult {
  const tasks = ctx.store.repos.tasks.listByRun(ctx.run.id);
  const maxAttempts = ctx.config.retry.maxAttempts;
  const coding = tasks.filter(isCodingTask);
  const liveCoding = coding.filter((task) => !isTerminalTask(task) && !isExhaustedCodingTask(task, maxAttempts));
  const readyNow = liveCoding.some((task) =>
    task.state === "READY" ||
    task.state === "RUNNING" ||
    (task.state === "PENDING" && planningDependenciesMet(ctx, task)),
  );
  if (readyNow || liveCoding.length > 0) {
    return { status: "complete", nextPhase: "EXECUTING" };
  }

  const openInvestigations = tasks.filter((task) => task.kind === "investigation" && !isTerminalTask(task));
  if (openInvestigations.some((task) => task.state !== "BLOCKED")) {
    return { status: "complete", nextPhase: "EXECUTING" };
  }
  if (openInvestigations.length > 0) {
    const reason: TerminalReason = {
      code: "product_decision_required",
      summary: `No reproduction the engine could run settled ${String(openInvestigations.length)} uncertain finding(s) within ${String(maxAttempts)} attempts.`,
      question: "Investigation attempts are exhausted. How should the run proceed?",
      options: ["Provide investigation evidence", "Stop the run"],
    };
    emitNeedsHumanReport(ctx, reason, []);
    appendRunSnapshot(ctx, { terminalReason: reason });
    return { status: "complete", nextPhase: "NEEDS_HUMAN" };
  }

  const exhausted = coding.filter((task) => isExhaustedCodingTask(task, maxAttempts));
  const findingWork = tasks.filter((task) =>
    (task.origin.kind === "valid_finding" || task.origin.kind === "investigation") &&
    !isTerminalTask(task) &&
    !isExhaustedCodingTask(task, maxAttempts),
  );
  if (exhausted.length > 0 && findingWork.length === 0) {
    if (ctx.run.terminalReason !== null) return { status: "complete", nextPhase: "NEEDS_HUMAN" };
    return { status: "complete", nextPhase: "FAILED" };
  }
  return { status: "complete", nextPhase: "REVIEWING" };
}

function recordCouncilUnavailable(ctx: PhaseContext, error: unknown): void {
  if (!isResumableCouncilFailure(error)) return;
  const details = error instanceof PolishError ? error.details : {};
  const outputContract = error instanceof PolishError && error.code === "OUTPUT_CONTRACT";
  const event: NewEvent = {
    id: id("evt", ctx.clock.now()),
    runId: ctx.run.id,
    ts: ctx.clock.now(),
    type: "council.unavailable",
    payload: {
      message: error instanceof Error ? error.message : String(error),
      role: details["role"] ?? "planner",
      kind: outputContract ? "output_contract" : "providers_unavailable",
      attempted: details["attempted"] ?? [],
      models: details["models"] ?? [],
      issues: details["issues"] ?? [],
      siblingOutcomes: details["siblingOutcomes"] ?? [],
      automaticRetryScheduled: false,
      manualResumePossible: true,
    },
    causedBy: [],
    actor: { kind: "supervisor", role: "council" },
    artifacts: [],
  };
  ctx.store.events.append([event]);
}

function terminalReasonFromIntake(result: Extract<IntakeResult, { status: "NEEDS_HUMAN" }>): TerminalReason {
  return {
    code: "ambiguous_intent",
    summary: result.decision.rationale,
    question: result.question,
    options: result.options,
  };
}

function terminalReasonFromDecompose(dag: TaskDag): TerminalReason {
  const concern = dag.decision.opinions.find((opinion) => opinion.concerns.length > 0)?.concerns[0];
  return {
    code: "product_decision_required",
    summary: dag.decision.rationale,
    question: concern ?? "The council could not produce an executable plan. How should we proceed?",
    options: ["Restate requirements with explicit acceptance", "Narrow the mission scope", "Stop the run"],
  };
}

/** Records models.discovered from an injected catalog list (no live HTTP). */
export function createDiscoveringModelsDriver(catalog: ModelInfo[]): PhaseDriver {
  return (ctx) => {
    const event: NewEvent = {
      id: id("evt", ctx.clock.now()),
      runId: ctx.run.id,
      ts: ctx.clock.now(),
      type: "models.discovered",
      payload: { models: catalog },
      causedBy: [],
      actor: SYSTEM_ACTOR,
      artifacts: [],
    };
    ctx.store.events.append([event]);
    return { status: "complete", nextPhase: "PLANNING" };
  };
}
