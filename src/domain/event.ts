import { z } from "zod";
import { ActorSchema, ArtifactRefSchema, IdSchema, TimestampSchema } from "./common.js";

export const CURRENT_EVENT_SCHEMA_VERSION = 1;

/**
 * Known event types. The list grows with the system; unknown types are still stored
 * (the schema accepts any non-empty string) so replay never fails on forward-compat data.
 */
export const KNOWN_EVENT_TYPES = [
  "run.created",
  /** Which safety mechanisms are on for this run, and why any of them is off. */
  "run.mechanisms",
  "run.phase_changed",
  "run.control_changed",
  /** A phase driver threw. Recorded before the engine does anything else with the run. R3. */
  "run.driver_failed",
  /** Decomposition of one interpretation is claimed, and discarded when two claims raced. R4. */
  "planning.decompose_claimed",
  "planning.decompose_released",
  "planning.decompose_discarded",
  /** A reviewer's verdict on the seeded defect. R2. */
  "review.canary_recorded",
  /** A review axis used up its attempts. Emitted by the reviewing driver; previously unregistered. */
  "review.axis_exhausted",
  /** The engine re-ran an investigation's reproduction; its exit code, not the worker, decides. */
  "investigation.completed",
  "run.terminated",
  "run.answer_recorded",
  "run.settings_fallback",
  "mission.recorded",
  "mission.interpreted",
  "project.discovered",
  "baseline.snapshotted",
  "models.discovered",
  "model.probed",
  "strict_probes.completed",
  "task.created",
  "task.state_changed",
  "candidate.created",
  "candidate.state_changed",
  "candidate.gated",
  "candidate.compared",
  "integration.started",
  "integration.finished",
  "checkpoint.created",
  "checkpoint.rolled_back",
  "acceptance.recorded",
  "corpus.entry_added",
  "protected_change.waiver_recorded",
  "review.started",
  "review.finished",
  "finding.raised",
  "finding.status_changed",
  "finding.validated",
  "finding.debate_started",
  "finding.debate_argument",
  "finding.debate_outcome",
  "clean_round.recorded",
  "fact.recorded",
  "fact.promoted",
  "fact.superseded",
  "job.created",
  "job.state_changed",
  "job.cancel_requested",
  "model.call",
  "model.call_started",
  "model.retry_scheduled",
  "model.fallback_selected",
  "model.output_invalid",
  "model.output_repair_attempted",
  "model.observation.recorded",
  "shell.command",
  "shell.command_started",
  "shell.command_finished",
  "worker.started",
  "worker.progress_scored",
  "worker.progress_abandoned",
  /** The worker repeated one tool result with an unchanged diff. No model call decides this. */
  "worker.loop_stalled",
  "supervisor.decision",
  "council.role_resolved",
  "council.unavailable",
  "budget.updated",
  "budget.evaluated",
  "pathology.detected",
  "pathology.sample",
  "pathology.decision",
  "pathology.effect_started",
  "pathology.effect_completed",
  "report.generated",
  /** A daemon tick stayed over its budget three times. Emitted once, not on every tick. */
  "daemon.watchdog",
] as const;
export type KnownEventType = (typeof KNOWN_EVENT_TYPES)[number];

export const EventSchema = z.object({
  /** Canonical persisted event envelope version. Legacy JSON defaults to version 1 on read. */
  schemaVersion: z.literal(CURRENT_EVENT_SCHEMA_VERSION).default(CURRENT_EVENT_SCHEMA_VERSION),
  id: IdSchema,
  runId: IdSchema,
  /** monotonically increasing per run; assigned by the store */
  seq: z.number().int().nonnegative(),
  ts: TimestampSchema,
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  /** ids of events that caused this one (the causal chain) */
  causedBy: z.array(IdSchema),
  actor: ActorSchema,
  artifacts: z.array(ArtifactRefSchema),
});
export type Event = z.infer<typeof EventSchema>;

/** Callers may omit the version; EventLog always returns and persists a canonical Event. */
export type NewEvent = Omit<Event, "seq" | "schemaVersion"> & { schemaVersion?: typeof CURRENT_EVENT_SCHEMA_VERSION };

export function isKnownEventType(type: string): type is KnownEventType {
  return (KNOWN_EVENT_TYPES as readonly string[]).includes(type);
}

/** Reserved run id for global model observation events that are replayed across all runs. */
export const GLOBAL_MODEL_OBSERVATIONS_RUN_ID = "run_0000000000000000000000";
