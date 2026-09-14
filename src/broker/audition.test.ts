import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, PolishConfigSchema } from "../domain/config.js";
import { GLOBAL_MODEL_OBSERVATIONS_RUN_ID } from "../domain/event.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { FakeClock } from "../shared/clock.js";
import { PolishError } from "../shared/errors.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { VerifierAdapter } from "../verify/sidecar.js";
import { PairwiseJudge } from "../verify/pairwise.js";
import * as debate from "../findings/debate.js";
import {
  createAuditionStrategyFromConfig,
  MicroTaskAuditionStrategy,
  ModelAuditioner,
  NoopAuditionStrategy,
} from "./audition.js";
import { ModelBroker } from "./broker.js";
import { ModelCatalog } from "./catalog.js";
import { ModelObservationRepository } from "./observations.js";
import { BudgetTracker, QuotaTracker } from "./quota.js";
import { SecretStore } from "./secrets.js";

const EMA = 0.2;

function foldQualityEma(scores: readonly number[]): number {
  let quality: number | null = null;
  for (const score of scores) {
    const q = Math.min(1, Math.max(0, score));
    quality = quality === null ? q : quality * (1 - EMA) + q * EMA;
  }
  if (quality === null) throw new Error("expected scores");
  return quality;
}

function upsertTestModel(catalog: ModelCatalog, model: { provider: string; model: string }): void {
  catalog.upsert({
    ref: model,
    displayName: model.model,
    source: "config",
    capabilities: { ...FAKE_CAPABILITIES.fast, inputCostPerM: 0, outputCostPerM: 0 },
  });
}

