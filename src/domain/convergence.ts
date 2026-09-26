import { z } from "zod";
import { GitHashSchema, IdSchema, ModelRefSchema, TimestampSchema } from "./common.js";
import { ReviewAxisSchema } from "./finding.js";

/**
 * A clean round belongs to one checkpoint hash. Rounds for other hashes are simply not
 * counted, so any code change (integration, simplification, rollback) resets convergence.
 */
/** What became of each finding, by what decided it; see `tallyDispositions`. */
export const DispositionTallySchema = z.object({
  total: z.number().int().nonnegative(),
  demonstrated: z.number().int().nonnegative(),
  refuted: z.number().int().nonnegative(),
  /** Advisory findings a debate judged out of scope; nothing executed. */
  dismissed: z.number().int().nonnegative(),
  /** Findings no execution settled, counted by the reason. */
  notExamined: z.record(z.string(), z.number().int().nonnegative()),
  duplicate: z.number().int().nonnegative(),
  noted: z.number().int().nonnegative(),
  /** Not yet decided either way. */
  open: z.number().int().nonnegative(),
});
export type DispositionTally = z.infer<typeof DispositionTallySchema>;

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
  /** The checkpoint's findings by disposition; absent on rounds recorded before it existed. */
  dispositions: DispositionTallySchema.optional(),
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
  "test_only_verification_treadmill",
  "no_progress",
  "disagreement_not_shrinking",
  "task_graph_growth_from_nonblocking",
]);
export type Pathology = z.infer<typeof PathologySchema>;

/** Stable total order for detector results and action ties. */
export const PATHOLOGY_ORDER: readonly Pathology[] = PathologySchema.options;

export const PATHOLOGY_DECISION_VERSION = 1;

export const C2StrategyActionSchema = z.enum(["CHANGE_ENSEMBLE", "ROLLBACK", "NEEDS_HUMAN", "BUDGET_STOP"]);
export type C2StrategyAction = z.infer<typeof C2StrategyActionSchema>;

export type CheckpointChangeClassification =
  | "production"
  | "test_only"
  | "metadata_only"
  | "unknown";

export interface CheckpointChangeRecord {
  taskId: string;
  parentHash: string;
  headHash: string;
  paths: string[];
  classification: CheckpointChangeClassification;
  causalEventId: string;
}
