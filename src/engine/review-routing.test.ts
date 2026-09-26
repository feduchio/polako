import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProductionDeps, installProductionDrivers } from "../daemon/composition.js";
import type { BaselineSnapshot } from "../domain/checks.js";
import type { Checkpoint } from "../domain/checkpoint.js";
import type { ReviewAxis } from "../domain/finding.js";
import type { ReviewExecution } from "../domain/review.js";
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

  it("selects free reviewers via ModelRouter, one family per axis, and never calls paid or unknown-price models", async () => {
    const { provider, config, engine } = await productionReviewing(["free-a", "free-b", "free-c"]);

    const listed = (await provider.listModels()).map((model) => model.ref.model);
    expect(listed[0]).toBe("paid-frontier");

    const { runId, checkpointHash } = seedReviewingRun(store, clock, fixture);
    await engine.tickRun(runId);

    expect(provider.calls.length).toBeGreaterThan(0);
    expect(provider.calls.every((call) => call.model.model.startsWith("free-") && call.model.model !== "free-unprobed")).toBe(true);

    const executions = store.repos.reviewExecutions.forCheckpoint(runId, checkpointHash);
    expect(executions.length).toBe(config.review.reviewersPerRound);
    expect(executions.every((execution) => execution.requestedModel.provider === "openrouter")).toBe(true);
    expect(new Set(executions.map((execution) => execution.requestedModel.model)).size).toBe(config.review.reviewersPerRound);
  });

  it("stops before calling anyone when fewer strict reviewer families exist than axes", async () => {
    const { provider, config, engine } = await productionReviewing(["free-a", "free-b"]);
    const { runId, checkpointHash } = seedReviewingRun(store, clock, fixture);
    await engine.tickRun(runId);

    expect(config.review.reviewersPerRound).toBe(3);
    const run = store.repos.runs.get(runId);
    expect(run?.phase).toBe("NEEDS_HUMAN");
    expect(run?.terminalReason?.code).toBe("review_unverifiable");
    expect(run?.terminalReason?.summary).toContain("insufficient_families: 2 of 3 (free-a, free-b)");
    expect(provider.calls).toHaveLength(0);
    expect(store.repos.reviewExecutions.forCheckpoint(runId, checkpointHash)).toHaveLength(0);
  });

  it("retries a rate-limited reviewer after the cooldown when its family is the one the round lacks", async () => {
    const { provider, config, engine } = await productionReviewing(["free-a", "free-b", "free-c"]);
    const { runId, checkpointHash } = seedReviewingRun(store, clock, fixture);
    await seedExecution(store, clock, runId, checkpointHash, "correctness", "free-a", null);
    await seedExecution(store, clock, runId, checkpointHash, "regression", "free-b", null);
    await seedExecution(store, clock, runId, checkpointHash, "adversarial", "free-c", "rate limited: 429 upstream");

    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("REVIEWING");
    expect(provider.calls).toHaveLength(0);

    await clock.advance(config.review.rateLimitCooldownMs);
    await engine.tickRun(runId);
    expect(provider.calls.map((call) => call.model.model)).toEqual(["free-c"]);
    expect(store.repos.runs.get(runId)?.phase).toBe("VALIDATING");
  });

  it("does not wait on a rate-limited reviewer whose family already answered this round", async () => {
    const { provider, engine } = await productionReviewing(["free-a", "free-b", { name: "free-b-alt", family: "free-b" }]);
    const { runId, checkpointHash } = seedReviewingRun(store, clock, fixture);
    await seedExecution(store, clock, runId, checkpointHash, "correctness", "free-a", null);
    await seedExecution(store, clock, runId, checkpointHash, "regression", "free-b", "rate limited: 429 upstream");
    await seedExecution(store, clock, runId, checkpointHash, "regression", "free-b-alt", null);

    await engine.tickRun(runId);
    const run = store.repos.runs.get(runId);
    expect(run?.phase).toBe("NEEDS_HUMAN");
    expect(run?.terminalReason?.summary).toContain("insufficient_families: 2 of 3");
    expect(provider.calls).toHaveLength(0);
  });

  async function productionReviewing(freeModels: readonly (string | { name: string; family: string })[]) {
    const free = freeModels.map((model) => (typeof model === "string" ? { name: model, family: model } : model));
    const provider = new ScriptedProvider("openrouter", [
      {
        name: "paid-frontier",
        capabilities: { ...FAKE_CAPABILITIES.frontier, family: "paid", supportsJson: true, inputCostPerM: 3, outputCostPerM: 15 },
      },
      ...free.map(({ name, family }) => ({
        name,
        capabilities: {
          ...FAKE_CAPABILITIES.fast,
          family,
          supportsJson: true,
          supportsStrictReviewSchema: true,
          inputCostPerM: 0,
          outputCostPerM: 0,
        },
      })),
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
    for (const { name } of free) provider.script(name, [{ kind: "reply", content: "[]" }]);

    const config = defaultConfig();
    expect(config.routing.costEligibility).toBe("free_only");
    const home = join(fixture.root, "home");
    mkdirSync(home, { recursive: true });
    const sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: config.lanes, leaseMs: 60_000 });
    const engine = new RunEngine({ store, clock, scheduler: sched, config, assertProjectClean: () => undefined }, false);
    const deps = buildProductionDeps({ store, clock, config, home, providers: [provider] });
    await deps.catalog.discover();
    const observations = new ModelObservationRepository(store);
    for (const { name } of free) {
      observations.recordStrictProbe({ provider: "openrouter", model: name }, {
        schema: "review",
        schemaHash: hashJson(REVIEW_FINDINGS_RESPONSE_SCHEMA),
        supported: true,
        at: clock.now(),
      });
    }
    observations.restoreCatalog(deps.catalog);
    installProductionDrivers(engine, deps);
    return { provider, config, engine };
  }
});

async function seedExecution(
  store: Store,
  clock: FakeClock,
  runId: string,
  checkpointHash: string,
  axis: ReviewAxis,
  model: string,
  error: string | null,
): Promise<void> {
  const execution: ReviewExecution = {
    id: id("rvex", clock.now()),
    runId,
    checkpointHash,
    roundIndex: 1,
    axis,
    requestedModel: { provider: "openrouter", model },
    completed: error === null,
    findings: [],
    startedAt: clock.now(),
    finishedAt: clock.now(),
    ...(error === null ? {} : { error }),
  };
  store.events.append([
    { id: id("evt", clock.now()), runId, ts: clock.now(), type: "review.finished", payload: { execution }, causedBy: [], actor: { kind: "system" }, artifacts: [] },
  ]);
  await clock.advance(1);
}

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
