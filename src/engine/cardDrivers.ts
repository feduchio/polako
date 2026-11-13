import { CARDS_REGISTERED_EVENT, CardRegistrationSchema, cardAcceptanceChecks, cardComplexity, cardDescription, cardKind, type CardRegistration } from "../cards/index.js";
import { SYSTEM_ACTOR } from "../domain/common.js";
import type { NewEvent } from "../domain/event.js";
import { MissionInterpretationSchema, type MissionInterpretation } from "../domain/mission.js";
import { createTaskFromRequirement, type Task } from "../domain/task.js";
import { profileCacheKey } from "../project/discovery.js";
import type { ProjectProfile } from "../project/profile.js";
import { id } from "../shared/ids.js";
import { transitionTask } from "./taskTransition.js";
import type { PhaseContext, PhaseDriver } from "./types.js";

/** The cards a run was started with, or null for a mission run. Read from the log, so it survives a restart. */
export function cardRegistration(ctx: Pick<PhaseContext, "run" | "store">): CardRegistration | null {
  const event = ctx.store.events.list(ctx.run.id, { types: [CARDS_REGISTERED_EVENT] }).at(-1);
  if (event === undefined) return null;
  return CardRegistrationSchema.parse(event.payload["registration"]);
}

/**
 * The interpretation of a card run: one requirement per card, taken verbatim. No model reads the
 * cards, because the user already wrote what a model would be asked to infer (goals, acceptance,
 * scope); the baseline and project profile are still what it is based on.
 */
export function interpretationFromCards(
  registration: CardRegistration,
  input: { missionId: string; profile: ProjectProfile; baselineId: string; now: number },
): MissionInterpretation {
  const requirements = registration.cards.map((card, index) => ({
    ref: `R${String(index + 1)}`,
    statement: `Card ${card.id}: ${card.title}. ${card.goal}`,
    acceptance: card.acceptance,
  }));
  return MissionInterpretationSchema.parse({
    id: id("mint", input.now),
    missionId: input.missionId,
    version: 1,
    supersedes: null,
    basedOn: { profileHash: profileCacheKey(input.profile), baselineId: input.baselineId },
    goals: registration.cards.map((card) => `${card.id}: ${card.title}`),
    requirements,
    constraints: [
      "Change only the files each card lists under `files:`; the gate rejects anything else.",
      ...(registration.brief.trim() === "" ? [] : ["Follow the project brief given with the cards."]),
    ],
    nonGoals: [],
    definitionOfSuccess: registration.cards.flatMap((card) => card.acceptance.map((line) => `${card.id}: ${line}`)),
    ambiguities: [],
    createdBy: SYSTEM_ACTOR,
    createdAt: input.now,
  });
}

/** One task per card, with `depends:` as edges, `files:` as write scope and the acceptance lines as acceptance. */
export function tasksFromCards(
  registration: CardRegistration,
  input: { runId: string; interpretation: MissionInterpretation; baseCheckpointHash: string; now: number },
): Task[] {
  const taskIds = new Map(registration.cards.map((card) => [card.id, id("task", input.now)]));
  const titles = new Map(registration.cards.map((card) => [card.id, card.title]));
  return registration.cards.map((card, index) => {
    const taskId = taskIds.get(card.id);
    if (taskId === undefined) throw new Error(`card ${card.id} has no task id`);
    const checks = cardAcceptanceChecks(card);
    return createTaskFromRequirement(input.interpretation.id, `R${String(index + 1)}`, {
      id: taskId,
      runId: input.runId,
      title: card.title,
      description: cardDescription(card, card.depends.map((dependency) => `${dependency} ${titles.get(dependency) ?? ""}`.trim())),
      kind: cardKind(card),
      acceptance: card.acceptance,
      ...(checks.length === 0 ? {} : { acceptanceChecks: checks }),
      complexity: cardComplexity(card),
      baseCheckpointHash: input.baseCheckpointHash,
      dependsOn: card.depends.map((dependency) => taskIds.get(dependency) ?? dependency),
      now: input.now,
      cardId: card.id,
      allowedFiles: card.files,
    });
  });
}

const FAILED_FOR_DEPENDENTS = new Set<Task["state"]>(["BLOCKED", "REJECTED", "CANCELLED"]);

/**
 * A card whose dependency can no longer be integrated would wait for it forever, and a run with a
 * task waiting forever never ends. td's runner skips such a card; here it is CANCELLED, and the
 * report names it as skipped because of the card it depended on.
 */
