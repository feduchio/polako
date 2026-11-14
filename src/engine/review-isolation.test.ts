import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProductionDeps, installProductionDrivers } from "../daemon/composition.js";
import type { BaselineSnapshot } from "../domain/checks.js";
import type { Checkpoint } from "../domain/checkpoint.js";
import { defaultConfig } from "../domain/config.js";
import { ISOLATED_REVIEW_PREAMBLE } from "../review/reviewerProtocol.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { Git } from "../sandbox/git.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { ModelObservationRepository } from "../broker/observations.js";
import { REVIEW_FINDINGS_RESPONSE_SCHEMA } from "../broker/responseSchemas.js";
import { hashJson } from "../shared/hash.js";
import { openStore, type Store } from "../store/index.js";
import { Scheduler } from "../scheduler/index.js";
import { buildFinalReportInput } from "../report/build.js";
import { RunEngine } from "./engine.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

interface ModelSpec {
  name: string;
  family: string;
}

describe("REVIEWING with the same-model fallback", () => {
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

  it("prefers a reviewer of another lineage and isolates only the axis that has none", async () => {
    const { provider, engine } = await setup(
      [{ name: "q-author", family: "qwen" }, { name: "q-sibling", family: "qwen" }, { name: "g-reviewer", family: "google" }],
      { sameModelFallback: true, reviewersPerRound: 2 },
    );
    const { runId, checkpointHash } = seedRun(store, clock, fixture, "q-author");
    await engine.tickRun(runId);

    expect(store.repos.runs.get(runId)?.phase).toBe("VALIDATING");
    const executions = store.repos.reviewExecutions.forCheckpoint(runId, checkpointHash);
    const byModel = Object.fromEntries(executions.map((execution) => [execution.requestedModel.model, execution]));
    // another lineage first, no isolation; then the author's lineage via the sibling fine-tune, not the author itself
    expect(Object.keys(byModel).sort()).toEqual(["g-reviewer", "q-sibling"]);
    expect(byModel["g-reviewer"]?.independence).toBeUndefined();
    expect(byModel["q-sibling"]?.independence).toBe("same-model-isolated");

    const plain = provider.calls.find((call) => call.model.model === "g-reviewer");
    const isolated = provider.calls.find((call) => call.model.model === "q-sibling");
    expect(plain?.temperature).toBe(0);
    expect(isolated?.temperature).toBe(defaultConfig().review.isolatedTemperature);
    expect(String(plain?.messages[0]?.content)).not.toContain(ISOLATED_REVIEW_PREAMBLE);
    expect(String(isolated?.messages[0]?.content)).toContain(ISOLATED_REVIEW_PREAMBLE);
    expect(String(isolated?.messages[0]?.content)).toContain("Adversarial stance:");

    const recorded = store.events.list(runId, { types: ["review.independence"] });
    expect(recorded.map((event) => event.payload["reviewIndependence"])).toEqual(["same-model-isolated"]);
  });

  it("reviews with the author's own model, fresh per axis and without its work product, when it is the only one", async () => {
    const { provider, engine } = await setup([{ name: "only", family: "qwen" }], { sameModelFallback: true, reviewersPerRound: 2 });
    const { runId, checkpointHash } = seedRun(store, clock, fixture, "only");
    await engine.tickRun(runId);

    expect(store.repos.runs.get(runId)?.phase).toBe("VALIDATING");
    const executions = store.repos.reviewExecutions.forCheckpoint(runId, checkpointHash);
    expect(executions.map((execution) => execution.independence)).toEqual(["same-model-isolated", "same-model-isolated"]);
    expect(new Set(executions.map((execution) => execution.axis)).size).toBe(2);
    expect(provider.calls).toHaveLength(2);
    for (const call of provider.calls) {
      // each call is a fresh two-message context: system prompt + the diff pack; nothing of the worker's
      expect(call.messages.map((message) => message.role)).toEqual(["system", "user"]);
      expect(call.temperature).toBe(defaultConfig().review.isolatedTemperature);
      expect(JSON.stringify(call.messages)).not.toMatch(/transcript|worker report/i);
    }
    const report = buildFinalReportInput({ run: store.repos.runs.get(runId)!, store, clock, config: defaultConfig() });
    expect((report.evidence ?? []).join("\n")).toContain("reviewIndependence: same-model-isolated");
  });

  it("stops for a human when the same-model fallback is off and only the author's lineage exists", async () => {
    const { provider, engine } = await setup([{ name: "only", family: "qwen" }], { sameModelFallback: false, reviewersPerRound: 2 });
    const { runId } = seedRun(store, clock, fixture, "only");
    await engine.tickRun(runId);
    const run = store.repos.runs.get(runId);
    expect(run?.phase).toBe("NEEDS_HUMAN");
    expect(run?.terminalReason?.summary).toContain("insufficient_families");
    expect(provider.calls).toHaveLength(0);
    expect(store.events.list(runId, { types: ["review.independence"] })).toHaveLength(0);
  });

  it("records plain lineage reviews as lineage and no execution is isolated", async () => {
    const { provider, engine } = await setup(
      [{ name: "q-author", family: "qwen" }, { name: "g-reviewer", family: "google" }, { name: "i-reviewer", family: "ibm" }],
      { sameModelFallback: true, reviewersPerRound: 2 },
    );
    const { runId, checkpointHash } = seedRun(store, clock, fixture, "q-author");
    await engine.tickRun(runId);
    const executions = store.repos.reviewExecutions.forCheckpoint(runId, checkpointHash);
    expect(executions.map((execution) => execution.requestedModel.model).sort()).toEqual(["g-reviewer", "i-reviewer"]);
    expect(executions.every((execution) => execution.independence === undefined)).toBe(true);
    expect(provider.calls.every((call) => call.temperature === 0)).toBe(true);
    expect(store.events.list(runId, { types: ["review.independence"] }).map((event) => event.payload["reviewIndependence"])).toEqual(["lineage"]);
  });

  it("with the falsifiability audit on, every reviewer is asked for it and its audit is recorded", async () => {
    const { provider, engine } = await setup(
      [{ name: "q-author", family: "qwen" }, { name: "g-reviewer", family: "google" }],
      { sameModelFallback: true, reviewersPerRound: 2, falsifiabilityAudit: true },
    );
    const { runId } = seedRun(store, clock, fixture, "q-author");
    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("VALIDATING");
    expect(provider.calls.every((call) => String(call.messages[0]?.content).includes("MANDATORY TEST AUDIT"))).toBe(true);
    const audits = store.events.list(runId, { types: ["review.test_audit"] });
    expect(audits).toHaveLength(2);
    expect(audits.map((event) => event.payload["model"]).map((model) => (model as { model: string }).model).sort()).toEqual(["g-reviewer", "q-author"]);
  });

  it("pinned reviewers: the other lineage first, then the author's own model in isolation, and nobody else", async () => {
    const { provider, engine } = await setup(
      [{ name: "ornith", family: "qwen" }, { name: "gpt-oss", family: "openai" }, { name: "swift", family: "qwen" }, { name: "gemma", family: "google" }],
      { sameModelFallback: true, reviewersPerRound: 2, reviewers: ["local:gpt-oss", "local:ornith"] },
    );
    const { runId, checkpointHash } = seedRun(store, clock, fixture, "ornith");
    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("VALIDATING");
    const executions = store.repos.reviewExecutions.forCheckpoint(runId, checkpointHash);
    expect(executions.map((execution) => [execution.axis, execution.requestedModel.model, execution.independence ?? "lineage"])).toEqual([
      ["correctness", "gpt-oss", "lineage"],
      ["regression", "ornith", "same-model-isolated"],
    ]);
    expect(provider.calls.map((call) => call.model.model)).toEqual(["gpt-oss", "ornith"]);
    expect(store.events.list(runId, { types: ["review.independence"] }).map((event) => event.payload["reviewIndependence"])).toEqual(["same-model-isolated"]);
  });

  it("says why a reviewer left the pool when the round then lacks families", async () => {
    const { provider, engine } = await setup(
      [{ name: "q-author", family: "qwen" }, { name: "g-reviewer", family: "google" }],
      { sameModelFallback: true, reviewersPerRound: 2, truncated: ["q-author"] },
    );
    expect(provider.calls).toHaveLength(0);
    const { runId } = seedRun(store, clock, fixture, "q-author");
    await engine.tickRun(runId);
    await engine.tickRun(runId);
    const run = store.repos.runs.get(runId);
    expect(run?.phase).toBe("NEEDS_HUMAN");
    expect(run?.terminalReason?.summary).toContain("reviewers excluded after a failure that recurs: local:q-author (");
    expect(run?.terminalReason?.summary).toContain("truncated at the configured token cap");
  });

  async function setup(models: readonly ModelSpec[], review: { sameModelFallback: boolean; reviewersPerRound: number; falsifiabilityAudit?: boolean; reviewers?: string[]; truncated?: string[] }) {
    const provider = new ScriptedProvider("local", models.map(({ name, family }) => ({
      name,
      capabilities: { ...FAKE_CAPABILITIES.fast, family, supportsJson: true, supportsStrictReviewSchema: true, inputCostPerM: 0, outputCostPerM: 0 },
    })));
    for (const { name } of models) {
      provider.script(name, review.truncated?.includes(name) === true
        ? [{ kind: "reply", content: '{"findings": [', finishReason: "length" }]
        : [{ kind: "reply", content: '{"findings": []}' }, { kind: "reply", content: '{"findings": []}' }]);
    }
    const config = defaultConfig();
    config.review.sameModelFallback = review.sameModelFallback;
    config.review.reviewersPerRound = review.reviewersPerRound;
    config.review.falsifiabilityAudit = review.falsifiabilityAudit ?? false;
    if (review.reviewers !== undefined) config.roles.reviewers = review.reviewers;
    const home = join(fixture.root, "home");
    mkdirSync(home, { recursive: true });
    const sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: config.lanes, leaseMs: 60_000 });
    const engine = new RunEngine({ store, clock, scheduler: sched, config, assertProjectClean: () => undefined }, false);
    const deps = buildProductionDeps({ store, clock, config, home, providers: [provider] });
    await deps.catalog.discover();
    const observations = new ModelObservationRepository(store);
    for (const { name } of models) {
      observations.recordStrictProbe({ provider: "local", model: name }, {
        schema: "review",
        schemaHash: hashJson(REVIEW_FINDINGS_RESPONSE_SCHEMA),
        supported: true,
        at: clock.now(),
      });
    }
    observations.restoreCatalog(deps.catalog);
    installProductionDrivers(engine, deps);
    return { provider, engine };
  }
});

