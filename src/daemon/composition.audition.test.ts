import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, PolishConfigSchema, type PolishConfig } from "../domain/config.js";
import type { PhaseContext } from "../engine/types.js";
import { ProviderError, type ModelCapabilities } from "../broker/types.js";
import { FAKE_CAPABILITIES, reply, ScriptedProvider } from "../providers/scripted.js";
import { Scheduler } from "../scheduler/index.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { PairwiseJudge } from "../verify/pairwise.js";
import { VerifierAdapter } from "../verify/sidecar.js";
import * as debate from "../findings/debate.js";
import {
  buildProductionDeps,
  createDiscoveringModelsDriverFromCatalog,
  installProductionDrivers,
  strictProbeEpochComplete,
} from "./composition.js";
import { RunEngine } from "../engine/engine.js";
import { ModelObservationRepository } from "../broker/observations.js";
import { hashJson } from "../shared/hash.js";
import { EMPIRICAL_SCORE_RESPONSE_SCHEMA, REVIEW_FINDINGS_RESPONSE_SCHEMA } from "../broker/responseSchemas.js";

const FREE = { ...FAKE_CAPABILITIES.fast, inputCostPerM: 0, outputCostPerM: 0, supportsJson: true, supportsTools: true };

function discoveryProvider(models: { name: string; capabilities: ModelCapabilities }[]): ScriptedProvider {
  return new ScriptedProvider("scripted", models, {
    fallback: {
      kind: "fn",
      fn: (request) => {
        if (request.metadata.purpose.startsWith("model-audition:")) return reply("ok");
        if (request.metadata.purpose === "capability_probe_json") return reply('{"probe":"ok"}');
        return reply("", 10, 5, null, [{ id: "t1", name: "probe_ping", arguments: "{}" }]);
      },
    },
  });
}

function phaseContext(store: Store, clock: FakeClock, config: PolishConfig): PhaseContext {
  return {
    run: {
      id: id("run", clock.now()),
      missionId: id("msn", clock.now()),
      projectPath: "/repo",
      runBranch: "polish/run",
      phase: "DISCOVERING_MODELS",
      control: "RUNNING",
      currentCheckpointHash: "a".repeat(40),
      baselineId: null,
      interpretationId: null,
      createdAt: clock.now(),
      updatedAt: clock.now(),
      terminalReason: null,
    },
    store,
    scheduler: new Scheduler(store, clock, { workerId: "w1", laneLimits: config.lanes, leaseMs: 60_000 }),
    clock,
    config,
  };
}

function auditionCalls(provider: ScriptedProvider): typeof provider.calls {
  return provider.calls.filter((call) => call.metadata.purpose.startsWith("model-audition:"));
}

