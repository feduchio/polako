import { readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselineSnapshot } from "../domain/checks.js";
import type { Checkpoint } from "../domain/checkpoint.js";
import { defaultConfig, ReviewStrategySchema, type PolishConfig } from "../domain/config.js";
import { ProviderError } from "../broker/types.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { Git } from "../sandbox/git.js";
import { WorktreeSandbox } from "../sandbox/worktree.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { Scheduler } from "../scheduler/index.js";
import { RunEngine } from "./engine.js";
import { createReviewingDriver, recentlyRateLimitedReviewModels, type ReviewDriverOptions } from "./reviewDrivers.js";
import { stubDriverFor } from "./stubs.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

/**
 * Review-cost work on the REVIEWING driver: P1.1's conditional skip and P1.2's output cap.
 * Contracts: docs/ledger/P1.1.md, docs/ledger/P1.2.md.
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

  const engineWith = (
    skip: boolean,
    reviewers?: readonly { provider: ScriptedProvider; model: { provider: string; model: string } }[],
    axes?: readonly ("correctness" | "regression" | "adversarial")[],
  ): RunEngine => {
    const config: PolishConfig = {
      ...defaultConfig(),
      review: { ...defaultConfig().review, skipAdversarialWhenClean: skip },
    };
    const sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: config.lanes, leaseMs: 60_000 });
    const engine = new RunEngine({ store, clock, scheduler: sched, config, assertProjectClean: () => undefined }, false);
    for (const phase of NON_REVIEW_PHASES) engine.registerPhase(phase, stubDriverFor(phase));
    engine.registerPhase("REVIEWING", createReviewingDriver({
      ...reviewingOptions(fixture, () => [...(reviewers ?? [{ provider, model: { provider: "reviews", model: "reviewer" } }])]),
      ...(axes === undefined ? {} : { resolveAxes: () => Promise.resolve([...axes]) }),
    }));
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

    const { runId, checkpointHash } = seedReviewingRun(store, clock, fixture);
    await engineWith(true, undefined, ["adversarial", "correctness", "regression"]).tickRun(runId);

    expect(provider.calls).toHaveLength(3);
    const executions = store.repos.reviewExecutions.forCheckpoint(runId, checkpointHash);
    expect(executions.some((execution) => execution.error === "no_prior_findings")).toBe(false);
  });

  // AC9. A skip completes without reaching the provider, so it is no evidence the model works and
  // must not lift a sticky 429 exclusion. Before the fix, the synthetic row rehabilitated the model
  // and the next round called it again.
  it("does not let a skipped execution rehabilitate a rate-limited reviewer", async () => {
    const two = new ScriptedProvider("reviews", [
      { name: "limited", capabilities: FAKE_CAPABILITIES.strong },
      { name: "ok", capabilities: FAKE_CAPABILITIES.fast },
    ]);
    two.script("limited", [{ kind: "error", error: new ProviderError("reviews", "rate_limit", "429", { status: 429 }) }]);
    two.script("ok", [
      { kind: "reply", content: emptyReview() },
      { kind: "reply", content: emptyReview() },
    ]);
    const reviewers = [
      { provider: two, model: { provider: "reviews", model: "limited" } },
      { provider: two, model: { provider: "reviews", model: "ok" } },
    ];

    const { runId, checkpointHash } = seedReviewingRun(store, clock, fixture);
    const engine = engineWith(true, reviewers);
    await engine.tickRun(runId);

    const executions = store.repos.reviewExecutions.forCheckpoint(runId, checkpointHash);
    const skipped = executions.filter((execution) => execution.error === "no_prior_findings");
    expect(skipped).toHaveLength(1);
    // MC4: the row names the model that would actually have been called, not the excluded one.
    expect(skipped[0]?.requestedModel.model).toBe("ok");

    expect(excludedModels(store, clock, runId)).toEqual(["limited"]);
  });

  // AC14. The rehabilitation guard itself. `rateLimited` is per-tick, so a model that 429'd in an
  // earlier round can be the preferred model for a later round's skip; the skip row then names it.
  // Without the guard that row lifts the sticky exclusion, and the next round calls the model again
  // even though it has never completed a provider call.
  it("keeps a model excluded when only a skip row names it as completed", () => {
    const { runId } = seedReviewingRun(store, clock, fixture);
    const model = { provider: "reviews", model: "limited" };
    appendExecution(store, clock, runId, {
      roundIndex: 1,
      axis: "adversarial",
      requestedModel: model,
      completed: true,
      error: "no_prior_findings",
      hash: fixture.integrated,
      at: clock.now() + 3,
    });
    appendExecution(store, clock, runId, {
      roundIndex: 2,
      axis: "correctness",
      requestedModel: model,
      completed: false,
      error: "rate limited: 429",
      hash: fixture.integrated,
      at: clock.now() + 4,
    });

    expect(excludedModels(store, clock, runId)).toEqual(["limited"]);
  });

  // AC15. The order AC14 missed, and the dangerous one: the skip lands *after* the 429, so it becomes
  // the latest row for that model. The exclusion loop short-circuits on a completed latest row and
  // never consults `completedKeys`, so guarding only that set left this path open. Reachable across
  // ticks, because `rateLimited` is per-tick: a model that 429'd in an earlier round can be the
  // preferred model for a later round's skip.
  it("keeps a model excluded when a skip lands after its rate-limit failure", () => {
    const { runId } = seedReviewingRun(store, clock, fixture);
    const model = { provider: "reviews", model: "limited" };
    appendExecution(store, clock, runId, {
      roundIndex: 1,
      axis: "correctness",
      requestedModel: model,
      completed: false,
      error: "rate limited: 429",
      hash: fixture.integrated,
      at: clock.now() + 3,
    });
    appendExecution(store, clock, runId, {
      roundIndex: 2,
      axis: "adversarial",
      requestedModel: model,
      completed: true,
      error: "no_prior_findings",
      hash: fixture.integrated,
      at: clock.now() + 4,
    });

    expect(excludedModels(store, clock, runId)).toEqual(["limited"]);
  });

  // AC16. MC2/MC3 scope: the predicate reads this checkpoint and this round. A clean verdict recorded
  // for a different round is no evidence about this one, and dropping the scope filter passed the
  // whole suite before this test existed.
  it("does not skip on a clean verdict from a different round", async () => {
    const { runId } = seedReviewingRun(store, clock, fixture);
    // A complete, entirely clean round 1 moves the driver to round 2, where nothing is observed yet.
    for (const [index, axis] of (["correctness", "regression", "adversarial"] as const).entries()) {
      appendExecution(store, clock, runId, {
        roundIndex: 1,
        axis,
        requestedModel: { provider: "reviews", model: "reviewer" },
        completed: true,
        error: "",
        hash: fixture.integrated,
        at: clock.now() + 3 + index,
      });
    }
    provider
      .script("reviewer", [{ kind: "reply", content: emptyReview() }])
      .script("reviewer", [{ kind: "reply", content: emptyReview() }])
      .script("reviewer", [{ kind: "reply", content: emptyReview() }]);

    await engineWith(true, undefined, ["adversarial", "correctness", "regression"]).tickRun(runId);

    expect(provider.calls.some((call) => (call.messages[1]?.content ?? "").includes('"axis":"adversarial"'))).toBe(true);
  });

  // AC10. Kills the `reviewers[0]` simplification: with the preferred index the adversarial slot
  // resolves to the third model, not the first.
  it("attributes the skip to the reviewer the preferred index selects", async () => {
    const three = new ScriptedProvider("reviews", [
      { name: "m0", capabilities: FAKE_CAPABILITIES.strong },
      { name: "m1", capabilities: FAKE_CAPABILITIES.fast },
      { name: "m2", capabilities: FAKE_CAPABILITIES.fast },
    ]);
    three.script("m0", [{ kind: "reply", content: emptyReview() }]);
    three.script("m1", [{ kind: "reply", content: emptyReview() }]);
    const reviewers = [
      { provider: three, model: { provider: "reviews", model: "m0" } },
      { provider: three, model: { provider: "reviews", model: "m1" } },
      { provider: three, model: { provider: "reviews", model: "m2" } },
    ];

    const { runId, checkpointHash } = seedReviewingRun(store, clock, fixture);
    await engineWith(true, reviewers).tickRun(runId);

    const skipped = store.repos.reviewExecutions
      .forCheckpoint(runId, checkpointHash)
      .filter((execution) => execution.error === "no_prior_findings");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.requestedModel.model).toBe("m2");
    expect(three.calls.some((call) => call.model.model === "m2")).toBe(false);
  });

  // AC11. Kills the "look only at correctness" simplification: MC3 says *every* completed other axis
  // must be clean, and no earlier test had `regression` dirty while `correctness` was clean.
  it("does not skip when only the later earlier-axis reports a finding", async () => {
    provider
      .script("reviewer", [{ kind: "reply", content: emptyReview() }])
      .script("reviewer", [{ kind: "reply", content: reviewJson("regression", "beta.ts") }])
      .script("reviewer", [{ kind: "reply", content: emptyReview() }]);

    const { runId, checkpointHash } = seedReviewingRun(store, clock, fixture);
    await engineWith(true).tickRun(runId);

    expect(provider.calls).toHaveLength(3);
    const executions = store.repos.reviewExecutions.forCheckpoint(runId, checkpointHash);
    expect(executions.some((execution) => execution.error === "no_prior_findings")).toBe(false);
  });

  // AC12. MC3 says *completed* other axes. An incomplete row carries no verdict, so it must not be
  // read as clean. Seeded directly, because the default order cannot reach adversarial with an
  // incomplete earlier axis.
  it("does not treat an incomplete other axis as clean", async () => {
    const incomplete = {
      id: id("rvex", clock.now()),
      runId: "",
      checkpointHash: fixture.integrated,
      roundIndex: 1,
      axis: "correctness" as const,
      requestedModel: { provider: "reviews", model: "reviewer" },
      completed: false,
      findings: [],
      error: "rate limited: 429",
      startedAt: clock.now(),
      finishedAt: clock.now(),
    };
    provider
      .script("reviewer", [{ kind: "reply", content: emptyReview() }])
      .script("reviewer", [{ kind: "reply", content: emptyReview() }])
      .script("reviewer", [{ kind: "reply", content: emptyReview() }]);

    const { runId } = seedReviewingRun(store, clock, fixture);
    store.events.append([{
      id: id("evt", clock.now() + 3),
      runId,
      ts: clock.now() + 3,
      type: "review.finished",
      payload: { execution: { ...incomplete, runId } },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    }]);

    await engineWith(true, undefined, ["adversarial", "correctness", "regression"]).tickRun(runId);

    expect(provider.calls.some((call) => (call.messages[1]?.content ?? "").includes('"axis":"adversarial"'))).toBe(true);
  });

  // AC13. MC4 requires the existing pair, because projections build rows from both events.
  it("emits review.started and review.finished for the skip", async () => {
    provider
      .script("reviewer", [{ kind: "reply", content: emptyReview() }])
      .script("reviewer", [{ kind: "reply", content: emptyReview() }]);

    const { runId } = seedReviewingRun(store, clock, fixture);
    await engineWith(true).tickRun(runId);

    expect(store.events.list(runId, { types: ["review.started"] })).toHaveLength(3);
    expect(store.events.list(runId, { types: ["review.finished"] })).toHaveLength(3);
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

/**
 * R1. An account-scoped 429 is not a property of the model. Contract: `docs/ledger/R1.md`.
 * Placed beside the sticky-exclusion tests above, which are what this changes.
 */
