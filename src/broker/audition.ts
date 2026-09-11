import type { ModelRef } from "../domain/common.js";
import { modelRefKey } from "../domain/common.js";
import type { PolishConfig } from "../domain/config.js";
import { PolishError } from "../shared/errors.js";
import type { ModelObservation, ModelObservationRepository } from "./observations.js";
import type { CompletionRequest, CompletionResponse, ProviderAdapter } from "./types.js";

export interface AuditionTask {
  id: string;
  prompt: string;
  expected?: string;
}

export interface AuditionTaskScore {
  taskId: string;
  score: number;
  detail?: string;
}

export interface AuditionStrategy {
  readonly name: string;
  audition(model: ModelRef, tasks: readonly AuditionTask[]): Promise<AuditionTaskScore[]>;
}

export interface AuditionResult {
  model: ModelRef;
  scores: AuditionTaskScore[];
  meanScore: number | null;
}

export interface ModelAuditionerOptions {
  enabled?: boolean;
}

export type AuditionCompleter = (request: CompletionRequest) => Promise<CompletionResponse>;

export type AuditionScorer = (
  output: string,
  task: AuditionTask,
  model: ModelRef,
) => number | Promise<number>;

/**
 * Persistence coordinator. Strategies never touch Store; only this type calls recordAudition
 * onto GLOBAL_MODEL_OBSERVATIONS_RUN_ID via the observation repository.
 */
export class ModelAuditioner {
  private lastObservedAt = Number.NEGATIVE_INFINITY;
  private readonly enabled: boolean;

  constructor(
    private readonly observations: ModelObservationRepository,
    private readonly now: () => number = Date.now,
    options: ModelAuditionerOptions = {},
  ) {
    this.enabled = options.enabled ?? true;
  }

  async run(
    models: readonly ModelRef[],
    tasks: readonly AuditionTask[],
    strategy: AuditionStrategy,
  ): Promise<AuditionResult[]> {
    const seen = existingAuditionPairs(this.observations.list());
    const results: AuditionResult[] = [];
    for (const model of models) {
      const pending = tasks.filter((task) => !seen.has(pairKey(model, task.id)));
      const rawScores = pending.length === 0 ? [] : await strategy.audition(model, pending);
      const persisted: AuditionTaskScore[] = [];
      for (const score of rawScores) {
        const at = this.nextObservedAt();
        const detail = auditionDetail(strategy.name, this.enabled, score.detail);
        try {
          this.observations.recordAudition(model, {
            taskId: score.taskId,
            score: score.score,
            at,
            detail,
          });
          seen.add(pairKey(model, score.taskId));
          persisted.push({ taskId: score.taskId, score: score.score, detail });
        } catch (error) {
          if (!(error instanceof PolishError) || error.code !== "INVALID_ARGUMENT") throw error;
        }
      }
      results.push({
        model,
        scores: persisted,
        meanScore: meanFinite(persisted.map((score) => score.score)),
      });
    }
    return results;
  }

  private nextObservedAt(): number {
    const now = Math.floor(this.now());
    const at = now > this.lastObservedAt ? now : this.lastObservedAt + 1;
    this.lastObservedAt = at;
    return at;
  }
}

export class NoopAuditionStrategy implements AuditionStrategy {
  readonly name = "noop";

  audition(_model: ModelRef, _tasks: readonly AuditionTask[]): Promise<AuditionTaskScore[]> {
    return Promise.resolve([]);
  }
}

/**
 * Bounded exact-match micro-tasks. Completions are injected so production can use
 * ModelBroker.complete while unit tests inject a scripted transport.
 */
export class MicroTaskAuditionStrategy implements AuditionStrategy {
  readonly name = "micro-tasks";
  private readonly complete: AuditionCompleter;

  constructor(
    transport: Pick<ProviderAdapter, "complete"> | AuditionCompleter,
    private readonly runId: string,
    private readonly scorer: AuditionScorer = exactMatchScorer,
  ) {
    this.complete = typeof transport === "function" ? transport : (request) => transport.complete(request);
  }

  async audition(model: ModelRef, tasks: readonly AuditionTask[]): Promise<AuditionTaskScore[]> {
    const scores: AuditionTaskScore[] = [];
    for (const task of tasks) {
      const response = await this.complete({
        model,
        messages: [
          { role: "system", content: "Complete this model audition micro-task concisely." },
          { role: "user", content: task.prompt },
        ],
        temperature: 0,
        maxTokens: 64,
        metadata: {
          runId: this.runId,
          purpose: `model-audition:${task.id}`,
          role: "audition",
        },
      });
      scores.push({
        taskId: task.id,
        score: await this.scorer(response.message.content, task, model),
      });
    }
    return scores;
  }
}

export function createAuditionStrategyFromConfig(
  audition: Pick<PolishConfig["audition"], "enabled" | "strategy">,
  transport?: Pick<ProviderAdapter, "complete"> | AuditionCompleter,
  runId?: string,
  scorer?: AuditionScorer,
): AuditionStrategy {
  if (!audition.enabled || audition.strategy !== "micro-tasks") {
    return new NoopAuditionStrategy();
  }
  if (transport === undefined || runId === undefined) {
    throw new PolishError("CONFIG_ERROR", "micro-tasks audition requires a completer and run id");
  }
  return new MicroTaskAuditionStrategy(transport, runId, scorer);
}

export function exactMatchScorer(output: string, task: AuditionTask): number {
  if (task.expected === undefined) return 0;
  return output.trim().toLowerCase() === task.expected.trim().toLowerCase() ? 1 : 0;
}

function existingAuditionPairs(observations: readonly ModelObservation[]): Set<string> {
  const seen = new Set<string>();
  for (const observation of observations) {
    if (observation.kind === "audition") seen.add(pairKey(observation.model, observation.taskId));
  }
  return seen;
}

function pairKey(model: ModelRef, taskId: string): string {
  return `${modelRefKey(model)}\0${taskId}`;
}

function auditionDetail(strategyName: string, enabled: boolean, extra?: string): string {
  const provenance = `strategy=${strategyName};enabled=${enabled}`;
  return extra === undefined || extra.length === 0 ? provenance : `${provenance};${extra}`;
}

function meanFinite(scores: readonly number[]): number | null {
  const finite = scores.filter((score) => Number.isFinite(score));
  if (finite.length === 0) return null;
  return finite.reduce((sum, score) => sum + score, 0) / finite.length;
}
