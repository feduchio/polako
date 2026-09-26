import { z } from "zod";
import { IdSchema } from "./common.js";

export const EXPERIMENT_TRIAL_EVENT = "experiment.trial_recorded";

/**
 * One run of one side of a paired fixture, judged afterwards by the pair's oracle on the run's own
 * final code. Recorded on that run, so the store is the experiment's only record.
 */
export const ExperimentTrialSchema = z.object({
  experimentId: z.string().min(1),
  /** The variant under test (a model, a config, an advisor on or off). */
  arm: z.string().min(1),
  pairId: z.string().min(1),
  side: z.enum(["correct", "defect"]),
  runId: IdSchema,
  phase: z.string().min(1),
  terminalCode: z.string().nullable(),
  /** Blocking findings the engine demonstrated during the run. */
  demonstratedBlocking: z.number().int().nonnegative(),
  /** Findings settled by an execution (demonstrated or refuted), and all findings validated. */
  examined: z.number().int().nonnegative(),
  validated: z.number().int().nonnegative(),
  /** Whether the oracle passes on the run branch; null when the branch could not be read. */
  oraclePassed: z.boolean().nullable(),
  tokens: z.number().int().nonnegative(),
});
export type ExperimentTrial = z.infer<typeof ExperimentTrialSchema>;

/**
 * Correct code that ended with a demonstrated blocking finding: the engine "proved" a defect that
 * is not there.
 */
export function isFalseDemonstrated(trial: ExperimentTrial): boolean {
  return trial.side === "correct" && trial.demonstratedBlocking > 0;
}

/**
 * A planted defect that ended DONE with the defect still in the code, under any code but the one
 * that says a blocking finding was left unexamined: `converged` and `no_change_required` both
 * claim the code is right.
 */
export function isSilentMiss(trial: ExperimentTrial): boolean {
  return trial.side === "defect" && trial.phase === "DONE" && trial.terminalCode !== "converged_with_unexamined" && trial.oraclePassed === false;
}