describe("production DISCOVERING_MODELS audition wiring", () => {
  let dir: string;
  let store: Store;
  let clock: FakeClock;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polish-c8-discover-"));
    store = openStore({ artifactsDir: join(dir, "artifacts") });
    clock = new FakeClock(1_700_000_000_000);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("disabled and noop production paths make zero model-audition calls", async () => {
    for (const config of [
      defaultConfig(),
      PolishConfigSchema.parse({ audition: { enabled: false, strategy: "micro-tasks" } }),
      PolishConfigSchema.parse({ audition: { enabled: true, strategy: "noop" } }),
    ]) {
      const provider = discoveryProvider([{ name: "free", capabilities: FREE }]);
      const deps = buildProductionDeps({
        store,
        clock,
        config,
        home: join(dir, "home"),
        providers: [provider],
      });
      const ctx = phaseContext(store, clock, config);
      await createDiscoveringModelsDriverFromCatalog(deps)(ctx);
      expect(auditionCalls(provider)).toEqual([]);
      expect(strictProbeEpochComplete(deps, ctx)).toBe(true);
      expect(new ModelObservationRepository(store).list().filter((row) => row.kind === "strict_probe")).toHaveLength(3);
    }
  });

  /**
   * Both `routing.disableReasoning` arms (P1.5 MC5/AC5a). Audition is a production model call the
   * B10 pipeline never reaches, because audition is off by default, and a check that builds
   * `MicroTaskAuditionStrategy` directly never sees `brokerAuditionTransport`: the entry-gate lane
   * threaded the flag through that transport and every check passed.
   */
  it.each([
    { arm: "default", disableReasoning: false },
    { arm: "disabled", disableReasoning: true },
  ])("enabled micro-tasks invoke the auditioner through the broker and skip a second pass ($arm reasoning)", async ({ disableReasoning }) => {
    const config = PolishConfigSchema.parse({
      audition: {
        enabled: true,
        strategy: "micro-tasks",
        minScoresForRouting: 1,
        maxModels: 2,
        maxTasks: 1,
        tasks: [{ id: "echo", prompt: "Reply with exactly: ok", expected: "ok" }],
      },
      ...(disableReasoning ? { routing: { disableReasoning: true } } : {}),
    });
    expect(config.routing.disableReasoning).toBe(disableReasoning);
    const provider = discoveryProvider([{ name: "free", capabilities: FREE }]);
    const deps = buildProductionDeps({
      store,
      clock,
      config,
      home: join(dir, "home"),
      providers: [provider],
    });
    const engine = new RunEngine(
      { store, clock, scheduler: new Scheduler(store, clock, { workerId: "w1", laneLimits: config.lanes, leaseMs: 60_000 }), config, assertProjectClean: () => undefined },
      false,
    );
    installProductionDrivers(engine, deps);
    const ctx = phaseContext(store, clock, config);
    const installed = engine.getRegisteredDriver("DISCOVERING_MODELS");
    expect(installed).toBeDefined();
    await installed!(ctx);
    const first = auditionCalls(provider);
    const strictCalls = provider.calls.filter((call) => call.metadata.purpose.startsWith("capability_probe_strict_")).length;
    expect(first).toHaveLength(1);
    expect(first[0]?.metadata.purpose).toBe("model-audition:echo");
    expect(first[0]?.metadata.runId).toBe(ctx.run.id);
    // The flag is wired to the worker and the council and to nothing else, so this request is
    // the same in both arms.
    expect(first[0]?.reasoning).toBeUndefined();
    expect("reasoning" in (first[0] ?? {})).toBe(false);
    await installed!(ctx);
    expect(auditionCalls(provider)).toHaveLength(first.length);
    expect(provider.calls.filter((call) => call.metadata.purpose.startsWith("capability_probe_strict_"))).toHaveLength(strictCalls);
  });

  it("derives probe-epoch completeness from persisted shortlist records", () => {
    const config = defaultConfig();
    const provider = discoveryProvider([
      { name: "inside", capabilities: FREE },
      { name: "outside", capabilities: FREE },
    ]);
    const deps = buildProductionDeps({
      store,
      clock,
      config,
      home: join(dir, "home"),
      providers: [provider],
    });
    const ctx = phaseContext(store, clock, config);
    const reviewSchemaHash = hashJson(REVIEW_FINDINGS_RESPONSE_SCHEMA);
    const scoreSchemaHash = hashJson(EMPIRICAL_SCORE_RESPONSE_SCHEMA);
    const observations = new ModelObservationRepository(store);
    const inside = { provider: provider.id, model: "inside" };
    expect(strictProbeEpochComplete(deps, ctx)).toBe(false);
    observations.recordStrictProbe(inside, {
      schema: "review",
      schemaHash: reviewSchemaHash,
      supported: false,
      at: clock.now(),
    });
    store.events.append([{
      id: id("evt", clock.now()),
      runId: ctx.run.id,
      ts: clock.now(),
      type: "strict_probes.completed",
      payload: {
        shortlisted: [inside],
        reviewSchemaHash,
        scoreSchemaHash,
      },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    }]);
    expect(strictProbeEpochComplete(deps, ctx)).toBe(false);
    observations.recordStrictProbe(inside, {
      schema: "score",
      schemaHash: scoreSchemaHash,
      supported: false,
      at: clock.now() + 1,
    });
    expect(strictProbeEpochComplete(deps, ctx)).toBe(true);
  });

  it("persists strict probe failures as unsupported and routes from that state", async () => {
    const config = defaultConfig();
    const provider = new ScriptedProvider(
      "scripted",
      [{ name: "free", capabilities: FREE }],
      { autoStrictProbes: false },
    );
    provider.script("free", [
      { kind: "reply", content: "", toolCalls: [{ id: "t", name: "probe_ping", arguments: "{}" }] },
      { kind: "error", error: new ProviderError("scripted", "bad_request", "strict review rejected") },
      { kind: "error", error: new ProviderError("scripted", "timeout", "strict score timed out") },
      { kind: "reply", content: '{"probe":"ok"}' },
    ]);
    const deps = buildProductionDeps({
      store,
      clock,
      config,
      home: join(dir, "home"),
      providers: [provider],
    });
    const ctx = phaseContext(store, clock, config);
    await createDiscoveringModelsDriverFromCatalog(deps)(ctx);
    const strict = new ModelObservationRepository(store).list()
      .filter((row) => row.kind === "strict_probe");
    expect(strict).toHaveLength(3);
    expect(strict.every((row) => !row.supported)).toBe(true);
    expect(deps.catalog.get({ provider: "scripted", model: "free" })?.info.capabilities).toMatchObject({
      supportsStrictReviewSchema: false,
      supportsStrictScoreSchema: false,
      supportsStrictProgressSchema: false,
    });
    expect(strictProbeEpochComplete(deps, ctx)).toBe(true);
  });

  it("does not audition a paid-only cataloged model under default free_only", async () => {
    const config = PolishConfigSchema.parse({
      audition: {
        enabled: true,
        strategy: "micro-tasks",
        minScoresForRouting: 1,
        tasks: [{ id: "echo", prompt: "Reply with exactly: ok", expected: "ok" }],
      },
    });
    expect(config.routing.costEligibility).toBe("free_only");
    const provider = discoveryProvider([
      { name: "paid", capabilities: { ...FAKE_CAPABILITIES.frontier, supportsJson: true, supportsTools: true } },
    ]);
    const deps = buildProductionDeps({
      store,
      clock,
      config,
      home: join(dir, "home"),
      providers: [provider],
    });
    await createDiscoveringModelsDriverFromCatalog(deps)(phaseContext(store, clock, config));
    expect(auditionCalls(provider)).toEqual([]);
  });

  it("production micro-task discovery does not invoke sidecar, pairwise judge, or debate", async () => {
    const compareAdapter = vi.spyOn(VerifierAdapter.prototype, "comparePair");
    const compareJudge = vi.spyOn(PairwiseJudge.prototype, "comparePair");
    const debateStarted = vi.spyOn(debate, "assertDebateMayStart");
    const config = PolishConfigSchema.parse({
      audition: {
        enabled: true,
        strategy: "micro-tasks",
        tasks: [{ id: "echo", prompt: "Reply with exactly: ok", expected: "ok" }],
      },
    });
    const provider = discoveryProvider([{ name: "free", capabilities: FREE }]);
    const deps = buildProductionDeps({
      store,
      clock,
      config,
      home: join(dir, "home"),
      providers: [provider],
    });
    await createDiscoveringModelsDriverFromCatalog(deps)(phaseContext(store, clock, config));
    expect(auditionCalls(provider).length).toBeGreaterThan(0);
    expect(compareAdapter).not.toHaveBeenCalled();
    expect(compareJudge).not.toHaveBeenCalled();
    expect(debateStarted).not.toHaveBeenCalled();
  });
});
