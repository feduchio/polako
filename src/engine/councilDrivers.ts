import { SYSTEM_ACTOR } from "../domain/common.js";
import type { ModelInfo } from "../broker/types.js";
import type { NewEvent } from "../domain/event.js";
import type { ProjectProfile } from "../project/profile.js";
import { PolishError, isResumableCouncilFailure } from "../shared/errors.js";
import { id } from "../shared/ids.js";
import { SupervisorCouncil, type CouncilEventSink, type CouncilRoleConfigs } from "../council/index.js";
import { emitNeedsHumanReport } from "../report/emit.js";
import type { TerminalReason } from "../domain/run.js";
import type { TaskDag } from "../council/types.js";
import type { IntakeResult } from "../council/types.js";
import type { PhaseContext, PhaseDriver } from "./types.js";

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

/** Production PLANNING driver: council decomposition and task.created events. */
export function createPlanningDriver(options: CouncilDriverOptions): PhaseDriver {
  return async (ctx) => {
    const interpretationId = ctx.run.interpretationId;
    if (interpretationId === null) return { status: "waiting" };
    const interpretation = ctx.store.repos.interpretations.get(interpretationId);
    if (interpretation === null) return { status: "waiting" };

    const council = createCouncil(ctx, options);
    let dag: TaskDag;
    try {
      dag = await council.decompose(interpretation);
    } catch (error) {
      recordCouncilUnavailable(ctx, error);
      throw error;
    }
    if (dag.decision.decision === "NEEDS_HUMAN") {
      const reason = terminalReasonFromDecompose(dag);
      emitNeedsHumanReport(ctx, reason, dag.decision.events.map((event) => event.id));
      appendRunSnapshot(ctx, { terminalReason: reason });
      return { status: "complete", nextPhase: "NEEDS_HUMAN" };
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

    const codingTasks = dag.tasks.filter((task) => task.touchesProductCode && task.kind !== "investigation");
    if (codingTasks.length > 0) return { status: "complete", nextPhase: "EXECUTING" };
    return { status: "complete", nextPhase: "REVIEWING" };
  };
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
