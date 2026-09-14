/**
 * P1.5 AC5b — the reasoning policy at every production model-call seam, as a **function**.
 *
 * The per-arm tables elsewhere pin what a run sends. They cannot pin what a seam *does*, because
 * a run's requests carry a project path, git hashes and ids that differ legitimately between two
 * runs. The instrument here is the one the entry-gate lane named in round 6: feed each seam the
 * **same** request under both `routing.disableReasoning` arms and compare the complete requests
 * that reach the provider. No masking is needed, because there is nothing to differ except what
 * the flag is allowed to change.
 *
 * `worker` and the three council roles are governed by the flag and are checked at their own
 * sites. Every seam below is one the flag must not reach, so both arms must be byte-identical.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelObservationRepository } from "../broker/observations.js";
import {
  EMPIRICAL_SCORE_RESPONSE_SCHEMA,
  PROGRESS_SCORE_RESPONSE_SCHEMA,
  REVIEW_FINDINGS_RESPONSE_SCHEMA,
} from "../broker/responseSchemas.js";

import { hashJson } from "../shared/hash.js";
import type { CompletionRequest, ModelInfo, ProviderAdapter } from "../broker/types.js";
import { defaultConfig } from "../domain/config.js";
import { FindingSchema } from "../domain/finding.js";
import { createTaskFromRequirement } from "../domain/task.js";
import { RunEngine } from "../engine/engine.js";
import type { PhaseContext } from "../engine/types.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { Scheduler } from "../scheduler/index.js";
import { FakeClock } from "../shared/clock.js";
import { openStore, type Store } from "../store/index.js";
import type { TournamentCandidate } from "../verify/strategy.js";
import { DaemonService } from "./service.js";
import {
  buildProductionDeps,
  completeDebateRole,
  installProductionDrivers,
  resolveCouncilRoles,
  resolveProductionVerifier,
  selectReviewProviders,
} from "./composition.js";
import { CouncilRoleAgent } from "../council/roles.js";
import { PLANNER_INTAKE_PURPOSE } from "../council/structuredOutput.js";
import { DISABLED_REASONING } from "../broker/responseSchemas.js";

const NOW = 1_700_000_000_000;
/** Fixed, so two arms produce the same request rather than two ids that can never match. */
const RUN_ID = "run_01hf7yat00000000000000";
const TASK_ID = "task_01hf7yat00000000000000";
const INTERPRETATION_ID = "interp_01hf7yat00000000000000";
const FINDING = FindingSchema.parse({
  id: "find_01hf7yat00000000000000",
  runId: RUN_ID,
  checkpointHash: "a".repeat(40),
  axis: "correctness",
  criterion: "INV-01",
  severity: "high",
  blocking: true,
  claim: "the guard admits an equal value",
  evidence: [{ path: "src/subject.ts", line: 2 }],
  reproduction: ["call it with equal operands"],
  reportedBy: { kind: "reviewer", model: { provider: "scripted", model: "m" } },
  status: "UNCERTAIN",
  duplicateOf: null,
  fingerprint: "fp",
  investigationRounds: 0,
  createdAt: NOW,
  updatedAt: NOW,
});

function verifierCandidate(id: string): TournamentCandidate {
  return {
    id,
    diff: `diff --git a/${id}.ts b/${id}.ts\n+export const ${id} = true;\n`,
    metrics: {
      candidateId: id,
      checksPassed: 2,
      checksTotal: 2,
      newFailures: 0,
      newFailureKeys: [],
      linesChanged: 1,
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
    },
    diffSummary: { files: 1, insertions: 1, deletions: 0 },
    gateReport: { passed: true, checks: [{ name: "test", kind: "test", status: "passed" }] },
  };
}

