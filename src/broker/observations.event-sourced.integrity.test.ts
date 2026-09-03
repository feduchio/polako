import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { ModelBroker } from "./broker.js";
import { ModelCatalog } from "./catalog.js";
import { ModelObservationRepository } from "./observations.js";
import { BudgetTracker, QuotaTracker } from "./quota.js";
import { SecretStore } from "./secrets.js";

describe("model observations event-sourced integrity", () => {
  let dir: string;
  let store: Store;
  const model = { provider: "p", model: "m" };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polish-obs-events-"));
    store = openStore({ home: dir });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rebuilds global observations across runs and preserves quality through restore ordering", () => {
    const observations = new ModelObservationRepository(store);
    observations.recordQuality(model, 0.8, 10);
    observations.recordCall(model, { ok: true, latencyMs: 50, at: 20 });
    expect(store.events.list(id("run"), { types: ["model.observation.recorded"] })).toHaveLength(0);

    store.db.prepare("DELETE FROM model_observations").run();
    expect(observations.list()).toHaveLength(0);
    expect(store.events.rebuildModelObservations()).toBe(2);
    expect(observations.list()).toHaveLength(2);

    const runA = id("run");
    const runB = id("run");
    for (const runId of [runA, runB]) {
      store.events.append([{
        id: id("evt"),
        runId,
        ts: 30,
        type: "model.call",
        payload: { usage: { inputTokens: 5, outputTokens: 5, costUsd: 0.01 }, taskId: null },
        causedBy: [],
        actor: { kind: "worker" },
        artifacts: [],
      }]);
    }

    const catalog = new ModelCatalog();
    catalog.upsert({
      ref: model,
      displayName: "m",
      source: "config",
      capabilities: {
        contextWindow: 10_000,
        maxOutputTokens: 1_000,
        supportsTools: true,
        supportsJson: true,
        inputCostPerM: null,
        outputCostPerM: null,
        tier: "strong",
        family: "test",
      },
    });
    const clock = new FakeClock(100);
    const broker = new ModelBroker({
      store,
      clock,
      catalog,
      quota: new QuotaTracker(clock, { concurrency: 1, rpm: null }),
      budget: new BudgetTracker({ maxRunUsd: null, maxRunTokens: null, maxTaskTokens: null }),
      secrets: SecretStore.fromValues({}),
      observations,
    });

    broker.restore(runB);
    expect(catalog.get(model)?.stats.quality).toBeCloseTo(0.8);
    expect(catalog.get(model)?.stats.calls).toBe(1);

    catalog.resetCallStats();
    catalog.resetQuality(model);
    broker.restore(runA);
    expect(catalog.get(model)?.stats.quality).toBeCloseTo(0.8);
    expect(catalog.get(model)?.stats.calls).toBe(1);

    store.close();
    store = openStore({ home: dir });
    expect(new ModelObservationRepository(store).list()).toHaveLength(2);
  });
});
