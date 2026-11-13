import { z } from "zod";
import { CheckResultSchema } from "./checks.js";
import { ArtifactRefSchema, GitHashSchema, IdSchema, ModelRefSchema, TimestampSchema } from "./common.js";

/**
 * A candidate is stored already carrying the outcome of the work that produced it.
 * CREATED, IMPLEMENTING and GATING were never written: the store's candidate events are
 * IMPLEMENTED, PASSED_GATES, FAILED_GATES, WINNER, LOSER, DISCARDED and INTERRUPTED.
 */
export const CandidateStateSchema = z.enum([
  "IMPLEMENTED",
  "PASSED_GATES",
  "FAILED_GATES",
  "WINNER",
  "LOSER",
  "DISCARDED",
  "INTERRUPTED",
  /** The worker asked for its task to be split instead of changing code. Terminal for the candidate. */
  "NEEDS_SPLIT",
]);
export type CandidateState = z.infer<typeof CandidateStateSchema>;

export const GateFailureReasonSchema = z.enum([
  "mandatory_check_failed",
  "regression_vs_baseline",
  "protected_path_modified",
  "test_silencing_detected",
  "config_weakened",
  /** A task card limits the files a change may touch, and the candidate changed others. */
  "scope_violation",
  "check_scripts_modified",
  "no_changes",
  "gate_error",
]);
export type GateFailureReason = z.infer<typeof GateFailureReasonSchema>;

export const GateReportSchema = z.object({
  /** commit that was checked out cleanly and gated (never the live worktree) */
  gatedCommit: GitHashSchema,
  checks: z.array(CheckResultSchema),
  /** acceptance artifacts injected before running checks, with verified hashes */
  injectedAcceptance: z.array(IdSchema),
  failures: z.array(
    z.object({
      reason: GateFailureReasonSchema,
      detail: z.string(),
    }),
  ),
  passed: z.boolean(),
  diffStat: z.object({ files: z.number().int().nonnegative(), insertions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative() }),
  createdAt: TimestampSchema,
});
export type GateReport = z.infer<typeof GateReportSchema>;

export const SplitRequestSchema = z.object({
  reason: z.string().min(1),
  parts: z.array(z.object({
    title: z.string().min(1),
    acceptance: z.array(z.string().min(1)).min(1),
    files: z.array(z.string()),
  })).min(2),
});
export type SplitRequest = z.infer<typeof SplitRequestSchema>;

export const CandidateSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  taskId: IdSchema,
  attempt: z.number().int().positive(),
  model: ModelRefSchema,
  baseCheckpointHash: GitHashSchema,
  branch: z.string().min(1),
  worktreePath: z.string().nullable(),
  headCommit: GitHashSchema.nullable(),
  state: CandidateStateSchema,
  gateReport: GateReportSchema.nullable(),
  /** Why this candidate ended where it did. Present for DISCARDED candidates; a run whose
   *  candidates all fail identically is otherwise indistinguishable from infrastructure noise. */
  error: z.string().nullable().default(null),
  transcriptRef: ArtifactRefSchema.nullable(),
  diffRef: ArtifactRefSchema.nullable(),
  /** The parts a NEEDS_SPLIT candidate proposed; the council plans from them. */
  splitRequest: SplitRequestSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Candidate = z.infer<typeof CandidateSchema>;

/** A candidate may be reviewed by LLMs only after it passed deterministic gates. */
export function eligibleForReview(candidate: Candidate): boolean {
  return candidate.state === "PASSED_GATES" || candidate.state === "WINNER";
}
