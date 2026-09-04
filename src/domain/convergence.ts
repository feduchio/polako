import { z } from "zod";
import { GitHashSchema, IdSchema, ModelRefSchema, TimestampSchema } from "./common.js";
import { ReviewAxisSchema } from "./finding.js";

/**
 * A clean round belongs to one checkpoint hash. Rounds for other hashes are simply not
 * counted, so any code change (integration, simplification, rollback) resets convergence.
 */
export const CleanRoundSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  checkpointHash: GitHashSchema,
  roundIndex: z.number().int().positive(),
  /**
   * Review-swarm round that proves this clean round. Optional so historical events
   * remain readable; anti-fake-DONE rejects absence.
   */
  reviewRoundIndex: z.number().int().positive().optional(),
  axes: z.array(ReviewAxisSchema).min(1),
  ensemble: z.array(ModelRefSchema).min(1),
  rawFindings: z.number().int().nonnegative(),
  /** must be zero by definition of a clean round */
  validatedBlocking: z.literal(0),
  /** whether the ensemble/axes differed from previous clean rounds for this checkpoint */
  novel: z.boolean(),
  createdAt: TimestampSchema,
});
export type CleanRound = z.infer<typeof CleanRoundSchema>;

export function cleanRoundsFor(rounds: readonly CleanRound[], checkpointHash: string): CleanRound[] {
  return rounds.filter((r) => r.checkpointHash === checkpointHash).sort((a, b) => a.roundIndex - b.roundIndex);
}

export function hasConverged(rounds: readonly CleanRound[], checkpointHash: string, required: number): boolean {
  return cleanRoundsFor(rounds, checkpointHash).length >= required;
}

/**
 * Novelty is a soft preference: a round is novel if its ensemble or axes differ from every
 * previous clean round on the same checkpoint. Non-novel rounds still count; the engine
 * records the lack of novelty so the report can say so.
 */
export function isNovelRound(
  previous: readonly CleanRound[],
  round: Pick<CleanRound, "checkpointHash" | "axes" | "ensemble">,
): boolean {
  const key = (axes: readonly string[], ens: readonly { provider: string; model: string }[]): string =>
    JSON.stringify({ a: [...axes].sort(), e: ens.map((m) => `${m.provider}:${m.model}`).sort() });
  const mine = key(round.axes, round.ensemble);
  return !cleanRoundsFor(previous, round.checkpointHash).some((r) => key(r.axes, r.ensemble) === mine);
}

export const PathologySchema = z.enum([
  "finding_oscillation",
  "checkpoint_oscillation",
  "no_progress",
  "disagreement_not_shrinking",
  "task_graph_growth_from_nonblocking",
]);
export type Pathology = z.infer<typeof PathologySchema>;
