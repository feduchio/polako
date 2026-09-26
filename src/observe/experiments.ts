import {
  EXPERIMENT_TRIAL_EVENT,
  ExperimentTrialSchema,
  isFalseDemonstrated,
  isSilentMiss,
  type ExperimentTrial,
} from "../domain/experiment.js";
import type { Event } from "../domain/event.js";

export interface Rate {
  count: number;
  of: number;
  /** One-sided 95% upper bound on the true rate (Clopper–Pearson); about 3/n at a count of 0. */
  upper95: number;
}

export interface ArmReport {
  arm: string;
  trials: number;
  falseDemonstrated: Rate;
  silentMiss: Rate;
  /** Examined findings over validated ones, across the arm's runs. */
  examination: { examined: number; validated: number };
  tokens: number;
}

export interface ExperimentReport {
  experimentId: string;
  arms: ArmReport[];
}

/** Trials recorded in `events`, which may span many runs. */
export function trialsFrom(events: readonly Event[]): ExperimentTrial[] {
  return events
    .filter((event) => event.type === EXPERIMENT_TRIAL_EVENT)
    .flatMap((event) => {
      const parsed = ExperimentTrialSchema.safeParse(event.payload["trial"]);
      return parsed.success ? [parsed.data] : [];
    });
}

export function projectExperiment(experimentId: string, trials: readonly ExperimentTrial[]): ExperimentReport {
  const mine = trials.filter((trial) => trial.experimentId === experimentId);
  const arms = [...new Set(mine.map((trial) => trial.arm))].sort();
  return {
    experimentId,
    arms: arms.map((arm) => {
      const own = mine.filter((trial) => trial.arm === arm);
      const correct = own.filter((trial) => trial.side === "correct");
      const defect = own.filter((trial) => trial.side === "defect");
      return {
        arm,
        trials: own.length,
        falseDemonstrated: rate(correct.filter(isFalseDemonstrated).length, correct.length),
        silentMiss: rate(defect.filter(isSilentMiss).length, defect.length),
        examination: {
          examined: own.reduce((sum, trial) => sum + trial.examined, 0),
          validated: own.reduce((sum, trial) => sum + trial.validated, 0),
        },
        tokens: own.reduce((sum, trial) => sum + trial.tokens, 0),
      };
    }),
  };
}

function rate(count: number, of: number): Rate {
  return { count, of, upper95: binomialUpperBound(count, of, 0.95) };
}

/**
 * Exact one-sided upper confidence bound for a binomial proportion: the p at which seeing `count`
 * or fewer in `of` trials has probability 1 - confidence. At count 0 it is 1 - (1-c)^(1/n).
 */
export function binomialUpperBound(count: number, of: number, confidence: number): number {
  if (of === 0) return 1;
  if (count >= of) return 1;
  const alpha = 1 - confidence;
  let lo = count / of;
  let hi = 1;
  for (let step = 0; step < 60; step += 1) {
    const mid = (lo + hi) / 2;
    if (binomialCdf(count, of, mid) > alpha) lo = mid;
    else hi = mid;
  }
  return hi;
}

function binomialCdf(k: number, n: number, p: number): number {
  let term = (1 - p) ** n;
  let sum = term;
  for (let i = 1; i <= k; i += 1) {
    term *= ((n - i + 1) / i) * (p / (1 - p));
    sum += term;
  }
  return Math.min(1, sum);
}

export function renderExperiment(report: ExperimentReport): string {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const lines = [`Experiment ${report.experimentId}`];
  for (const arm of report.arms) {
    lines.push(
      `- ${arm.arm}: ${String(arm.trials)} trials; ` +
        `false demonstrated ${String(arm.falseDemonstrated.count)}/${String(arm.falseDemonstrated.of)} (≤ ${pct(arm.falseDemonstrated.upper95)} at 95%); ` +
        `silent miss ${String(arm.silentMiss.count)}/${String(arm.silentMiss.of)} (≤ ${pct(arm.silentMiss.upper95)} at 95%); ` +
        `examined ${String(arm.examination.examined)}/${String(arm.examination.validated)} validated findings; ${String(arm.tokens)} tokens`,
    );
  }
  return lines.join("\n");
}
