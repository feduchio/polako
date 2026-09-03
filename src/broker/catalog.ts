import { modelRefKey, type ModelRef } from "../domain/common.js";
import type { ModelInfo, ProviderAdapter } from "./types.js";

export interface ModelStats {
  calls: number;
  failures: number;
  /** exponential moving average of latency */
  latencyMs: number;
  /** outcome quality signals fed back by the engine (gate pass rate etc.), 0..1 EMA; null until observed */
  quality: number | null;
  lastErrorKind: string | null;
  lastUsedAt: number | null;
}

export interface CatalogEntry {
  info: ModelInfo;
  stats: ModelStats;
  /** provider currently healthy */
  available: boolean;
}

export interface CatalogDiscoveryOptions {
  signal?: AbortSignal;
  /** Optional active verifier; concrete provider probes are injected to keep broker provider-agnostic. */
  capabilityProbe?: (adapter: ProviderAdapter, model: ModelInfo) => Promise<ModelInfo>;
}

const EMA = 0.2;

/**
 * Union of models advertised by providers and declared in config, with observed statistics.
 * Stats are rebuilt from `model.call` events on startup (see ModelBroker.restoreStats).
 */
export class ModelCatalog {
  private readonly entries = new Map<string, CatalogEntry>();
  private readonly providers = new Map<string, ProviderAdapter>();
  private readonly providerAvailable = new Map<string, boolean>();

  register(adapter: ProviderAdapter): void {
    this.providers.set(adapter.id, adapter);
    this.providerAvailable.set(adapter.id, true);
  }

  provider(id: string): ProviderAdapter | undefined {
    return this.providers.get(id);
  }

  providerIds(): string[] {
    return [...this.providers.keys()];
  }

  async refresh(signal?: AbortSignal): Promise<{ discovered: number; errors: Record<string, string> }> {
    return this.discover(signal === undefined ? {} : { signal });
  }

  async discover(options: CatalogDiscoveryOptions = {}): Promise<{ discovered: number; errors: Record<string, string> }> {
    let discovered = 0;
    const errors: Record<string, string> = {};
    for (const [id, adapter] of this.providers) {
      try {
        const models = await adapter.listModels(options.signal);
        for (const model of models) {
          if (options.capabilityProbe === undefined) {
            this.upsert(model);
            continue;
          }
          try {
            this.upsert(await options.capabilityProbe(adapter, model));
          } catch (error) {
            errors[`${id}/${model.ref.model}:probe`] = error instanceof Error ? error.message : String(error);
            this.upsert(model);
          }
        }
        discovered += models.length;
        this.providerAvailable.set(id, true);
      } catch (err) {
        errors[id] = err instanceof Error ? err.message : String(err);
        this.providerAvailable.set(id, false);
      }
    }
    return { discovered, errors };
  }

  upsert(info: ModelInfo): CatalogEntry {
    const key = modelRefKey(info.ref);
    const existing = this.entries.get(key);
    const entry: CatalogEntry = {
      info,
      stats: existing?.stats ?? { calls: 0, failures: 0, latencyMs: 0, quality: null, lastErrorKind: null, lastUsedAt: null },
      available: this.providerAvailable.get(info.ref.provider) ?? true,
    };
    this.entries.set(key, entry);
    return entry;
  }

  get(ref: ModelRef): CatalogEntry | undefined {
    const e = this.entries.get(modelRefKey(ref));
    if (!e) return undefined;
    return { ...e, available: this.providerAvailable.get(ref.provider) ?? false };
  }

  list(): CatalogEntry[] {
    return [...this.entries.values()].map((e) => ({ ...e, available: this.providerAvailable.get(e.info.ref.provider) ?? false }));
  }

  setProviderAvailable(providerId: string, available: boolean): void {
    this.providerAvailable.set(providerId, available);
  }

  recordCall(ref: ModelRef, outcome: { ok: boolean; latencyMs: number; errorKind?: string; at: number }): void {
    const e = this.entries.get(modelRefKey(ref));
    if (!e) return;
    e.stats.calls++;
    if (!outcome.ok) {
      e.stats.failures++;
      e.stats.lastErrorKind = outcome.errorKind ?? "unknown";
    }
    e.stats.latencyMs = e.stats.calls === 1 ? outcome.latencyMs : e.stats.latencyMs * (1 - EMA) + outcome.latencyMs * EMA;
    e.stats.lastUsedAt = outcome.at;
  }

  /** Zero observed call stats (used by ModelBroker.restore before replaying events). */
  resetCallStats(resetQuality = false): void {
    for (const e of this.entries.values()) {
      e.stats = {
        calls: 0,
        failures: 0,
        latencyMs: 0,
        quality: resetQuality ? null : e.stats.quality,
        lastErrorKind: null,
        lastUsedAt: null,
      };
    }
  }

  resetQuality(ref: ModelRef): void {
    const entry = this.entries.get(modelRefKey(ref));
    if (entry) entry.stats.quality = null;
  }

  /** Feed back an outcome quality signal in 0..1 (e.g. candidate passed gates = 1, failed = 0). */
  recordQuality(ref: ModelRef, quality: number): void {
    const e = this.entries.get(modelRefKey(ref));
    if (!e) return;
    const q = Math.min(1, Math.max(0, quality));
    e.stats.quality = e.stats.quality === null ? q : e.stats.quality * (1 - EMA) + q * EMA;
  }
}
