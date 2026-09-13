import { readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselineSnapshot } from "../domain/checks.js";
import type { Checkpoint } from "../domain/checkpoint.js";
import { defaultConfig, ReviewStrategySchema, type PolishConfig } from "../domain/config.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { Git } from "../sandbox/git.js";
import { WorktreeSandbox } from "../sandbox/worktree.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { Scheduler } from "../scheduler/index.js";
import { RunEngine } from "./engine.js";
import { createReviewingDriver, type ReviewDriverOptions } from "./reviewDrivers.js";
import { stubDriverFor } from "./stubs.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

/**
 * P1.1: `adversarial` is 64.4% of every token this tool has spent, it runs last, and the earlier axes'
 * verdicts are known by then. Contract: docs/ledger/P1.1.md.
 */
describe("P1.1 conditional adversarial skip", () => {
  let store: Store;
  let clock: FakeClock;
  let fixture: Fixture;
  let provider: ScriptedProvider;

  beforeEach(async () => {
    fixture = await repositoryFixture();
    store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    clock = new FakeClock(1_700_000_000_000);
    provider = new ScriptedProvider("reviews", [{ name: "reviewer", capabilities: FAKE_CAPABILITIES.strong }]);
  });

  afterEach(() => {
    store.close();
  });

  const engineWith = (skip: boolean): RunEngine => {
    const config: PolishConfig = {
      ...defaultConfig(),
      review: { ...defaultConfig().review, skipAdversarialWhenClean: skip },
    };
    const sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: config.lanes, leaseMs: 60_000 });
    const engine = new RunEngine({ store, clock, scheduler: sched, config, assertProjectClean: () => undefined }, false);
    for (const phase of NON_REVIEW_PHASES) engine.registerPhase(phase, stubDriverFor(phase));
    engine.registerPhase("REVIEWING", createReviewingDriver(reviewingOptions(fixture, () => [
      { provider, model: { provider: "reviews", model: "reviewer" } },
    ])));
    return engine;
  };

  // AC1, and the test that discriminates MC2: a driver reading the pre-loop `roundExecutions`
  // snapshot sees an empty set, which MC3 clause 3 says is not clean, so it would call three times.
  it("skips adversarial and calls the provider twice when both earlier axes report nothing", async () => {
    provider
      .script("reviewer", [{ kind: "reply", content: emptyReview() }])
      .script("reviewer", [{ kind: "reply", content: emptyReview() }]);

    const { runId, checkpointHash } = seedReviewingRun(store, clock, fixture);
    await engineWith(true).tickRun(runId);

    expect(provider.calls).toHaveLength(2);
    const executions = store.repos.reviewExecutions.forCheckpoint(runId, checkpointHash);
    expect(executions).toHaveLength(3);
    const skipped = executions.filter((execution) => execution.error === "no_prior_findings");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.axis).toBe("adversarial");
    expect(skipped[0]?.completed).toBe(true);
    expect(skipped[0]?.findings).toEqual([]);
    expect(skipped[0]?.requestedModel).toEqual({ provider: "reviews", model: "reviewer" });
  });

  // AC2
  it("does not skip adversarial when an earlier axis reports a finding", async () => {
    provider
      .script("reviewer", [{ kind: "reply", content: reviewJson("correctness", "alpha.ts") }])
      .script("reviewer", [{ kind: "reply", content: emptyReview() }])
      .script("reviewer", [{ kind: "reply", content: emptyReview() }]);

    const { runId, checkpointHash } = seedReviewingRun(store, clock, fixture);
    await engineWith(true).tickRun(runId);

    expect(provider.calls).toHaveLength(3);
    const executions = store.repos.reviewExecutions.forCheckpoint(runId, checkpointHash);
    expect(executions.some((execution) => execution.error === "no_prior_findings")).toBe(false);
  });

  // AC3
  it("is off by default, so the same clean round still calls three times", async () => {
    expect(ReviewStrategySchema.parse({}).skipAdversarialWhenClean).toBe(false);
    provider
      .script("reviewer", [{ kind: "reply", content: emptyReview() }])
      .script("reviewer", [{ kind: "reply", content: emptyReview() }])
      .script("reviewer", [{ kind: "reply", content: emptyReview() }]);

    const { runId } = seedReviewingRun(store, clock, fixture);
    await engineWith(defaultConfig().review.skipAdversarialWhenClean).tickRun(runId);

    expect(provider.calls).toHaveLength(3);
  });

  // AC4: `completed: true` on the skip is what stops `missingAxes` requeueing the axis forever.
  it("completes the round and advances, without requeueing the skipped axis", async () => {
    provider
      .script("reviewer", [{ kind: "reply", content: emptyReview() }])
      .script("reviewer", [{ kind: "reply", content: emptyReview() }]);

    const { runId, checkpointHash } = seedReviewingRun(store, clock, fixture);
    const engine = engineWith(true);
    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("VALIDATING");

    const before = store.repos.reviewExecutions.forCheckpoint(runId, checkpointHash).length;
    await engine.tickRun(runId);
    expect(store.repos.reviewExecutions.forCheckpoint(runId, checkpointHash)).toHaveLength(before);
    expect(provider.calls).toHaveLength(2);
  });

  // AC8. MC3 clause 3: with nothing yet observed there is no basis to skip, and `[].every()` is true,
  // so the empty-set guard is what stops a skip on no evidence. Unreachable in the default axis order,
  // where `adversarial` runs last, so it is exercised through the existing `resolveAxes` seam.
  it("does not skip on an empty set of completed other axes", async () => {
    provider
      .script("reviewer", [{ kind: "reply", content: emptyReview() }])
      .script("reviewer", [{ kind: "reply", content: emptyReview() }])
      .script("reviewer", [{ kind: "reply", content: emptyReview() }]);

    const config: PolishConfig = {
      ...defaultConfig(),
      review: { ...defaultConfig().review, skipAdversarialWhenClean: true },
    };
    const sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: config.lanes, leaseMs: 60_000 });
    const engine = new RunEngine({ store, clock, scheduler: sched, config, assertProjectClean: () => undefined }, false);
    for (const phase of NON_REVIEW_PHASES) engine.registerPhase(phase, stubDriverFor(phase));
    engine.registerPhase("REVIEWING", createReviewingDriver({
      ...reviewingOptions(fixture, () => [{ provider, model: { provider: "reviews", model: "reviewer" } }]),
      resolveAxes: () => Promise.resolve(["adversarial", "correctness", "regression"]),
    }));

    const { runId, checkpointHash } = seedReviewingRun(store, clock, fixture);
    await engine.tickRun(runId);

    expect(provider.calls).toHaveLength(3);
    const executions = store.repos.reviewExecutions.forCheckpoint(runId, checkpointHash);
    expect(executions.some((execution) => execution.error === "no_prior_findings")).toBe(false);
  });

  // AC6
  it("records no provider call for the skipped axis", async () => {
    provider
      .script("reviewer", [{ kind: "reply", content: emptyReview() }])
      .script("reviewer", [{ kind: "reply", content: emptyReview() }]);

    const { runId } = seedReviewingRun(store, clock, fixture);
    await engineWith(true).tickRun(runId);

    const axes = provider.calls.map((call) => call.messages[1]?.content ?? "");
    expect(axes.some((body) => body.includes('"axis":"adversarial"'))).toBe(false);
    expect(axes.filter((body) => body.includes('"axis":"correctness"'))).toHaveLength(1);
    expect(axes.filter((body) => body.includes('"axis":"regression"'))).toHaveLength(1);
  });
});

