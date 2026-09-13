import { modelRefKey, type ModelRef } from "../domain/common.js";
import { GLOBAL_MODEL_OBSERVATIONS_RUN_ID } from "../domain/event.js";
import type { NewEvent } from "../domain/event.js";
import { SYSTEM_ACTOR } from "../domain/common.js";
import { PolishError } from "../shared/errors.js";
import { id } from "../shared/ids.js";
import type { Db } from "../store/db.js";
import type { EventLog } from "../store/eventLog.js";
import type { ModelCatalog } from "./catalog.js";
import {
  EMPIRICAL_SCORE_RESPONSE_SCHEMA,
  PROGRESS_SCORE_RESPONSE_SCHEMA,
  REVIEW_FINDINGS_RESPONSE_SCHEMA,
} from "./responseSchemas.js";
import { hashJson } from "../shared/hash.js";

export const DEFAULT_MIN_SCORES_FOR_ROUTING = 3;

export interface ObservationRestoreOptions {
  minScoresForRouting?: number;
}

export interface ModelObservationRepositoryOptions {
  minScoresForRouting?: number;
}

export type ModelObservation =
  | {
      id: string;
      kind: "call";
      model: ModelRef;
      observedAt: number;
      outcome: { ok: boolean; latencyMs: number; errorKind?: string };
    }
  | {
      id: string;
      kind: "quality";
      model: ModelRef;
      observedAt: number;
      quality: number;
    }
  | {
      id: string;
      kind: "audition";
      model: ModelRef;
      observedAt: number;
      taskId: string;
      score: number;
      detail?: string;
    }
  | {
      id: string;
      kind: "strict_probe";
      model: ModelRef;
      observedAt: number;
      schema: "review" | "score" | "progress";
      schemaHash: string;
      supported: boolean;
      detail?: string;
    };

export interface ModelObservationStore {
  db: Db;
  events: EventLog;
}

/**
 * Global historical observations are event-sourced and replayed across runs. Per-run usage
 * restoration therefore cannot delete or replace model quality/call history accumulated by
 * other runs.
 */
export class ModelObservationRepository {
  private readonly minScoresForRouting: number;

  constructor(
    private readonly store: ModelObservationStore,
    options: ModelObservationRepositoryOptions = {},
  ) {
    this.minScoresForRouting = options.minScoresForRouting ?? DEFAULT_MIN_SCORES_FOR_ROUTING;
  }

  recordCall(
    model: ModelRef,
    outcome: { ok: boolean; latencyMs: number; errorKind?: string; at: number },
    runId: string = GLOBAL_MODEL_OBSERVATIONS_RUN_ID,
  ): ModelObservation {
    const observation: ModelObservation = {
      id: id("mobs", outcome.at),
      kind: "call",
      model,
      observedAt: outcome.at,
      outcome: {
        ok: outcome.ok,
        latencyMs: outcome.latencyMs,
        ...(outcome.errorKind === undefined ? {} : { errorKind: outcome.errorKind }),
      },
    };
    this.record(observation, runId);
    return observation;
  }

  recordQuality(model: ModelRef, quality: number, observedAt: number): ModelObservation {
    const observation: ModelObservation = {
      id: id("mobs", observedAt),
      kind: "quality",
      model,
      observedAt,
      quality: Math.min(1, Math.max(0, quality)),
    };
    this.record(observation);
    return observation;
  }

  recordAudition(
    model: ModelRef,
    input: { taskId: string; score: number; detail?: string; at: number },
  ): ModelObservation {
    if (!Number.isFinite(input.score)) {
      throw new PolishError("INVALID_ARGUMENT", "audition score must be finite", {
        taskId: input.taskId,
        score: input.score,
      });
    }
    const observation: ModelObservation = {
      id: id("mobs", input.at),
      kind: "audition",
      model,
      observedAt: input.at,
      taskId: input.taskId,
      score: Math.min(1, Math.max(0, input.score)),
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    };
    this.record(observation);
    return observation;
  }

