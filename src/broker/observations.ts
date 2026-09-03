import { modelRefKey, type ModelRef } from "../domain/common.js";
import { GLOBAL_MODEL_OBSERVATIONS_RUN_ID } from "../domain/event.js";
import type { NewEvent } from "../domain/event.js";
import { SYSTEM_ACTOR } from "../domain/common.js";
import { id } from "../shared/ids.js";
import type { Db } from "../store/db.js";
import type { EventLog } from "../store/eventLog.js";
import type { ModelCatalog } from "./catalog.js";

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
  constructor(private readonly store: ModelObservationStore) {}

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

  list(): ModelObservation[] {
    const rows = this.store.db.prepare("SELECT json FROM model_observations ORDER BY observed_at, id").all() as { json: string }[];
    return rows.map((row) => JSON.parse(row.json) as ModelObservation);
  }

  rebuild(): number {
    return this.store.events.rebuildModelObservations();
  }

  restoreCatalog(catalog: ModelCatalog): void {
    this.rebuild();
    catalog.resetCallStats();
    const observations = this.list();
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
      } else {
        catalog.recordQuality(observation.model, observation.score);
      }
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
