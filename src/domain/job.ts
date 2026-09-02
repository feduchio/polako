import { z } from "zod";
import type { TransitionTable } from "./fsm.js";
import { IdSchema, TimestampSchema } from "./common.js";

export const JobStateSchema = z.enum(["PENDING", "READY", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]);
export type JobState = z.infer<typeof JobStateSchema>;

export const JOB_TABLE: TransitionTable<JobState> = {
  initial: "PENDING",
  states: JobStateSchema.options,
  terminal: ["SUCCEEDED", "FAILED", "CANCELLED"],
  edges: {
    PENDING: ["READY", "CANCELLED"],
    /** READY -> FAILED: cannot be started at all (no handler registered / misconfiguration) */
    READY: ["RUNNING", "FAILED", "CANCELLED"],
    /** RUNNING -> READY happens on lease expiry (crash recovery) or retry */
    RUNNING: ["SUCCEEDED", "FAILED", "CANCELLED", "READY"],
    SUCCEEDED: [],
    FAILED: [],
    CANCELLED: [],
  },
};

/** Lane names: `llm.<providerId>` plus the fixed local lanes. */
export const LaneSchema = z.string().regex(/^(llm\.[a-z0-9_-]+|local\.shell|local\.test|local\.build|integration|supervisor|verifier)$/);
export type Lane = z.infer<typeof LaneSchema>;

export const INTEGRATION_LANE: Lane = "integration";

export const JobSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  type: z.string().min(1),
  lane: LaneSchema,
  payload: z.record(z.string(), z.unknown()),
  dependsOn: z.array(IdSchema),
  /** higher runs first within a lane */
  priority: z.number().int(),
  state: JobStateSchema,
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  leaseOwner: z.string().nullable(),
  leaseUntil: TimestampSchema.nullable(),
  cancelRequested: z.boolean(),
  result: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Job = z.infer<typeof JobSchema>;

export function leaseExpired(job: Job, now: number): boolean {
  return job.state === "RUNNING" && job.leaseUntil !== null && job.leaseUntil < now;
}