describe("C8 audition strategy and observations", () => {
  let dir: string;
  let store: Store;
  const model = { provider: "scripted", model: "candidate" };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polish-audition-"));
    store = openStore({ artifactsDir: join(dir, "artifacts") });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("optional matrix yields zero provider calls and an unchanged observation list", async () => {
    const provider = new ScriptedProvider("scripted", [{ name: "candidate", capabilities: FAKE_CAPABILITIES.fast }]);
    const observations = new ModelObservationRepository(store);
    const baseline = JSON.stringify(observations.list());
    const tasks = [{ id: "echo", prompt: "say ok", expected: "ok" }];
    const missingSection = PolishConfigSchema.parse({});
    const disabledMicro = PolishConfigSchema.parse({
      audition: { enabled: false, strategy: "micro-tasks" },
    });
    const enabledNoop = PolishConfigSchema.parse({
      audition: { enabled: true, strategy: "noop" },
    });

    for (const config of [missingSection, disabledMicro, enabledNoop, defaultConfig()]) {
      const strategy = createAuditionStrategyFromConfig(config.audition, provider, "run_matrix");
      expect(strategy).toBeInstanceOf(NoopAuditionStrategy);
      await new ModelAuditioner(observations).run([model], tasks, strategy);
    }

    expect(provider.calls).toEqual([]);
    expect(JSON.stringify(observations.list())).toBe(baseline);
  });

  it("scripted micro-tasks persist exact-match scores with stable task ids and purpose metadata", async () => {
    const provider = new ScriptedProvider("scripted", [{
      name: "candidate",
      capabilities: FAKE_CAPABILITIES.fast,
    }]).script("candidate", [
      { kind: "reply", content: "4" },
      { kind: "reply", content: "blue" },
      { kind: "reply", content: "anything" },
    ]);
    const observations = new ModelObservationRepository(store);
    let now = 10;
    const results = await new ModelAuditioner(observations, () => now++, { enabled: true }).run(
      [model],
      [
        { id: "arithmetic", prompt: "2+2?", expected: "4" },
        { id: "color", prompt: "Say red", expected: "red" },
        { id: "open", prompt: "Say anything" },
      ],
      new MicroTaskAuditionStrategy(provider, "run_audition"),
    );

    expect(results[0]?.meanScore).toBe(1 / 3);
    expect(provider.calls.map((call) => call.metadata.purpose)).toEqual([
      "model-audition:arithmetic",
      "model-audition:color",
      "model-audition:open",
    ]);
    expect(provider.calls.every((call) => call.metadata.runId === "run_audition")).toBe(true);
    expect(observations.list()).toMatchObject([
      { kind: "audition", taskId: "arithmetic", score: 1 },
      { kind: "audition", taskId: "color", score: 0 },
      { kind: "audition", taskId: "open", score: 0 },
    ]);
    expect(observations.list().every((row) => row.kind === "audition" && row.detail?.includes("strategy=micro-tasks"))).toBe(true);
    expect(observations.list().every((row) => row.kind === "audition" && row.detail?.includes("enabled=true"))).toBe(true);
    expect(store.events.list(GLOBAL_MODEL_OBSERVATIONS_RUN_ID, { types: ["model.observation.recorded"] })).toHaveLength(3);
    const observedAt = observations.list().map((row) => row.observedAt);
    expect(observedAt).toEqual([...observedAt].sort((a, b) => a - b));
    expect(new Set(observedAt).size).toBe(observedAt.length);
  });

  it("restoreCatalog EMA matches the quality fold once minScoresForRouting is met", async () => {
    const provider = new ScriptedProvider("scripted", [{
      name: "candidate",
      capabilities: FAKE_CAPABILITIES.fast,
    }]).script("candidate", [
      { kind: "reply", content: "yes" },
      { kind: "reply", content: "no" },
      { kind: "reply", content: "yes" },
    ]);
    const observations = new ModelObservationRepository(store, { minScoresForRouting: 3 });
    let now = 20;
    await new ModelAuditioner(observations, () => now++).run(
      [model],
      [
        { id: "a", prompt: "a", expected: "yes" },
        { id: "b", prompt: "b", expected: "yes" },
        { id: "c", prompt: "c", expected: "yes" },
      ],
      new MicroTaskAuditionStrategy(provider, "run_ema"),
    );
    const catalog = new ModelCatalog();
    upsertTestModel(catalog, model);
    observations.restoreCatalog(catalog);
    expect(catalog.get(model)?.stats.quality).toBe(foldQualityEma([1, 0, 1]));
    observations.restoreCatalog(catalog);
    expect(catalog.get(model)?.stats.quality).toBe(foldQualityEma([1, 0, 1]));
  });

  it("below minScoresForRouting persists audition rows without driving catalog quality", async () => {
    const observations = new ModelObservationRepository(store, { minScoresForRouting: 3 });
    observations.recordAudition(model, { taskId: "a", score: 1, at: 1 });
    observations.recordAudition(model, { taskId: "b", score: 0, at: 2 });
    expect(observations.list()).toHaveLength(2);
    const catalog = new ModelCatalog();
    upsertTestModel(catalog, model);
    catalog.recordQuality(model, 0.9);
    observations.restoreCatalog(catalog);
    expect(observations.list()).toHaveLength(2);
    expect(catalog.get(model)?.stats.quality).toBeNull();
  });

  it("ModelBroker.restore of another run preserves observation bytes and catalog EMA", () => {
    const observations = new ModelObservationRepository(store, { minScoresForRouting: 3 });
    observations.recordQuality(model, 0.5, 10);
    observations.recordAudition(model, { taskId: "a", score: 1, at: 11, detail: "strategy=micro-tasks;enabled=true" });
    observations.recordAudition(model, { taskId: "b", score: 0, at: 12, detail: "strategy=micro-tasks;enabled=true" });
    observations.recordAudition(model, { taskId: "c", score: 1, at: 13, detail: "strategy=micro-tasks;enabled=true" });
    const catalog = new ModelCatalog();
    upsertTestModel(catalog, model);
    observations.restoreCatalog(catalog);
    const beforeList = JSON.stringify(observations.list());
    const beforeQuality = catalog.get(model)?.stats.quality;
    const otherRun = id("run");
    store.events.append([{
      id: id("evt"),
      runId: otherRun,
      ts: 50,
      type: "model.call",
      payload: { usage: { inputTokens: 4, outputTokens: 2, costUsd: 0 }, taskId: null },
      causedBy: [],
      actor: { kind: "worker" },
      artifacts: [],
    }]);
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
    broker.restore(otherRun);
    expect(JSON.stringify(observations.list())).toBe(beforeList);
    expect(catalog.get(model)?.stats.quality).toBe(beforeQuality);
    expect(beforeQuality).toBe(foldQualityEma([0.5, 1, 0, 1]));
  });

  it("rejects non-finite audition scores before append and does not invent 1.0", () => {
    const observations = new ModelObservationRepository(store);
    expect(() => observations.recordAudition(model, { taskId: "inf", score: Number.POSITIVE_INFINITY, at: 1 })).toThrow(PolishError);
    expect(() => observations.recordAudition(model, { taskId: "nan", score: Number.NaN, at: 2 })).toThrow(PolishError);
    expect(observations.list()).toEqual([]);
    expect(observations.list().some((row) => row.kind === "audition" && row.score === 1)).toBe(false);
  });

  it("strategies are constructed without Store/Db/EventLog and only the auditioner persists", async () => {
    const provider = new ScriptedProvider("scripted", [{ name: "candidate", capabilities: FAKE_CAPABILITIES.fast }]);
    const noop = new NoopAuditionStrategy();
    const micro = new MicroTaskAuditionStrategy(provider, "run_no_store");
    expect(noop).toBeInstanceOf(NoopAuditionStrategy);
    expect(micro).toBeInstanceOf(MicroTaskAuditionStrategy);
    const src = readFileSync(fileURLToPath(new URL("./audition.ts", import.meta.url)), "utf8");
    const strategySrc = src.slice(src.indexOf("export class NoopAuditionStrategy"), src.indexOf("export function createAuditionStrategyFromConfig"));
    expect(strategySrc).not.toMatch(/\b(Store|Db|EventLog|recordAudition|recordQuality)\b/);
    const observations = new ModelObservationRepository(store);
    const recordQuality = vi.spyOn(observations, "recordQuality");
    provider.script("candidate", [{ kind: "reply", content: "ok" }]);
    await new ModelAuditioner(observations, () => 40).run(
      [model],
      [{ id: "echo", prompt: "ok", expected: "ok" }],
      micro,
    );
    expect(recordQuality).not.toHaveBeenCalled();
    expect(observations.list()).toHaveLength(1);
    expect(observations.list()[0]?.kind).toBe("audition");
  });

  it("skips provider calls when a (model, taskId) audition observation already exists", async () => {
    const provider = new ScriptedProvider("scripted", [{
      name: "candidate",
      capabilities: FAKE_CAPABILITIES.fast,
    }]).script("candidate", [{ kind: "reply", content: "ok" }]);
    const observations = new ModelObservationRepository(store);
    const auditioner = new ModelAuditioner(observations, () => 70);
    const strategy = new MicroTaskAuditionStrategy(provider, "run_skip");
    const tasks = [{ id: "echo", prompt: "ok", expected: "ok" }];
    await auditioner.run([model], tasks, strategy);
    await auditioner.run([model], tasks, strategy);
    expect(provider.calls).toHaveLength(1);
    expect(observations.list()).toHaveLength(1);
  });

  it("does not import or invoke C3/C4 scorers from a micro-task run", async () => {
    const src = readFileSync(fileURLToPath(new URL("./audition.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/VerifierAdapter|PairwiseJudge|findings\/debate|verify\/sidecar|verify\/pairwise/);
    const compareAdapter = vi.spyOn(VerifierAdapter.prototype, "comparePair");
    const compareJudge = vi.spyOn(PairwiseJudge.prototype, "comparePair");
    const debateStarted = vi.spyOn(debate, "assertDebateMayStart");
    const provider = new ScriptedProvider("scripted", [{
      name: "candidate",
      capabilities: FAKE_CAPABILITIES.fast,
    }]).script("candidate", [{ kind: "reply", content: "ok" }]);
    const observations = new ModelObservationRepository(store);
    await new ModelAuditioner(observations, () => 80).run(
      [model],
      [{ id: "echo", prompt: "ok", expected: "ok" }],
      new MicroTaskAuditionStrategy(provider, "run_no_c3"),
    );
    expect(compareAdapter).not.toHaveBeenCalled();
    expect(compareJudge).not.toHaveBeenCalled();
    expect(debateStarted).not.toHaveBeenCalled();
  });
});

/**
 * P1.5 MC5. Audition is a production model call that the happy-path pipeline never reaches, so
 * the whole-run criterion in `src/e2e/b10.test.ts` cannot see it. It sends no `reasoning`, and
 * `routing.disableReasoning` must not change that: the flag is wired to the worker and the
 * council and to nothing else.
 */
describe("audition reasoning", () => {
  it("sends no reasoning field at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-audition-reasoning-"));
    const store = openStore({ artifactsDir: join(dir, "artifacts") });
    try {
      const provider = new ScriptedProvider("scripted", [
        { name: "candidate", capabilities: FAKE_CAPABILITIES.fast },
      ]).script("candidate", [{ kind: "reply", content: "ok" }]);
      await new ModelAuditioner(new ModelObservationRepository(store), () => 1, { enabled: true }).run(
        [{ provider: "scripted", model: "candidate" }],
        [{ id: "echo", prompt: "say ok", expected: "ok" }],
        new MicroTaskAuditionStrategy(provider, "run_audition_reasoning"),
      );
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0]?.reasoning).toBeUndefined();
      expect("reasoning" in (provider.calls[0] ?? {})).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