describe("reasoning policy at each production seam", () => {
  let dir: string;
  let clock: FakeClock;
  const stores: Store[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polish-reasoning-seam-"));
    clock = new FakeClock(NOW);
  });

  afterEach(() => {
    for (const open of stores.splice(0)) open.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Builds production deps over one scripted model that answers everything, on a **fresh store**:
   * the audition seam records an observation and skips a model it has already scored, so two arms
   * sharing a store would give the second one nothing to compare.
   */
  const arm = async (disableReasoning: boolean) => {
    const armStore = openStore({ artifactsDir: join(dir, `artifacts-${disableReasoning ? "on" : "off"}`) });
    stores.push(armStore);
    const config = defaultConfig();
    if (disableReasoning) config.routing.disableReasoning = true;
    else expect(config.routing.disableReasoning).toBe(false);
    config.audition = {
      ...config.audition,
      enabled: true,
      strategy: "micro-tasks",
      minScoresForRouting: 1,
      maxModels: 1,
      maxTasks: 1,
      tasks: [{ id: "echo", prompt: "Reply with exactly: ok", expected: "ok" }],
    };
    // Two models in distinct families: the empirical verifier selects one per family and needs
    // two, and with one it falls back to the heuristic and issues no model call at all.
    const provider = new ScriptedProvider("scripted", ["m", "m2"].map((name, index) => ({
      name,
      capabilities: {
        ...FAKE_CAPABILITIES.strong,
        family: `family-${String(index)}`,
        supportsJson: true,
        supportsTools: true,
        inputCostPerM: 0,
        outputCostPerM: 0,
      },
    })), {
      fallback: {
        kind: "fn",
        fn: (request) => ({
          message: {
            role: "assistant" as const,
            content: request.responseSchema?.name === "empirical_pair_score"
              ? JSON.stringify({ scoreA: 4, scoreB: 0 })
              : "ok",
          },
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
          finishReason: "stop" as const,
          latencyMs: 1,
        }),
      },
    });
    const home = join(dir, disableReasoning ? "home-on" : "home-off");
    mkdirSync(home, { recursive: true });
    const deps = buildProductionDeps({ store: armStore, clock, config, home, providers: [provider] });
    await deps.catalog.discover();
    return { config, provider, deps, store: armStore };
  };

  const context = (config: ReturnType<typeof defaultConfig>, armStore: Store): PhaseContext => ({
    run: { id: RUN_ID } as PhaseContext["run"],
    store: armStore,
    scheduler: new Scheduler(armStore, clock, { workerId: "w", laneLimits: config.lanes, leaseMs: 60_000 }),
    clock,
    config,
  });

  /**
   * Everything the provider saw. The only normalisation is the broker's per-call id, which is
   * minted fresh for every call and is the one value that cannot be equal across two arms; it is
   * masked by the exact id shape, so the mask cannot erase anything that is not an id.
   */
  const canonical = (calls: readonly CompletionRequest[]): string =>
    JSON.stringify(calls).replaceAll(/\bcall_[0-9a-hjkmnp-tv-z]{22}\b/g, "call_<id>");

  it("sends an identical reviewer request under both arms", async () => {
    const capture = async (disableReasoning: boolean): Promise<CompletionRequest[]> => {
      const { provider, deps, store: armStore } = await arm(disableReasoning);
      // Only this seam needs the strict-review probe pre-recorded. Recording it in the shared
      // setup made discovery skip that probe, so the probe comparison below never saw it.
      const observations = new ModelObservationRepository(armStore);
      observations.recordStrictProbe({ provider: "scripted", model: "m" }, {
        schema: "review",
        schemaHash: hashJson(REVIEW_FINDINGS_RESPONSE_SCHEMA),
        supported: true,
        at: clock.now(),
      });
      observations.restoreCatalog(deps.catalog);
      const reviewers = await selectReviewProviders(deps);
      const reviewer = reviewers[0];
      if (reviewer === undefined) throw new Error("no reviewer selected");
      provider.calls.length = 0;
      await reviewer.provider.complete({
        model: reviewer.model,
        messages: [{ role: "user", content: "probe" }],
        metadata: { runId: RUN_ID, purpose: "review_correctness", role: "reviewer" },
      });
      return provider.calls;
    };
    const off = await capture(false);
    expect(off).toHaveLength(1);
    expect(canonical(await capture(true))).toEqual(canonical(off));
  });

  /**
   * Through the production `DISCOVERING_MODELS` driver, not by calling `probeModelCapabilities`
   * directly: called directly with the same arguments the two arms are identical by construction
   * and the criterion is vacuous. The driver is where `deps.config` reaches the probes.
   */
  const captureDiscovery = async (
    disableReasoning: boolean,
    purposePrefix: string,
  ): Promise<CompletionRequest[]> => {
    const { config, provider, deps, store: armStore } = await arm(disableReasoning);
    const engine = new RunEngine(
      { store: armStore, clock, scheduler: new Scheduler(armStore, clock, { workerId: "w", laneLimits: config.lanes, leaseMs: 60_000 }), config, assertProjectClean: () => undefined },
      false,
    );
    installProductionDrivers(engine, deps);
    const driver = engine.getRegisteredDriver("DISCOVERING_MODELS");
    if (driver === undefined) throw new Error("no DISCOVERING_MODELS driver");
    provider.calls.length = 0;
    await driver(context(config, armStore));
    return provider.calls.filter((call) => call.metadata.purpose.startsWith(purposePrefix));
  };

  it("sends identical capability-probe requests under both arms", async () => {
    const off = await captureDiscovery(false, "capability_probe_");
    // Every probe, named: a probe the setup made discovery skip is a purpose this comparison
    // silently does not cover, which is how the strict-review one went unobserved.
    expect([...new Set(off.map((call) => call.metadata.purpose))].sort()).toEqual([
      "capability_probe_json",
      "capability_probe_strict_progress",
      "capability_probe_strict_review",
      "capability_probe_strict_score",
      "capability_probe_tools",
    ]);
    expect(canonical(await captureDiscovery(true, "capability_probe_"))).toEqual(canonical(off));
  });

  it("sends an identical finding-debate request under both arms", async () => {
    const capture = async (disableReasoning: boolean): Promise<CompletionRequest[]> => {
      const { config, provider, deps, store: armStore } = await arm(disableReasoning);
      provider.calls.length = 0;
      await completeDebateRole(deps, context(config, armStore), {
        model: { provider: "scripted", model: "m" },
        role: "judge",
        prompt: "evidence",
        finding: FINDING,
      });
      return provider.calls;
    };
    const off = await capture(false);
    expect(off).toHaveLength(1);
    expect(canonical(await capture(true))).toEqual(canonical(off));
  });

  /**
   * The planner's schema-repair request (`createStructuredCouncilClient`). It is built from the
   * original request plus a repair message, so it is a second seam the flag reaches and a place
   * the two could disagree. The council checks elsewhere never reach it, because their first
   * response is valid.
   */
  it("carries the same reasoning on the planner's repair request as on its first", async () => {
    const capture = async (disableReasoning: boolean): Promise<CompletionRequest[]> => {
      const { provider, deps } = await arm(disableReasoning);
      const roles = resolveCouncilRoles(deps);
      provider.calls.length = 0;
      // The fallback answers `ok`, which is not a valid planner intake proposal, so the
      // structured client issues its one repair and then fails closed.
      await expect(new CouncilRoleAgent("planner", roles.planner).analyze({
        runId: RUN_ID,
        purpose: PLANNER_INTAKE_PURPOSE,
        payload: { note: "probe" },
      })).rejects.toThrow();
      return provider.calls;
    };
    const off = await capture(false);
    const on = await capture(true);
    expect(off).toHaveLength(2);
    expect(on).toHaveLength(2);
    for (const call of off) expect(call.reasoning).toBeUndefined();
    for (const call of on) expect(call.reasoning).toEqual(DISABLED_REASONING);
    // Everything but the reasoning is the same in both arms, repair message included.
    const withoutReasoning = (calls: readonly CompletionRequest[]): string =>
      canonical(calls.map(({ reasoning: _reasoning, ...rest }) => rest as CompletionRequest));
    expect(withoutReasoning(on)).toEqual(withoutReasoning(off));
  });

  it("sends an identical empirical-verifier request under both arms", async () => {
    const capture = async (disableReasoning: boolean): Promise<CompletionRequest[]> => {
      const { config, provider, deps, store: armStore } = await arm(disableReasoning);
      const observations = new ModelObservationRepository(armStore);
      for (const model of ["m", "m2"]) {
        for (const schema of ["score", "progress"] as const) {
          observations.recordStrictProbe({ provider: "scripted", model }, {
            schema,
            schemaHash: hashJson(schema === "score" ? EMPIRICAL_SCORE_RESPONSE_SCHEMA : PROGRESS_SCORE_RESPONSE_SCHEMA),
            supported: true,
            at: clock.now(),
          });
        }
      }
      observations.restoreCatalog(deps.catalog);
      const task = createTaskFromRequirement(INTERPRETATION_ID, "R1", {
        id: TASK_ID,
        runId: RUN_ID,
        title: "noop",
        description: "WHAT: noop",
        kind: "bugfix",
        acceptance: ["noop"],
        complexity: "normal",
        baseCheckpointHash: "a".repeat(40),
        now: NOW,
      });
      const strategy = await resolveProductionVerifier(deps, context(config, armStore), task);
      provider.calls.length = 0;
      await strategy.comparePair(verifierCandidate("a"), verifierCandidate("b"), {
        runId: RUN_ID,
        taskKind: "bugfix",
        task: "noop",
      });
      return provider.calls;
    };
    const off = await capture(false);
    expect(off.length).toBeGreaterThan(0);
    expect(canonical(await capture(true))).toEqual(canonical(off));
  });

  it("sends identical audition requests under both arms", async () => {
    const off = await captureDiscovery(false, "model-audition:");
    expect(off.length).toBeGreaterThan(0);
    expect(canonical(await captureDiscovery(true, "model-audition:"))).toEqual(canonical(off));
  });

  /**
   * The reviewer benchmark forwards through its own recording wrapper, not through the review
   * swarm's transport, and it is reached by an operator command rather than by a run. The report
   * records the request **before** forwarding it, so an assertion on the report would not see a
   * change made after that point; this compares what the **provider** received.
   */
  it("sends identical reviewer-benchmark requests under both arms", async () => {
    const capture = async (disableReasoning: boolean): Promise<CompletionRequest[]> => {
      const home = join(dir, `bench-${disableReasoning ? "on" : "off"}`);
      mkdirSync(home, { recursive: true });
      if (disableReasoning) {
        writeFileSync(join(home, "polish.toml"), "[routing]\ndisableReasoning = true\n");
      }
      const providers = [
          benchmarkProvider("nex", "nex-agi/a:free", "nex-agi"),
          benchmarkProvider("nvidia", "nvidia/a:free", "nvidia"),
        ];
      const service = new DaemonService({ home, providers });
      try {
        expect(service.productionComposition().config.routing.disableReasoning).toBe(disableReasoning);
        await service.handle("benchmark.review", { seed: 9 });
        return providers.flatMap((provider) => provider.calls);
      } finally {
        service.store.close();
      }
    };
    const off = await capture(false);
    expect(off.length).toBeGreaterThan(0);
    expect(canonical(await capture(true))).toEqual(canonical(off));
  });
});

/** Two free reviewers the benchmark's model selection will pick, recording what they receive. */
function benchmarkProvider(id: string, model: string, family: string): ProviderAdapter & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  const info: ModelInfo = {
    ref: { provider: id, model },
    displayName: model,
    capabilities: {
      contextWindow: 32_000,
      maxOutputTokens: 2_000,
      supportsTools: false,
      supportsJson: true,
      inputCostPerM: 0,
      outputCostPerM: 0,
      tier: "fast",
      family,
    },
    source: "provider",
  };
  return {
    id,
    kind: "scripted",
    concurrency: 1,
    calls,
    listModels: () => Promise.resolve([info]),
    complete: (request) => {
      calls.push(structuredClone(request));
      return Promise.resolve({
        message: { role: "assistant" as const, content: '{"findings":[]}' },
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
        finishReason: "stop" as const,
        latencyMs: 1,
      });
    },
    health: () => Promise.resolve({ ok: true, checkedAt: 1 }),
  };
}
