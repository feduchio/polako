import { z } from "zod";
import { ActorSchema, ArtifactRefSchema, IdSchema, TimestampSchema } from "./common.js";

/**
 * Known event types. The list grows with the system; unknown types are still stored
 * (the schema accepts any non-empty string) so replay never fails on forward-compat data.
 */
export const KNOWN_EVENT_TYPES = [
  "run.created",
  "run.phase_changed",
  "run.control_changed",
  "run.terminated",
  "mission.recorded",
  "mission.interpreted",
  "project.discovered",
  "baseline.snapshotted",
  "models.discovered",
  "model.probed",
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
  "review.started",
  "review.finished",
  "finding.raised",
  "finding.status_changed",
  "finding.validated",
  "clean_round.recorded",
  "fact.recorded",
  "fact.promoted",
  "fact.superseded",
  "job.created",
  "job.state_changed",
  "model.call",
  "shell.command",
  "supervisor.decision",
  "budget.updated",
  "pathology.detected",
  "report.generated",
] as const;
export type KnownEventType = (typeof KNOWN_EVENT_TYPES)[number];

export const EventSchema = z.object({
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

export type NewEvent = Omit<Event, "seq">;

export function isKnownEventType(type: string): type is KnownEventType {
  return (KNOWN_EVENT_TYPES as readonly string[]).includes(type);
}
