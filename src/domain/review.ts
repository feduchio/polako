import { z } from "zod";
import { GitHashSchema, IdSchema, ModelRefSchema, TimestampSchema } from "./common.js";
import { RawFindingSchema, ReviewAxisSchema, type ReviewAxis } from "./finding.js";

/** Default review axes; config may extend the set in future strategy fields. */
export const DEFAULT_REVIEW_AXES: readonly ReviewAxis[] = ["correctness", "regression", "adversarial"];

export function reviewAxesForRound(reviewersPerRound: number, extraAxes: readonly ReviewAxis[] = []): ReviewAxis[] {
  const axes = [...new Set([...DEFAULT_REVIEW_AXES, ...extraAxes])];
  if (axes.length < DEFAULT_REVIEW_AXES.length) {
    throw new RangeError("review requires at least correctness, regression, and adversarial axes");
  }
  return Array.from({ length: reviewersPerRound }, (_, index) => {
    const axis = axes[index % axes.length];
    if (axis === undefined) throw new RangeError("review axis selection failed");
    return axis;
  });
}

/** One independent reviewer execution against a checkpoint. */
export const ReviewExecutionSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  checkpointHash: GitHashSchema,
  roundIndex: z.number().int().positive(),
  axis: ReviewAxisSchema,
  requestedModel: ModelRefSchema,
  completed: z.boolean(),
  findings: z.array(RawFindingSchema),
  /** sha256 of the fenced user prompt (isolation / replay checks) */
  promptDigest: z.string().min(1).optional(),
  error: z.string().optional(),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
});
export type ReviewExecution = z.infer<typeof ReviewExecutionSchema>;

export function reviewRoundExecutions(
  executions: readonly ReviewExecution[],
  checkpointHash: string,
  roundIndex: number,
): ReviewExecution[] {
  return executions
    .filter((execution) => execution.checkpointHash === checkpointHash && execution.roundIndex === roundIndex)
    .sort((a, b) => a.startedAt - b.startedAt);
}

export function isReviewRoundComplete(
  executions: readonly ReviewExecution[],
  checkpointHash: string,
  roundIndex: number,
  required: number,
): boolean {
  const round = reviewRoundExecutions(executions, checkpointHash, roundIndex);
  return round.filter((execution) => execution.completed).length >= required;
}

export function currentReviewRoundIndex(
  executions: readonly ReviewExecution[],
  required: number,
  checkpointHash?: string,
): number {
  const scoped = checkpointHash === undefined
    ? executions
    : executions.filter((execution) => execution.checkpointHash === checkpointHash);
  if (scoped.length === 0) return 1;
  const byRound = new Map<number, ReviewExecution[]>();
  for (const execution of scoped) {
    const list = byRound.get(execution.roundIndex) ?? [];
    list.push(execution);
    byRound.set(execution.roundIndex, list);
  }
  const maxRound = Math.max(...byRound.keys());
  const latest = byRound.get(maxRound) ?? [];
  if (latest.filter((execution) => execution.completed).length >= required) return maxRound + 1;
  return maxRound;
}

export function assertExecutionCheckpoint(execution: Pick<ReviewExecution, "checkpointHash">, expected: string): void {
  if (execution.checkpointHash !== expected) {
    throw new Error(`review execution checkpoint ${execution.checkpointHash} does not match expected ${expected}`);
  }
}