describe("R1 account-scoped rate limits", () => {
  let store: Store;
  let clock: FakeClock;
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await repositoryFixture();
    store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    clock = new FakeClock(1_700_000_000_000);
  });

  afterEach(() => {
    store.close();
  });

  const limited = (scope: "account" | "model") =>
    new ProviderError("reviews", "rate_limit", "rate limited: 429", { status: 429, limitScope: scope });

  const engineWithFive = (scope: "account" | "model"): { engine: RunEngine; provider: ScriptedProvider } => {
    const names = ["m0", "m1", "m2", "m3", "m4"];
    const provider = new ScriptedProvider("reviews", names.map((name) => ({ name, capabilities: FAKE_CAPABILITIES.strong })));
    for (const name of names) {
      provider.script(name, Array.from({ length: 8 }, () => ({ kind: "error" as const, error: limited(scope) })));
    }
    const config = defaultConfig();
    const sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: config.lanes, leaseMs: 60_000 });
    const engine = new RunEngine({ store, clock, scheduler: sched, config, assertProjectClean: () => undefined }, false);
    for (const phase of NON_REVIEW_PHASES) engine.registerPhase(phase, stubDriverFor(phase));
    engine.registerPhase("REVIEWING", createReviewingDriver(
      reviewingOptions(fixture, () => names.map((name) => ({ provider, model: { provider: "reviews", model: name } }))),
    ));
    return { engine, provider };
  };

  // AC1, against the number the plan names: 2,465 of 2,600 executions never reached a model,
  // because each axis walked the whole reviewer list marking every model dead in turn.
  it("calls one model per axis, not one per model, when the account allowance is spent", async () => {
    const { engine, provider } = engineWithFive("account");
    const { runId, checkpointHash } = seedReviewingRun(store, clock, fixture);
    await engine.tickRun(runId);

    expect(provider.calls).toHaveLength(1);
    expect(store.repos.reviewExecutions.forCheckpoint(runId, checkpointHash)).toHaveLength(1);
    // AC3: and nothing is excluded, so the next tick has its reviewers back.
    expect(excludedModels(store, clock, runId)).toEqual([]);
  });

  // AC2. The model-scoped case is the behaviour that already existed and must not move.
  it("still rotates and still excludes when the limit belongs to the model", async () => {
    const { engine, provider } = engineWithFive("model");
    const { runId } = seedReviewingRun(store, clock, fixture);
    await engine.tickRun(runId);

    expect(provider.calls).toHaveLength(5);
    expect(excludedModels(store, clock, runId).sort()).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });

  // The run must still stop rather than wait forever on an allowance that resets at midnight — but
  // the reason it gives has to be the true one. "Non-retryable provider errors" describes a model
  // that cannot answer; this is the opposite claim, and an operator acts differently on each.
  it.each([
    ["[account-scoped rate limit] rate limited: 429", "the provider account's rate limit allowance is exhausted"],
    ["rate limited: 429", "non-retryable provider errors"],
  ] as const)("names the cause when an axis is exhausted by %s", async (error, summaryFragment) => {
    const { runId } = seedReviewingRun(store, clock, fixture);
    const cap = defaultConfig().review.maxAxisAttemptsPerRound;
    for (let attempt = 0; attempt < cap; attempt++) {
      appendExecution(store, clock, runId, {
        roundIndex: 1,
        axis: "correctness",
        requestedModel: { provider: "reviews", model: "m0" },
        completed: false,
        error,
        hash: fixture.integrated,
        at: clock.now() + attempt + 1,
      });
    }
    const { engine } = engineWithFive("account");
    await engine.tickRun(runId);

    const run = store.repos.runs.get(runId)!;
    expect(run.phase).toBe("FAILED");
    expect(run.terminalReason?.summary).toContain(summaryFragment);
  });

  // AC3 at the level the next tick actually reads: a recorded execution error, not an exception.
  it("does not let a recorded account-scoped failure exclude the model on the next tick", () => {
    const { runId } = seedReviewingRun(store, clock, fixture);
    appendExecution(store, clock, runId, {
      roundIndex: 1,
      axis: "correctness",
      requestedModel: { provider: "reviews", model: "m0" },
      completed: false,
      error: "[account-scoped rate limit] rate limited: 429",
      hash: fixture.integrated,
      at: clock.now() + 1,
    });
    appendExecution(store, clock, runId, {
      roundIndex: 1,
      axis: "regression",
      requestedModel: { provider: "reviews", model: "m1" },
      completed: false,
      error: "rate limited: 429",
      hash: fixture.integrated,
      at: clock.now() + 2,
    });

    expect(excludedModels(store, clock, runId)).toEqual(["m1"]);
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

// P1.2. A tail guard, not a saving: observed completions are 435-1,107 tokens, so 1500 does not bind.
// Truncation is a sticky per-model failure, which is a deliberate departure from the plan's wording --
// recording a failed review as completed would lose the distinction convergence depends on.
describe("P1.2 reviewer output cap", () => {
  let store: Store;
  let clock: FakeClock;
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await repositoryFixture();
    store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    clock = new FakeClock(1_700_000_000_000);
  });

  afterEach(() => {
    store.close();
  });

  const engineFor = (
    reviewers: readonly { provider: ScriptedProvider; model: { provider: string; model: string } }[],
  ): RunEngine => {
    const config = defaultConfig();
    const sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: config.lanes, leaseMs: 60_000 });
    const engine = new RunEngine({ store, clock, scheduler: sched, config, assertProjectClean: () => undefined }, false);
    for (const phase of NON_REVIEW_PHASES) engine.registerPhase(phase, stubDriverFor(phase));
    engine.registerPhase("REVIEWING", createReviewingDriver(reviewingOptions(fixture, () => [...reviewers])));
    return engine;
  };

  // AC2
  it("defaults the cap to 1500 on the schema", () => {
    expect(ReviewStrategySchema.parse({}).maxOutputTokens).toBe(1500);
  });

  // AC1
  it("sends the configured cap as maxTokens on every reviewer call", async () => {
    const provider = new ScriptedProvider("reviews", [{ name: "reviewer", capabilities: FAKE_CAPABILITIES.strong }]);
    for (let i = 0; i < 3; i++) provider.script("reviewer", [{ kind: "reply", content: emptyReview() }]);
    const { runId } = seedReviewingRun(store, clock, fixture);
    await engineFor([{ provider, model: { provider: "reviews", model: "reviewer" } }]).tickRun(runId);

    expect(provider.calls).toHaveLength(3);
    expect(provider.calls.every((call) => call.maxTokens === defaultConfig().review.maxOutputTokens)).toBe(true);
  });

  // AC3 and AC5: a truncated body is never parsed, so it can never yield findings.
  it("records a truncated response as a failed execution and raises no findings", async () => {
    const provider = new ScriptedProvider("reviews", [{ name: "reviewer", capabilities: FAKE_CAPABILITIES.strong }]);
    provider.script("reviewer", [{ kind: "reply", content: reviewJson("correctness", "alpha.ts"), finishReason: "length" }]);
    const { runId, checkpointHash } = seedReviewingRun(store, clock, fixture);
    await engineFor([{ provider, model: { provider: "reviews", model: "reviewer" } }]).tickRun(runId);

    const executions = store.repos.reviewExecutions.forCheckpoint(runId, checkpointHash);
    expect(executions.filter((execution) => execution.completed)).toHaveLength(0);
    const failed = executions.filter((execution) => !execution.completed);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toContain("truncated");
    expect(store.repos.findings.listByRun(runId)).toHaveLength(0);
  });

  // AC4: sticky per model, so the axis falls through in the same tick.
  it("falls through to the next model when the first truncates", async () => {
    const provider = new ScriptedProvider("reviews", [
      { name: "verbose", capabilities: FAKE_CAPABILITIES.strong },
      { name: "brief", capabilities: FAKE_CAPABILITIES.fast },
    ]);
    provider.script("verbose", [{ kind: "reply", content: emptyReview(), finishReason: "length" }]);
    provider.script("brief", [
      { kind: "reply", content: emptyReview() },
      { kind: "reply", content: emptyReview() },
      { kind: "reply", content: emptyReview() },
    ]);
    const { runId, checkpointHash } = seedReviewingRun(store, clock, fixture);
    await engineFor([
      { provider, model: { provider: "reviews", model: "verbose" } },
      { provider, model: { provider: "reviews", model: "brief" } },
    ]).tickRun(runId);

    const executions = store.repos.reviewExecutions.forCheckpoint(runId, checkpointHash);
    expect(executions.some((execution) => !execution.completed && execution.requestedModel.model === "verbose")).toBe(true);
    expect(executions.filter((execution) => execution.completed && execution.requestedModel.model === "brief")).toHaveLength(3);
    expect(store.repos.runs.get(runId)?.phase).toBe("VALIDATING");
  });

  // AC6, corrected. Round 1 showed the previous AC6 tested a non-production selector: production
  // `selectReviewProviders` excludes sticky-failed models, so with a pool smaller than
  // `maxAxisAttemptsPerRound` the counter never reaches the cap and the axis sat in REVIEWING forever.
  // This harness models exclusion, which is what the daemon does.
  it("fails visibly, naming the cap, when every available model truncates", async () => {
    const provider = new ScriptedProvider("reviews", [
      { name: "a", capabilities: FAKE_CAPABILITIES.strong },
      { name: "b", capabilities: FAKE_CAPABILITIES.fast },
    ]);
    for (let i = 0; i < 20; i++) {
      provider.script("a", [{ kind: "reply", content: emptyReview(), finishReason: "length" }]);
      provider.script("b", [{ kind: "reply", content: emptyReview(), finishReason: "length" }]);
    }
    const all = [
      { provider, model: { provider: "reviews", model: "a" } },
      { provider, model: { provider: "reviews", model: "b" } },
    ];
    const config = defaultConfig();
    const sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: config.lanes, leaseMs: 60_000 });
    const engine = new RunEngine({ store, clock, scheduler: sched, config, assertProjectClean: () => undefined }, false);
    for (const phase of NON_REVIEW_PHASES) engine.registerPhase(phase, stubDriverFor(phase));
    engine.registerPhase("REVIEWING", createReviewingDriver(reviewingOptions(fixture, (ctx) => {
      const excluded = new Set(recentlyRateLimitedReviewModels(ctx).map((model) => model.model));
      return all.filter((entry) => !excluded.has(entry.model.model));
    })));

    const { runId } = seedReviewingRun(store, clock, fixture);
    for (let tick = 0; tick < 8; tick++) {
      if (store.repos.runs.get(runId)?.phase !== "REVIEWING") break;
      await engine.tickRun(runId);
    }

    const run = store.repos.runs.get(runId)!;
    expect(run.phase).toBe("FAILED");
    expect(run.terminalReason?.code).toBe("providers_unavailable");
    expect(run.terminalReason?.summary).toContain("maxOutputTokens");
    // MC4 requires the value, not just the knob name: an operator who is not told the number does not
    // know what to raise. A mutant dropping it passed the previous suite.
    expect(run.terminalReason?.summary).toContain(String(defaultConfig().review.maxOutputTokens));
  });

  // AC13. MC4 says *every* deterministic exclusion terminates, not only truncation. A mutant that
  // failed on the truncation string alone passed the previous suite.
  it("fails visibly when every model is excluded by a schema rejection", async () => {
    const provider = new ScriptedProvider("reviews", [{ name: "a", capabilities: FAKE_CAPABILITIES.strong }]);
    for (let i = 0; i < 10; i++) {
      provider.script("a", [{ kind: "error", error: new ProviderError("reviews", "bad_request", "bad request (400): JSON mode is not enabled") }]);
    }
    const all = [{ provider, model: { provider: "reviews", model: "a" } }];
    const config = defaultConfig();
    const sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: config.lanes, leaseMs: 60_000 });
    const engine = new RunEngine({ store, clock, scheduler: sched, config, assertProjectClean: () => undefined }, false);
    for (const phase of NON_REVIEW_PHASES) engine.registerPhase(phase, stubDriverFor(phase));
    engine.registerPhase("REVIEWING", createReviewingDriver(reviewingOptions(fixture, (ctx) => {
      const excluded = new Set(recentlyRateLimitedReviewModels(ctx).map((model) => model.model));
      return all.filter((entry) => !excluded.has(entry.model.model));
    })));

    const { runId } = seedReviewingRun(store, clock, fixture);
    for (let tick = 0; tick < 8; tick++) {
      if (store.repos.runs.get(runId)?.phase !== "REVIEWING") break;
      await engine.tickRun(runId);
    }

    const run = store.repos.runs.get(runId)!;
    expect(run.phase).toBe("FAILED");
    expect(run.terminalReason?.code).toBe("providers_unavailable");
    // The exact summary matters: the pre-existing empty-pool path also yields FAILED with the same
    // code, so asserting only phase and code is vacuous -- both branches satisfy it.
    expect(run.terminalReason?.summary).toBe("every reviewer model failed with a non-retryable error");
  });

  // AC8. A rate limit still justifies waiting; only a deterministic exclusion terminates.
  it("keeps waiting when the only exclusion is a rate limit", async () => {
    const provider = new ScriptedProvider("reviews", [{ name: "a", capabilities: FAKE_CAPABILITIES.strong }]);
    for (let i = 0; i < 5; i++) {
      provider.script("a", [{ kind: "error", error: new ProviderError("reviews", "rate_limit", "429", { status: 429 }) }]);
    }
    const all = [{ provider, model: { provider: "reviews", model: "a" } }];
    const config = defaultConfig();
    const sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: config.lanes, leaseMs: 60_000 });
    const engine = new RunEngine({ store, clock, scheduler: sched, config, assertProjectClean: () => undefined }, false);
    for (const phase of NON_REVIEW_PHASES) engine.registerPhase(phase, stubDriverFor(phase));
    engine.registerPhase("REVIEWING", createReviewingDriver(reviewingOptions(fixture, (ctx) => {
      const excluded = new Set(recentlyRateLimitedReviewModels(ctx).map((model) => model.model));
      return all.filter((entry) => !excluded.has(entry.model.model));
    })));

    const { runId } = seedReviewingRun(store, clock, fixture);
    await engine.tickRun(runId);
    await engine.tickRun(runId);

    expect(store.repos.runs.get(runId)?.phase).toBe("REVIEWING");
  });

  // AC7: guards P1.1's MC8a against the new error string.
  it("does not let a truncated execution act as a skip", () => {
    const { runId } = seedReviewingRun(store, clock, fixture);
    const model = { provider: "reviews", model: "limited" };
    appendExecution(store, clock, runId, {
      roundIndex: 1, axis: "correctness", requestedModel: model, completed: false,
      error: "rate limited: 429", hash: fixture.integrated, at: clock.now() + 3,
    });
    appendExecution(store, clock, runId, {
      roundIndex: 1, axis: "regression", requestedModel: model, completed: false,
      error: "reviewer output truncated at the configured token cap", hash: fixture.integrated, at: clock.now() + 4,
    });

    // Both rows are failures, so the model stays excluded; a truncation is not a skip and not a success.
    expect(excludedModels(store, clock, runId)).toEqual(["limited"]);
  });
});

function excludedModels(store: Store, clock: FakeClock, runId: string): string[] {
  const run = store.repos.runs.get(runId)!;
  const scheduler = new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 60_000 });
  return recentlyRateLimitedReviewModels({ run, store, scheduler, clock, config: defaultConfig() })
    .map((model) => model.model);
}

function appendExecution(
  store: Store,
  clock: FakeClock,
  runId: string,
  input: {
    roundIndex: number;
    axis: "correctness" | "regression" | "adversarial";
    requestedModel: { provider: string; model: string };
    completed: boolean;
    error: string;
    hash: string;
    at: number;
  },
): void {
  const execution = {
    id: id("rvex", input.at),
    runId,
    checkpointHash: input.hash,
    roundIndex: input.roundIndex,
    axis: input.axis,
    requestedModel: input.requestedModel,
    completed: input.completed,
    findings: [],
    error: input.error,
    startedAt: input.at,
    finishedAt: input.at,
  };
  store.events.append([{
    id: id("evt", input.at),
    runId,
    ts: input.at,
    type: "review.finished",
    payload: { execution },
    causedBy: [],
    actor: { kind: "system" },
    artifacts: [],
  }]);
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
