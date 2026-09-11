import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselineSnapshot } from "../domain/checks.js";
import type { Checkpoint } from "../domain/checkpoint.js";
import { defaultConfig } from "../domain/config.js";
import { assertExecutionCheckpoint, isReviewRoundComplete } from "../domain/review.js";
import { ProviderError } from "../broker/types.js";
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

describe("B4 production REVIEWING driver", () => {
  let store: Store;
  let clock: FakeClock;
  let sched: Scheduler;
  let engine: RunEngine;
  let fixture: Fixture;
  let provider: ScriptedProvider;

  beforeEach(async () => {
    fixture = await repositoryFixture();
    store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    clock = new FakeClock(1_700_000_000_000);
    sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 60_000 });
    provider = new ScriptedProvider("reviews", [{ name: "reviewer", capabilities: FAKE_CAPABILITIES.strong }]);
    engine = new RunEngine({ store, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined }, false);
    for (const phase of ["CREATED", "DISCOVERING_PROJECT", "BASELINING", "INTERPRETING_MISSION", "DISCOVERING_MODELS", "PLANNING", "EXECUTING", "GATING", "COMPARING", "INTEGRATING", "VALIDATING", "CONVERGENCE_CHECK"] as const) {
      engine.registerPhase(phase, stubDriverFor(phase));
    }
    engine.registerPhase("REVIEWING", createReviewingDriver(reviewingOptions(fixture, () => [
      { provider, model: { provider: "reviews", model: "reviewer" } },
    ])));
  });

  afterEach(() => {
    store.close();
  });

  it("persists structured findings against the integrated checkpoint hash", async () => {
    scriptReviewResponses(provider, "alpha.ts", "beta.ts", "gamma.ts");
    const { runId, checkpointHash } = seedReviewingRun(store, clock, fixture);
    await engine.tickRun(runId);

    const run = store.repos.runs.get(runId)!;
    expect(run.phase).toBe("VALIDATING");
    const executions = store.repos.reviewExecutions.forCheckpoint(runId, checkpointHash);
    expect(executions).toHaveLength(3);
    expect(executions.every((execution) => execution.completed && execution.checkpointHash === checkpointHash)).toBe(true);
    const findings = store.repos.findings.listByRun(runId);
    expect(findings).toHaveLength(3);
    expect(findings.every((finding) => finding.checkpointHash === checkpointHash && finding.status === "RAW")).toBe(true);
    expect(store.events.list(runId, { types: ["review.started"] })).toHaveLength(3);
    expect(store.events.list(runId, { types: ["review.finished"] })).toHaveLength(3);
  });

  it("keeps reviewer prompts isolated from each other", async () => {
    scriptReviewResponses(provider, "one.ts", "two.ts", "three.ts");
    const { runId } = seedReviewingRun(store, clock, fixture);
    await engine.tickRun(runId);

    const userBodies = provider.calls.map((call) => call.messages[1]?.content ?? "");
    expect(userBodies[0]).toContain('"axis":"correctness"');
    expect(userBodies[0]).not.toContain('"axis":"regression"');
    expect(userBodies[1]).toContain('"axis":"regression"');
    expect(userBodies[1]).not.toContain('"axis":"adversarial"');
    expect(userBodies[2]).toContain('"axis":"adversarial"');
    expect(userBodies[2]).not.toContain('"axis":"correctness"');
  });

  it("rejects review execution evidence recorded for a different checkpoint hash", () => {
    const execution = {
      id: id("rvex", clock.now()),
      runId: id("run", clock.now()),
      checkpointHash: "a".repeat(40),
      roundIndex: 1,
      axis: "correctness" as const,
      requestedModel: { provider: "reviews", model: "reviewer" },
      completed: true,
      findings: [],
      startedAt: clock.now(),
      finishedAt: clock.now(),
    };
    expect(() => {
      assertExecutionCheckpoint(execution, "b".repeat(40));
    }).toThrow(/does not match/);
  });

  it("does not complete the review round when a required reviewer fails", async () => {
    provider
      .script("reviewer", [{ kind: "reply", content: reviewJson("correctness", "a.ts") }])
      .script("reviewer", [{ kind: "error", error: new ProviderError("reviews", "timeout", "timed out") }])
      .script("reviewer", [{ kind: "reply", content: reviewJson("adversarial", "c.ts") }]);

    const { runId, checkpointHash } = seedReviewingRun(store, clock, fixture);
    await engine.tickRun(runId);

    const run = store.repos.runs.get(runId)!;
    expect(run.phase).toBe("REVIEWING");
    const executions = store.repos.reviewExecutions.forCheckpoint(runId, checkpointHash);
    expect(isReviewRoundComplete(executions, checkpointHash, 1, 3)).toBe(false);
    expect(executions.some((execution) => !execution.completed && execution.error !== undefined)).toBe(true);
  });

  it("retries a failed required reviewer on the next tick and can complete the round", async () => {
    provider
      .script("reviewer", [{ kind: "reply", content: reviewJson("correctness", "a.ts") }])
      .script("reviewer", [{ kind: "error", error: new ProviderError("reviews", "timeout", "timed out") }])
      .script("reviewer", [{ kind: "reply", content: reviewJson("adversarial", "c.ts") }])
      .script("reviewer", [{ kind: "reply", content: reviewJson("regression", "b.ts") }]);

    const { runId, checkpointHash } = seedReviewingRun(store, clock, fixture);
    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("REVIEWING");
    await engine.tickRun(runId);

    const run = store.repos.runs.get(runId)!;
    expect(run.phase).toBe("VALIDATING");
    const executions = store.repos.reviewExecutions.forCheckpoint(runId, checkpointHash);
    expect(isReviewRoundComplete(executions, checkpointHash, 1, 3)).toBe(true);
    expect(executions.filter((execution) => execution.completed)).toHaveLength(3);
  });

  it("does not hammer a rate-limited reviewer on the next tick; falls back to another model", async () => {
    const fallback = new ScriptedProvider("reviews", [
      { name: "reviewer", capabilities: FAKE_CAPABILITIES.strong },
      { name: "other", capabilities: FAKE_CAPABILITIES.fast },
    ]);
    fallback.script("reviewer", [{ kind: "error", error: new ProviderError("reviews", "rate_limit", "429", { status: 429 }) }]);
    fallback.script("other", [
      { kind: "reply", content: reviewJson("correctness", "a.ts") },
      { kind: "reply", content: reviewJson("regression", "b.ts") },
      { kind: "reply", content: reviewJson("adversarial", "c.ts") },
    ]);
    engine.registerPhase("REVIEWING", createReviewingDriver(reviewingOptions(fixture, () => [
      { provider: fallback, model: { provider: "reviews", model: "reviewer" } },
      { provider: fallback, model: { provider: "reviews", model: "other" } },
    ])));
    const { runId, checkpointHash } = seedReviewingRun(store, clock, fixture);
    await engine.tickRun(runId);
    const executions = store.repos.reviewExecutions.forCheckpoint(runId, checkpointHash);
    expect(executions.some((execution) => execution.error !== undefined && execution.requestedModel.model === "reviewer")).toBe(true);
    expect(executions.filter((execution) => execution.completed && execution.requestedModel.model === "other").length).toBeGreaterThanOrEqual(1);
    expect(fallback.calls.filter((call) => call.model.model === "reviewer")).toHaveLength(1);
  });

  it("skips a JSON-incapable 400 reviewer in the same tick and uses the next model", async () => {
    const fallback = new ScriptedProvider("reviews", [
      { name: "lyria", capabilities: FAKE_CAPABILITIES.fast },
      { name: "ok", capabilities: FAKE_CAPABILITIES.strong },
    ]);
    fallback.script("lyria", [{
      kind: "error",
      error: new ProviderError("reviews", "bad_request", "JSON mode is not enabled", { status: 400 }),
    }]);
    fallback.script("ok", [
      { kind: "reply", content: reviewJson("correctness", "a.ts") },
      { kind: "reply", content: reviewJson("regression", "b.ts") },
      { kind: "reply", content: reviewJson("adversarial", "c.ts") },
    ]);
    engine.registerPhase("REVIEWING", createReviewingDriver(reviewingOptions(fixture, () => [
      { provider: fallback, model: { provider: "reviews", model: "lyria" } },
      { provider: fallback, model: { provider: "reviews", model: "ok" } },
    ])));
    const { runId, checkpointHash } = seedReviewingRun(store, clock, fixture);
    await engine.tickRun(runId);
    const executions = store.repos.reviewExecutions.forCheckpoint(runId, checkpointHash);
    expect(executions.some((execution) => !execution.completed && execution.requestedModel.model === "lyria")).toBe(true);
    expect(executions.filter((execution) => execution.completed && execution.requestedModel.model === "ok").length).toBeGreaterThanOrEqual(1);
    expect(fallback.calls.filter((call) => call.model.model === "lyria")).toHaveLength(1);
    expect(store.repos.runs.get(runId)?.phase).toBe("VALIDATING");
  });
});

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
  const root = mkdtempSync(join(tmpdir(), "polish-b4-review-"));
  cleanup.push(root);
  const repoDir = join(root, "repo");
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "polish-b4-fixture" }));
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

function scriptReviewResponses(provider: ScriptedProvider, a: string, b: string, c: string): void {
  provider
    .script("reviewer", [{ kind: "reply", content: reviewJson("correctness", a) }])
    .script("reviewer", [{ kind: "reply", content: reviewJson("regression", b) }])
    .script("reviewer", [{ kind: "reply", content: reviewJson("adversarial", c) }]);
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
