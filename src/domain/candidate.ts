import { z } from "zod";
import type { TransitionTable } from "./fsm.js";
import { CheckResultSchema } from "./checks.js";
import { ArtifactRefSchema, GitHashSchema, IdSchema, ModelRefSchema, TimestampSchema } from "./common.js";

export const CandidateStateSchema = z.enum([
  "CREATED",
  "IMPLEMENTING",
  "IMPLEMENTED",
  "GATING",
  "PASSED_GATES",
  "FAILED_GATES",
  "WINNER",
  "LOSER",
  "DISCARDED",
  "INTERRUPTED",
]);
export type CandidateState = z.infer<typeof CandidateStateSchema>;

export const CANDIDATE_TABLE: TransitionTable<CandidateState> = {
  initial: "CREATED",
  states: CandidateStateSchema.options,
  terminal: ["FAILED_GATES", "WINNER", "LOSER", "DISCARDED"],
  edges: {
    CREATED: ["IMPLEMENTING", "DISCARDED"],
    IMPLEMENTING: ["IMPLEMENTED", "INTERRUPTED", "DISCARDED"],
    INTERRUPTED: ["CREATED", "DISCARDED"],
    IMPLEMENTED: ["GATING", "DISCARDED"],
    GATING: ["PASSED_GATES", "FAILED_GATES", "INTERRUPTED"],
    PASSED_GATES: ["WINNER", "LOSER", "DISCARDED"],
    FAILED_GATES: [],
    WINNER: [],
    LOSER: [],
    DISCARDED: [],
  },
};

export const GateFailureReasonSchema = z.enum([
  "mandatory_check_failed",
  "regression_vs_baseline",
  "protected_path_modified",
  "test_silencing_detected",
  "config_weakened",
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
  transcriptRef: ArtifactRefSchema.nullable(),
  diffRef: ArtifactRefSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Candidate = z.infer<typeof CandidateSchema>;

/** A candidate may be reviewed by LLMs only after it passed deterministic gates. */
export function eligibleForReview(candidate: Candidate): boolean {
  return candidate.state === "PASSED_GATES" || candidate.state === "WINNER";
}