export function cancelUnreachableCards(ctx: PhaseContext): string[] {
  const tasks = ctx.store.repos.tasks.listByRun(ctx.run.id);
  const cancelled: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of ctx.store.repos.tasks.listByRun(ctx.run.id)) {
      if (task.cardId === undefined || task.state !== "PENDING") continue;
      const blocker = task.dependsOn.map((dependency) => tasks.find((other) => other.id === dependency)).find(
        (dependency) => dependency !== undefined && FAILED_FOR_DEPENDENTS.has(ctx.store.repos.tasks.get(dependency.id)?.state ?? dependency.state),
      );
      if (blocker === undefined) continue;
      transitionTask(ctx.store, ctx.clock, ctx.run.id, { ...task, state: "CANCELLED", updatedAt: ctx.clock.now() });
      cancelled.push(task.cardId);
      changed = true;
    }
  }
  return cancelled;
}

function appendRunSnapshot(ctx: PhaseContext, patch: Partial<PhaseContext["run"]>): void {
  ctx.store.events.append([{
    id: id("evt", ctx.clock.now()),
    runId: ctx.run.id,
    ts: ctx.clock.now(),
    type: "run.phase_changed",
    payload: { run: { ...ctx.run, ...patch, updatedAt: ctx.clock.now() } },
    causedBy: [],
    actor: SYSTEM_ACTOR,
    artifacts: [],
  }]);
}

/** INTERPRETING_MISSION for a card run: the interpretation is the cards. Any other run goes to `fallback`. */
export function withCardInterpretation(
  fallback: PhaseDriver,
  options: { resolveProfile: (ctx: PhaseContext) => ProjectProfile | Promise<ProjectProfile> },
): PhaseDriver {
  return async (ctx) => {
    const registration = cardRegistration(ctx);
    if (registration === null) return fallback(ctx);
    if (ctx.run.interpretationId !== null) return { status: "complete", nextPhase: "DISCOVERING_MODELS" };
    const baseline = ctx.store.repos.baselines.listByRun(ctx.run.id)[0];
    if (baseline === undefined) return { status: "waiting" };
    const interpretation = interpretationFromCards(registration, {
      missionId: ctx.run.missionId,
      profile: await options.resolveProfile(ctx),
      baselineId: baseline.id,
      now: ctx.clock.now(),
    });
    const interpreted: NewEvent = {
      id: id("evt", ctx.clock.now()),
      runId: ctx.run.id,
      ts: ctx.clock.now(),
      type: "mission.interpreted",
      payload: { interpretation },
      causedBy: [],
      actor: SYSTEM_ACTOR,
      artifacts: [],
    };
    ctx.store.events.append([interpreted]);
    appendRunSnapshot(ctx, { interpretationId: interpretation.id });
    return { status: "complete", nextPhase: "DISCOVERING_MODELS" };
  };
}

/**
 * PLANNING for a card run, the first time: the task DAG is the cards, with no decomposition. Once
 * the tasks exist (and for any other run) planning is the ordinary driver, so retries, splits,
 * investigations and re-entry behave exactly as in a mission run.
 */
export function withCardPlanning(fallback: PhaseDriver): PhaseDriver {
  return async (ctx) => {
    const registration = cardRegistration(ctx);
    if (registration === null) return fallback(ctx);
    if (ctx.store.repos.tasks.listByRun(ctx.run.id).length > 0) {
      cancelUnreachableCards(ctx);
      return fallback(ctx);
    }
    const interpretationId = ctx.run.interpretationId;
    const interpretation = interpretationId === null ? null : ctx.store.repos.interpretations.get(interpretationId);
    if (interpretation === null) return { status: "waiting" };
    const tasks = tasksFromCards(registration, {
      runId: ctx.run.id,
      interpretation,
      baseCheckpointHash: ctx.run.currentCheckpointHash ?? ctx.store.repos.baselines.listByRun(ctx.run.id)[0]?.commitHash ?? "",
      now: ctx.clock.now(),
    });
    ctx.store.events.append(tasks.map((task) => ({
      id: id("evt", ctx.clock.now()),
      runId: ctx.run.id,
      ts: ctx.clock.now(),
      type: "task.created",
      payload: { task },
      causedBy: [],
      actor: SYSTEM_ACTOR,
      artifacts: [],
    })));
    return { status: "complete", nextPhase: "EXECUTING" };
  };
}