async function repositoryFixture(): Promise<{ root: string; repoDir: string; base: string; integrated: string }> {
  const root = mkdtempSync(join(tmpdir(), "polako-review-isolation-"));
  cleanup.push(root);
  const repoDir = join(root, "repo");
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "polako-review-isolation" }));
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

/** A run in REVIEWING whose integrated checkpoint was written by the winning candidate `author`. */
function seedRun(
  store: Store,
  clock: FakeClock,
  fixture: { repoDir: string; base: string; integrated: string },
  author: string,
): { runId: string; checkpointHash: string } {
  const runId = id("run", clock.now());
  const missionId = id("msn", clock.now());
  const taskId = id("task", clock.now());
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
    taskId,
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
  const candidate = {
    id: id("cand", clock.now()),
    runId,
    taskId,
    attempt: 1,
    model: { provider: "local", model: author },
    baseCheckpointHash: fixture.base,
    branch: "polako/test/winner",
    worktreePath: null,
    headCommit: fixture.integrated,
    state: "WINNER" as const,
    gateReport: null,
    transcriptRef: null,
    diffRef: null,
    createdAt: clock.now(),
    updatedAt: clock.now(),
  };
  const actor = { kind: "system" as const };
  store.events.append([
    { id: id("evt", clock.now()), runId, ts: clock.now(), type: "run.created", payload: { run }, causedBy: [], actor, artifacts: [] },
    { id: id("evt", clock.now() + 1), runId, ts: clock.now() + 1, type: "baseline.snapshotted", payload: { baseline }, causedBy: [], actor, artifacts: [] },
    { id: id("evt", clock.now() + 2), runId, ts: clock.now() + 2, type: "checkpoint.created", payload: { checkpoint }, causedBy: [], actor, artifacts: [] },
    { id: id("evt", clock.now() + 3), runId, ts: clock.now() + 3, type: "candidate.created", payload: { candidate }, causedBy: [], actor: { kind: "worker" as const, model: candidate.model }, artifacts: [] },
  ]);
  return { runId, checkpointHash: fixture.integrated };
}
