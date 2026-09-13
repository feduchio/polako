import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProductionDeps, installProductionDrivers } from "../daemon/composition.js";
import type { BaselineSnapshot } from "../domain/checks.js";
import type { Checkpoint } from "../domain/checkpoint.js";
import { defaultConfig } from "../domain/config.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { Git } from "../sandbox/git.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { ModelObservationRepository } from "../broker/observations.js";
import { REVIEW_FINDINGS_RESPONSE_SCHEMA } from "../broker/responseSchemas.js";
import { hashJson } from "../shared/hash.js";
import { openStore, type Store } from "../store/index.js";
import { Scheduler } from "../scheduler/index.js";
import { RunEngine } from "./engine.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("production REVIEWING cost-eligible routing", () => {
  let store: Store;
  let clock: FakeClock;
  let fixture: { root: string; repoDir: string; base: string; integrated: string };

  beforeEach(async () => {
    fixture = await repositoryFixture();
    store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    clock = new FakeClock(1_700_000_000_000);
  });

  afterEach(() => {
    store.close();
  });

  it("selects the free reviewer via ModelRouter and never calls paid or unknown-price models", async () => {
    const provider = new ScriptedProvider("openrouter", [
      {
        name: "paid-frontier",
        capabilities: { ...FAKE_CAPABILITIES.frontier, family: "paid", supportsJson: true, inputCostPerM: 3, outputCostPerM: 15 },
      },
      {
        name: "free-reviewer",
        capabilities: {
          ...FAKE_CAPABILITIES.fast,
          family: "free",
          supportsJson: true,
          supportsStrictReviewSchema: true,
          inputCostPerM: 0,
          outputCostPerM: 0,
        },
      },
      {
        name: "unknown-price",
        capabilities: { ...FAKE_CAPABILITIES.strong, family: "unknown", supportsJson: true, inputCostPerM: null, outputCostPerM: null },
      },
      {
        name: "free-unprobed",
        capabilities: {
          ...FAKE_CAPABILITIES.frontier,
          family: "free-unprobed",
          supportsJson: true,
          inputCostPerM: 0,
          outputCostPerM: 0,
        },
      },
    ]);
    const banned = (name: string) => ({
      kind: "fn" as const,
      fn: () => {
        throw new Error(`${name} must not be invoked under free_only`);
      },
    });
    provider.script("paid-frontier", [banned("paid-frontier")]);
    provider.script("unknown-price", [banned("unknown-price")]);
    provider.script("free-unprobed", [banned("free-unprobed")]);
    provider
      .script("free-reviewer", [{ kind: "reply", content: "[]" }])
      .script("free-reviewer", [{ kind: "reply", content: "[]" }])
      .script("free-reviewer", [{ kind: "reply", content: "[]" }]);

    const config = defaultConfig();
    expect(config.routing.costEligibility).toBe("free_only");
    const home = join(fixture.root, "home");
    mkdirSync(home, { recursive: true });
    const sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: config.lanes, leaseMs: 60_000 });
    const engine = new RunEngine({ store, clock, scheduler: sched, config, assertProjectClean: () => undefined }, false);
    const deps = buildProductionDeps({
      store,
      clock,
      config,
      home,
      providers: [provider],
    });
    await deps.catalog.discover();
    const observations = new ModelObservationRepository(store);
    observations.recordStrictProbe({ provider: "openrouter", model: "free-reviewer" }, {
      schema: "review",
      schemaHash: hashJson(REVIEW_FINDINGS_RESPONSE_SCHEMA),
      supported: true,
      at: clock.now(),
    });
    observations.restoreCatalog(deps.catalog);
    installProductionDrivers(engine, deps);

    const listed = (await provider.listModels()).map((model) => model.ref.model);
    expect(listed[0]).toBe("paid-frontier");
    expect(listed[1]).toBe("free-reviewer");

    const { runId, checkpointHash } = seedReviewingRun(store, clock, fixture);
    await engine.tickRun(runId);

    expect(provider.calls.length).toBeGreaterThan(0);
    expect(provider.calls.every((call) => call.model.model === "free-reviewer")).toBe(true);
    expect(provider.calls.some((call) => call.model.model === "paid-frontier")).toBe(false);
    expect(provider.calls.some((call) => call.model.model === "unknown-price")).toBe(false);
    expect(provider.calls.some((call) => call.model.model === "free-unprobed")).toBe(false);

    const executions = store.repos.reviewExecutions.forCheckpoint(runId, checkpointHash);
    expect(executions.length).toBe(config.review.reviewersPerRound);
    expect(
      executions.every(
        (execution) => execution.requestedModel.provider === "openrouter" && execution.requestedModel.model === "free-reviewer",
      ),
    ).toBe(true);
  });
});

async function repositoryFixture(): Promise<{ root: string; repoDir: string; base: string; integrated: string }> {
  const root = mkdtempSync(join(tmpdir(), "polish-review-routing-"));
  cleanup.push(root);
  const repoDir = join(root, "repo");
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "polish-review-routing" }));
  const git = await Git.init(repoDir);
  writeFileSync(join(repoDir, "alpha.ts"), "export const a = 1;\n");
  const base = await git.commitAll("base");
  if (base === null) throw new Error("fixture base commit missing");
  await git.createBranch("run", base);
  writeFileSync(join(repoDir, "beta.ts"), "export const b = 2;\n");
  const integrated = await git.commitAll("integrated");
  if (integrated === null) throw new Error("fixture integrated commit missing");
  return { root, repoDir, base, integrated };
}

function seedReviewingRun(
  store: Store,
  clock: FakeClock,
  fixture: { repoDir: string; base: string; integrated: string },
): { runId: string; checkpointHash: string } {
  const runId = id("run", clock.now());
  const missionId = id("msn", clock.now());
  const baseline: BaselineSnapshot = {
    id: id("base", clock.now()),
    runId,
    commitHash: fixture.base,
    checks: [],
    configHashes: {},
    scriptsHash: "0".repeat(64),
    toolchain: {},
    createdAt: clock.now(),
  };
  const checkpoint: Checkpoint = {
    id: id("cp", clock.now()),
    runId,
    seq: 1,
    commitHash: fixture.integrated,
    parentId: null,
    source: "integration",
    taskId: id("task", clock.now()),
    evidence: {
      gates: { gate: "pass" },
      testsPassed: 1,
      testsFailed: 0,
      testsTotal: 1,
      openValidatedFindings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      diffLinesFromBaseline: 2,
    },
    createdAt: clock.now(),
  };
  const run = {
    id: runId,
    missionId,
    projectPath: fixture.repoDir,
    runBranch: "run",
    phase: "REVIEWING" as const,
    control: "RUNNING" as const,
    currentCheckpointHash: fixture.integrated,
    baselineId: baseline.id,
    interpretationId: null,
    createdAt: clock.now(),
    updatedAt: clock.now(),
    terminalReason: null,
  };
  store.events.append([
    { id: id("evt", clock.now()), runId, ts: clock.now(), type: "run.created", payload: { run }, causedBy: [], actor: { kind: "system" }, artifacts: [] },
    { id: id("evt", clock.now() + 1), runId, ts: clock.now() + 1, type: "baseline.snapshotted", payload: { baseline }, causedBy: [], actor: { kind: "system" }, artifacts: [] },
    { id: id("evt", clock.now() + 2), runId, ts: clock.now() + 2, type: "checkpoint.created", payload: { checkpoint }, causedBy: [], actor: { kind: "system" }, artifacts: [] },
  ]);
  return { runId, checkpointHash: fixture.integrated };
}
