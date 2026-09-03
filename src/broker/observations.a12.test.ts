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

describe("A12 global model observations", () => {
  let dir: string;
  let store: Store;
  let catalog: ModelCatalog;
  const model = { provider: "p", model: "m" };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polish-observations-a12-"));
    store = openStore({ artifactsDir: join(dir, "artifacts") });
    catalog = new ModelCatalog();
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
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("restoring one run leaves observations accumulated independently of run budgets", () => {
    const observations = new ModelObservationRepository(store);
    observations.recordQuality(model, 0, 10);
    observations.recordQuality(model, 1, 20);
    observations.recordCall(model, { ok: true, latencyMs: 100, at: 30 });
    observations.recordCall(model, { ok: false, latencyMs: 200, errorKind: "server", at: 40 });

    const runA = id("run");
    const runB = id("run");
    for (const runId of [runA, runB]) {
      store.events.append([{
        id: id("evt"),
        runId,
        ts: 50,
        type: "model.call",
        payload: {
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
          taskId: null,
        },
        causedBy: [],
        actor: { kind: "worker" },
        artifacts: [],
      }]);
    }
    const clock = new FakeClock(100);
    const budget = new BudgetTracker({ maxRunUsd: null, maxRunTokens: null, maxTaskTokens: null });
    const broker = new ModelBroker({
      store,
      clock,
      catalog,
      quota: new QuotaTracker(clock, { concurrency: 1, rpm: null }),
      budget,
      secrets: SecretStore.fromValues({}),
      observations,
    });

    broker.restore(runA);
    expect(catalog.get(model)?.stats).toMatchObject({ calls: 2, failures: 1, quality: 0.2 });
    expect(budget.snapshot(runA).runTokens).toBe(15);
    expect(budget.snapshot(runB).runTokens).toBe(0);

    observations.recordQuality(model, 1, 60);
    broker.restore(runA);
    expect(catalog.get(model)?.stats.calls).toBe(2);
    expect(catalog.get(model)?.stats.failures).toBe(1);
    expect(catalog.get(model)?.stats.quality).toBeCloseTo(0.36);
  });
});