  recordStrictProbe(
    model: ModelRef,
    input: {
      schema: "review" | "score" | "progress";
      schemaHash: string;
      supported: boolean;
      detail?: string;
      at: number;
    },
  ): ModelObservation {
    const observation: ModelObservation = {
      id: id("mobs", input.at),
      kind: "strict_probe",
      model,
      observedAt: input.at,
      schema: input.schema,
      schemaHash: input.schemaHash,
      supported: input.supported,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    };
    this.record(observation);
    return observation;
  }

  latestStrictProbe(
    model: ModelRef,
    schema: "review" | "score" | "progress",
    schemaHash: string,
  ): Extract<ModelObservation, { kind: "strict_probe" }> | null {
    const matches = this.list().filter((observation): observation is Extract<ModelObservation, { kind: "strict_probe" }> =>
      observation.kind === "strict_probe" &&
      modelRefKey(observation.model) === modelRefKey(model) &&
      observation.schema === schema &&
      observation.schemaHash === schemaHash);
    return matches.at(-1) ?? null;
  }

  list(): ModelObservation[] {
    const rows = this.store.db.prepare("SELECT json FROM model_observations ORDER BY observed_at, id").all() as { json: string }[];
    return rows.map((row) => JSON.parse(row.json) as ModelObservation);
  }

  rebuild(): number {
    return this.store.events.rebuildModelObservations();
  }

  restoreCatalog(catalog: ModelCatalog, options: ObservationRestoreOptions = {}): void {
    const minScores = options.minScoresForRouting ?? this.minScoresForRouting;
    this.rebuild();
    catalog.resetCallStats();
    const observations = this.list();
    const auditionCounts = new Map<string, number>();
    for (const observation of observations) {
      if (observation.kind === "audition") {
        const key = modelRefKey(observation.model);
        auditionCounts.set(key, (auditionCounts.get(key) ?? 0) + 1);
      }
    }
    const qualityModels = new Map<string, ModelRef>();
    for (const observation of observations) {
      if (observation.kind === "quality" || observation.kind === "audition") {
        qualityModels.set(modelRefKey(observation.model), observation.model);
      }
    }
    for (const model of qualityModels.values()) catalog.resetQuality(model);
    for (const observation of observations) {
      if (observation.kind === "call") {
        catalog.recordCall(observation.model, { ...observation.outcome, at: observation.observedAt });
      } else if (observation.kind === "quality") {
        catalog.recordQuality(observation.model, observation.quality);
      } else if (
        observation.kind === "audition" &&
        (auditionCounts.get(modelRefKey(observation.model)) ?? 0) >= minScores
      ) {
        catalog.recordQuality(observation.model, observation.score);
      }
    }
    const latestStrict = new Map<string, Extract<ModelObservation, { kind: "strict_probe" }>>();
    const currentHashes = {
      review: hashJson(REVIEW_FINDINGS_RESPONSE_SCHEMA),
      score: hashJson(EMPIRICAL_SCORE_RESPONSE_SCHEMA),
      progress: hashJson(PROGRESS_SCORE_RESPONSE_SCHEMA),
    } as const;
    for (const observation of observations) {
      if (observation.kind !== "strict_probe") continue;
      if (observation.schemaHash !== currentHashes[observation.schema]) continue;
      latestStrict.set(`${modelRefKey(observation.model)}:${observation.schema}`, observation);
    }
    for (const observation of latestStrict.values()) {
      const entry = catalog.get(observation.model);
      if (entry === undefined) continue;
      catalog.upsert({
        ...entry.info,
        source: "probe",
        capabilities: {
          ...entry.info.capabilities,
          ...(observation.schema === "review"
            ? { supportsStrictReviewSchema: observation.supported }
            : observation.schema === "score"
              ? { supportsStrictScoreSchema: observation.supported }
              : { supportsStrictProgressSchema: observation.supported }),
        },
      });
    }
  }

  private record(observation: ModelObservation, runId: string = GLOBAL_MODEL_OBSERVATIONS_RUN_ID): void {
    const event: NewEvent = {
      id: id("evt", observation.observedAt),
      runId,
      ts: observation.observedAt,
      type: "model.observation.recorded",
      payload: { observation },
      causedBy: [],
      actor: SYSTEM_ACTOR,
      artifacts: [],
    };
    this.store.events.append([event]);
  }
}