// AC7: MC5 forbids a new event type, because projections build `review_executions` only from
// `review.started` and `review.finished`, so a third type would persist a row-less event.
describe("P1.1 MC5", () => {
  it("introduces no review.axis_skipped event type", () => {
    const offenders = sourceFiles(join(import.meta.dirname, "..")).filter((path) =>
      readFileSync(path, "utf8").includes("review.axis_skipped"),
    );
    expect(offenders).toEqual([]);
  });
});

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

const NON_REVIEW_PHASES = [
  "CREATED", "DISCOVERING_PROJECT", "BASELINING", "INTERPRETING_MISSION", "DISCOVERING_MODELS",
  "PLANNING", "EXECUTING", "GATING", "COMPARING", "INTEGRATING", "VALIDATING", "CONVERGENCE_CHECK",
] as const;

function reviewingOptions(
  fixture: Fixture,
  resolveReviewers: NonNullable<ReviewDriverOptions["resolveReviewers"]>,
): ReviewDriverOptions {
  return {
    resolveReviewers,
    sandbox: () => new WorktreeSandbox(fixture.repoDir, join(fixture.root, "worktrees"), defaultConfig().sandbox),
  };
}

interface Fixture {
  root: string;
  repoDir: string;
  base: string;
  integrated: string;
}

async function repositoryFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "polish-p11-skip-"));
  cleanup.push(root);
  const repoDir = join(root, "repo");
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "polish-p11-fixture" }));
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

function seedReviewingRun(store: Store, clock: FakeClock, fixture: Fixture): { runId: string; checkpointHash: string } {
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

function emptyReview(): string {
  return JSON.stringify({ findings: [] });
}

function reviewJson(criterion: string, path: string): string {
  return JSON.stringify([{
    criterion,
    severity: "medium",
    blocking: false,
    claim: `${criterion} finding`,
    evidence: [{ path, line: 1 }],
    reproduction: ["open file"],
  }]);
}
