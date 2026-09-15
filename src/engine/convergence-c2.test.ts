import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BaselineSnapshot } from "../domain/checks.js";
import type { Checkpoint } from "../domain/checkpoint.js";
import { defaultConfig } from "../domain/config.js";
import type { CleanRound } from "../domain/convergence.js";
import type { ReviewExecution } from "../domain/review.js";
import { createTaskFromRequirement } from "../domain/task.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { MissionAcceptanceService } from "../store/missionAcceptance.js";
import { Scheduler } from "../scheduler/index.js";
import { RunEngine } from "./engine.js";
import { createConvergenceDriver } from "./convergenceDrivers.js";
import { stubDriverFor } from "./stubs.js";

const NOW = 1_700_000_000_000;
const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("C2 production CONVERGENCE_CHECK order", () => {
  let store: Store;
  let clock: FakeClock;
  let sched: Scheduler;
  let engine: RunEngine;
  let fixture: { root: string; repoDir: string; base: string; integrated: string };

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "polish-c2-"));
    cleanup.push(root);
    const repoDir = join(root, "repo");
    mkdirSync(repoDir);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "c2" }));
    fixture = { root, repoDir, base: "a".repeat(40), integrated: "b".repeat(40) };
    store = openStore({ artifactsDir: join(root, "artifacts") });
    clock = new FakeClock(NOW);
    sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 60_000 });
    engine = new RunEngine({ store, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined }, false);
    for (const phase of ["CREATED", "DISCOVERING_PROJECT", "BASELINING", "INTERPRETING_MISSION", "DISCOVERING_MODELS", "PLANNING", "EXECUTING", "GATING", "COMPARING", "INTEGRATING", "REVIEWING", "VALIDATING"] as const) {
      engine.registerPhase(phase, stubDriverFor(phase));
    }
    engine.registerPhase("CONVERGENCE_CHECK", createConvergenceDriver());
  });

  afterEach(() => {
    store.close();
  });

  it("exhausted + B6 DONE-eligible produces DONE", async () => {
    const { runId } = seed(store, clock, fixture, { cleanRounds: 3, runtime: true, tokens: 100 });
    const config = defaultConfig();
    config.budget.maxRunTokens = 100;
    engine = new RunEngine({ store, clock, scheduler: sched, config, assertProjectClean: () => undefined }, false);
    engine.registerPhase("CONVERGENCE_CHECK", createConvergenceDriver());
    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("DONE");
    expect(store.events.list(runId, { types: ["pathology.decision"] })).toHaveLength(0);
  });

  it("exhausted + not DONE + pathology produces only BUDGET_STOP FAILED", async () => {
    const { runId } = seed(store, clock, fixture, { cleanRounds: 1, tokens: 50, findingsOscillation: true });
    const config = defaultConfig();
    config.budget.maxRunTokens = 50;
    engine = new RunEngine({ store, clock, scheduler: sched, config, assertProjectClean: () => undefined }, false);
    engine.registerPhase("CONVERGENCE_CHECK", createConvergenceDriver());
    await engine.tickRun(runId);
    const run = store.repos.runs.get(runId);
    expect(run?.phase).toBe("FAILED");
    expect(run?.terminalReason?.code).toBe("budget_exhausted");
    const decisions = store.events.list(runId, { types: ["pathology.decision"] });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.payload["decision"]).toMatchObject({ action: "BUDGET_STOP" });
    expect(store.events.list(runId, { types: ["model.call"] }).every((event) => event.seq < 20 || event.payload["purpose"] !== "c2-forbidden")).toBe(true);
    expect(store.repos.checkpoints.listByRun(runId).some((checkpoint) => checkpoint.source === "rollback")).toBe(false);
  });

  it("duplicate boundary delivery persists one sample and one decision", async () => {
    const { runId } = seed(store, clock, fixture, { cleanRounds: 1, tokens: 10 });
    const config = defaultConfig();
    config.budget.maxRunTokens = 10;
    const driver = createConvergenceDriver();
    const ctx = {
      run: store.repos.runs.get(runId)!,
      store,
      scheduler: sched,
      clock,
      config,
    };
    await driver(ctx);
    await driver({ ...ctx, run: store.repos.runs.get(runId)! });
    expect(store.events.list(runId, { types: ["pathology.sample"] })).toHaveLength(1);
    expect(store.events.list(runId, { types: ["pathology.decision"] })).toHaveLength(1);
    expect(store.events.list(runId, { types: ["pathology.effect_completed"] })).toHaveLength(1);
  });

  it("executes an unexecuted persisted decision once after crash", async () => {
    const { runId } = seed(store, clock, fixture, { cleanRounds: 1, tokens: 8 });
    const config = defaultConfig();
    config.budget.maxRunTokens = 8;
    const sampleEvents = store.events.list(runId);
    const boundary = sampleEvents.at(-1)!;
    store.events.append([
      {
        id: id("evt", clock.now() + 300),
        runId,
        ts: clock.now() + 300,
        type: "pathology.decision",
        payload: {
          decision: {
            version: 1,
            runId,
            boundaryEventId: boundary.id,
            decisionVersion: 1,
            findings: [],
            action: "BUDGET_STOP",
            reason: "pre-persisted",
            budget: { exhaustedDimensions: ["run_tokens"], usageConflict: false },
            targetCheckpointHash: null,
            targetEnsemble: null,
            targetReviewRoundIndex: null,
            causalEventIds: [boundary.id],
          },
        },
        causedBy: [boundary.id],
        actor: { kind: "system" },
        artifacts: [],
      },
    ]);
    engine = new RunEngine({ store, clock, scheduler: sched, config, assertProjectClean: () => undefined }, false);
    engine.registerPhase("CONVERGENCE_CHECK", createConvergenceDriver());
    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("FAILED");
    expect(store.events.list(runId, { types: ["pathology.decision"] })).toHaveLength(1);
    expect(store.events.list(runId, { types: ["pathology.effect_completed"] })).toHaveLength(1);
  });

  it("C2 rollback resumes at REVIEWING and never SIMPLIFYING", async () => {
    const { runId, currentHash, priorHash } = seedOscillating(store, clock, fixture);
    persistOscillationSamples(store, clock, runId, [fixture.integrated, "c".repeat(40), fixture.integrated]);
    const runHead = {
      read: vi.fn(async () => currentHash),
      compareAndSet: vi.fn(async () => true),
    };
    engine.registerPhase(
      "CONVERGENCE_CHECK",
      createConvergenceDriver({
        resolveRunHead: () => runHead,
      }),
    );
    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).not.toBe("SIMPLIFYING");
    const rolled = store.repos.checkpoints.listByRun(runId).some((checkpoint) => checkpoint.source === "rollback");
    if (rolled) {
      expect(store.repos.runs.get(runId)?.phase).toBe("REVIEWING");
      expect(store.repos.runs.get(runId)?.currentCheckpointHash).toBe(priorHash);
    }
  });

  it("four idle CONVERGENCE_CHECK polls without a new observation do not mint four samples or fire no_progress", async () => {
    const { runId } = seed(store, clock, fixture, { cleanRounds: 1 });
    const config = defaultConfig();
    const driver = createConvergenceDriver();
    const ctx = {
      run: store.repos.runs.get(runId)!,
      store,
      scheduler: sched,
      clock,
      config,
    };
    for (let i = 0; i < 4; i += 1) {
      store.events.append([
        {
          id: id("evt", clock.now() + 800 + i),
          runId,
          ts: clock.now() + 800 + i,
          type: "run.phase_changed",
          payload: { run: { ...store.repos.runs.get(runId)!, phase: "CONVERGENCE_CHECK", updatedAt: clock.now() + 800 + i } },
          causedBy: [],
          actor: { kind: "system" },
          artifacts: [],
        },
      ]);
      await driver({ ...ctx, run: store.repos.runs.get(runId)! });
    }
    expect(store.events.list(runId, { types: ["pathology.sample"] })).toHaveLength(1);
    const detected = store.events.list(runId, { types: ["pathology.detected"] });
    expect(detected.every((event) => (event.payload["finding"] as { kind?: string } | undefined)?.kind !== "no_progress")).toBe(true);
    expect(store.events.list(runId, { types: ["pathology.decision"] })).toHaveLength(0);
  });

  it("dominated current with three clean rounds is not DONE", async () => {
    const { runId, currentHash, priorHash } = seedDominatedWithCleanRounds(store, clock, fixture);
    const runHead = {
      read: vi.fn(async () => currentHash),
      compareAndSet: vi.fn(async () => true),
    };
    engine.registerPhase("CONVERGENCE_CHECK", createConvergenceDriver({ resolveRunHead: () => runHead }));
    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).not.toBe("DONE");
    expect(store.repos.runs.get(runId)?.phase).toBe("SIMPLIFYING");
    expect(store.repos.runs.get(runId)?.currentCheckpointHash).toBe(priorHash);
  });

  it("executes only the persisted rollback hash and refuses a worse-than-current target", async () => {
    const { runId, currentHash, worseHash, betterHash } = seedRollbackSwapFixture(store, clock, fixture);
    const boundary = store.events.list(runId).find((event) => event.type === "checkpoint.created" && (event.payload["checkpoint"] as Checkpoint).commitHash === currentHash)!;
    store.events.append([
      {
        id: id("evt", clock.now() + 400),
        runId,
        ts: clock.now() + 400,
        type: "pathology.decision",
        payload: {
          decision: {
            version: 1,
            runId,
            boundaryEventId: boundary.id,
            decisionVersion: 1,
            findings: [],
            action: "ROLLBACK",
            reason: "persisted worse target",
            budget: { exhaustedDimensions: [], usageConflict: false },
            targetCheckpointHash: worseHash,
            targetEnsemble: null,
            targetReviewRoundIndex: null,
            causalEventIds: [boundary.id],
          },
        },
        causedBy: [boundary.id],
        actor: { kind: "system" },
        artifacts: [],
      },
    ]);
    const runHead = {
      read: vi.fn(async () => currentHash),
      compareAndSet: vi.fn(async () => true),
    };
    engine.registerPhase("CONVERGENCE_CHECK", createConvergenceDriver({ resolveRunHead: () => runHead }));
    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("NEEDS_HUMAN");
    expect(store.repos.runs.get(runId)?.currentCheckpointHash).toBe(currentHash);
    expect(store.repos.checkpoints.listByRun(runId).some((checkpoint) => checkpoint.source === "rollback")).toBe(false);
    expect(runHead.compareAndSet).not.toHaveBeenCalled();
    expect(runHead.compareAndSet).not.toHaveBeenCalledWith(currentHash, betterHash);
    expect(runHead.compareAndSet).not.toHaveBeenCalledWith(currentHash, worseHash);
  });
});

function seed(
  store: Store,
  clock: FakeClock,
  fixture: { repoDir: string; root: string; base: string; integrated: string },
  options: { cleanRounds: number; runtime?: boolean; tokens?: number; findingsOscillation?: boolean },
): { runId: string; boundaryId: string } {
  const runId = id("run", clock.now());
  const missionId = id("msn", clock.now());
  const interpretationId = id("interp", clock.now());
  const task = createTaskFromRequirement(interpretationId, "R1", {
    id: id("task", clock.now()),
    runId,
    title: "implement feature",
    description: "WHAT: add feature",
    kind: "feature",
    acceptance: ["feature works"],
    complexity: "normal",
    baseCheckpointHash: fixture.base,
    now: clock.now(),
  });
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
    taskId: task.id,
    evidence: {
      gates: { test: "pass" },
      testsPassed: 1,
      testsFailed: 0,
      testsTotal: 1,
      openValidatedFindings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      diffLinesFromBaseline: 3,
    },
    createdAt: clock.now(),
  };
  const run = {
    id: runId,
    missionId,
    projectPath: fixture.repoDir,
    runBranch: "run",
    phase: "CONVERGENCE_CHECK" as const,
    control: "RUNNING" as const,
    currentCheckpointHash: fixture.integrated,
    baselineId: baseline.id,
    interpretationId: null,
    createdAt: clock.now(),
    updatedAt: clock.now(),
    terminalReason: null,
  };
  const checkpointEvt = id("evt", clock.now() + 3);
  store.events.append([
    { id: id("evt", clock.now()), runId, ts: clock.now(), type: "run.created", payload: { run }, causedBy: [], actor: { kind: "system" }, artifacts: [] },
    { id: id("evt", clock.now() + 1), runId, ts: clock.now() + 1, type: "baseline.snapshotted", payload: { baseline }, causedBy: [], actor: { kind: "system" }, artifacts: [] },
    { id: id("evt", clock.now() + 2), runId, ts: clock.now() + 2, type: "task.created", payload: { task: { ...task, state: "INTEGRATED" as const } }, causedBy: [], actor: { kind: "system" }, artifacts: [] },
    { id: checkpointEvt, runId, ts: clock.now() + 3, type: "checkpoint.created", payload: { checkpoint }, causedBy: [], actor: { kind: "system" }, artifacts: [] },
  ]);
  const candidate = {
    id: id("cand", clock.now()),
    runId,
    taskId: task.id,
    attempt: 1,
    model: { provider: "p", model: "worker" },
    baseCheckpointHash: fixture.base,
    branch: "cand/1",
    worktreePath: join(fixture.root, "wt"),
    headCommit: fixture.integrated,
    state: "PASSED_GATES" as const,
    gateReport: {
      gatedCommit: fixture.integrated,
      checks: [],
      injectedAcceptance: [],
      failures: [],
      passed: true,
      diffStat: { files: 1, insertions: 2, deletions: 0 },
      createdAt: clock.now(),
    },
    transcriptRef: null,
    diffRef: null,
    createdAt: clock.now(),
    updatedAt: clock.now(),
  };
  store.events.append([
    { id: id("evt", clock.now() + 10), runId, ts: clock.now() + 10, type: "candidate.created", payload: { candidate }, causedBy: [], actor: { kind: "worker", model: candidate.model }, artifacts: [] },
  ]);
  for (let roundIndex = 1; roundIndex <= Math.max(options.cleanRounds, 1); roundIndex += 1) {
    for (const [index, execution] of reviewRound(runId, fixture.integrated, roundIndex).entries()) {
      store.events.append([
        {
          id: id("evt", clock.now() + 20 + roundIndex * 10 + index),
          runId,
          ts: clock.now() + 20 + roundIndex * 10 + index,
          type: "review.finished",
          payload: { execution },
          causedBy: [],
          actor: { kind: "system" },
          artifacts: [],
        },
      ]);
    }
  }
  for (let i = 1; i <= options.cleanRounds; i += 1) {
    const proof = reviewRound(runId, fixture.integrated, i);
    const cleanRound: CleanRound = {
      id: id("cr", clock.now() + i),
      runId,
      checkpointHash: fixture.integrated,
      roundIndex: i,
      reviewRoundIndex: i,
      axes: proof.map((execution) => execution.axis),
      ensemble: proof.map((execution) => execution.requestedModel),
      rawFindings: 0,
      validatedBlocking: 0,
      novel: true,
      createdAt: clock.now() + i,
    };
    store.events.append([
      {
        id: id("evt", clock.now() + 100 + i),
        runId,
        ts: clock.now() + 100 + i,
        type: "clean_round.recorded",
        payload: { cleanRound },
        causedBy: [],
        actor: { kind: "system" },
        artifacts: [],
      },
      // R2: `DONE` requires that every model behind a clean round has passed the seeded-defect
      // canary. These fixtures seed the rounds directly, so they seed the verdicts the same way.
      ...cleanRound.ensemble.map((model, index) => ({
        id: id("evt", clock.now() + 200 + i * 10 + index),
        runId,
        ts: clock.now() + 200 + i * 10 + index,
        type: "review.canary_recorded",
        payload: { model, findings: 1, located: 1, verified: true, promptDigest: "d" },
        causedBy: [],
        actor: { kind: "system" as const },
        artifacts: [],
      })),
    ]);
  }
  if (options.runtime === true) {
    const corpus = new MissionAcceptanceService(store, clock);
    corpus.recordRuntimeEvidence({
      missionId,
      requirementRef: "runtime.required_scenario",
      evidence: {
        id: id("rte", clock.now()),
        runId,
        scenarioId: "project-runtime",
        validator: "fixture",
        kind: "node_script",
        status: "passed",
        summary: "runtime passed",
        observations: {},
        checkpointHash: fixture.integrated,
        sideEffects: { policy: "safe", destructiveExternalEffectsAllowed: false },
        artifactHashes: [],
        startedAt: clock.now(),
        finishedAt: clock.now(),
      },
    });
  }
  if (options.tokens !== undefined) {
    store.events.append([
      {
        id: id("evt", clock.now() + 200),
        runId,
        ts: clock.now() + 200,
        type: "model.call",
        payload: { callId: "spend", usage: { inputTokens: options.tokens, outputTokens: 0, costUsd: 0 } },
        causedBy: [],
        actor: { kind: "system" },
        artifacts: [],
      },
      {
        id: id("evt", clock.now() + 201),
        runId,
        ts: clock.now() + 201,
        type: "budget.evaluated",
        payload: { kind: "usage", observedAt: clock.now() + 201 },
        causedBy: [],
        actor: { kind: "system" },
        artifacts: [],
      },
    ]);
  }
  if (options.findingsOscillation === true) {
    const fingerprint = "osc-fp";
    for (const [index, status] of (["VALID", "REJECTED", "VALID", "REJECTED"] as const).entries()) {
      store.events.append([
        {
          id: id("evt", clock.now() + 250 + index),
          runId,
          ts: clock.now() + 250 + index,
          type: "finding.status_changed",
          payload: {
            finding: {
              id: id("find", clock.now() + index),
              runId,
              checkpointHash: fixture.integrated,
              axis: "correctness",
              reportedBy: { kind: "reviewer", model: { provider: "p", model: "m" } },
              status,
              duplicateOf: null,
              fingerprint,
              investigationRounds: 0,
              criterion: "c",
              severity: "high",
              blocking: true,
              claim: "osc",
              evidence: [],
              reproduction: ["x"],
              createdAt: clock.now(),
              updatedAt: clock.now(),
            },
            from: "VALIDATING",
            to: status,
          },
          causedBy: [],
          actor: { kind: "system" },
          artifacts: [],
        },
      ]);
    }
  }
  return { runId, boundaryId: checkpointEvt };
}

function seedDominatedWithCleanRounds(
  store: Store,
  clock: FakeClock,
  fixture: { repoDir: string; root: string; base: string; integrated: string },
): { runId: string; currentHash: string; priorHash: string } {
  const { runId } = seed(store, clock, fixture, { cleanRounds: 0, runtime: true });
  const currentHash = "c".repeat(40);
  const prior = store.repos.checkpoints.listByRun(runId)[0]!;
  const dominated: Checkpoint = {
    id: id("cp", clock.now() + 90),
    runId,
    seq: prior.seq + 1,
    commitHash: currentHash,
    parentId: prior.id,
    source: "integration",
    taskId: prior.taskId,
    evidence: {
      ...prior.evidence,
      testsPassed: 0,
      testsFailed: 0,
      testsTotal: 1,
    },
    createdAt: clock.now() + 90,
  };
  const run = store.repos.runs.get(runId)!;
  store.events.append([
    {
      id: id("evt", clock.now() + 91),
      runId,
      ts: clock.now() + 91,
      type: "checkpoint.created",
      payload: { checkpoint: dominated },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
    {
      id: id("evt", clock.now() + 92),
      runId,
      ts: clock.now() + 92,
      type: "run.phase_changed",
      payload: { run: { ...run, currentCheckpointHash: currentHash, updatedAt: clock.now() + 92 } },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
  ]);
  const corpus = new MissionAcceptanceService(store, clock);
  corpus.recordRuntimeEvidence({
    missionId: run.missionId,
    requirementRef: "runtime.required_scenario",
    evidence: {
      id: id("rte", clock.now() + 93),
      runId,
      scenarioId: "project-runtime",
      validator: "fixture",
      kind: "node_script",
      status: "passed",
      summary: "runtime passed",
      observations: {},
      checkpointHash: currentHash,
      sideEffects: { policy: "safe", destructiveExternalEffectsAllowed: false },
      artifactHashes: [],
      startedAt: clock.now(),
      finishedAt: clock.now(),
    },
  });
  for (let i = 1; i <= 3; i += 1) {
    const proof = reviewRound(runId, currentHash, i, 1_000);
    for (const [index, execution] of proof.entries()) {
      store.events.append([
        {
          id: id("evt", clock.now() + 300 + i * 10 + index),
          runId,
          ts: clock.now() + 300 + i * 10 + index,
          type: "review.finished",
          payload: { execution },
          causedBy: [],
          actor: { kind: "system" },
          artifacts: [],
        },
      ]);
    }
    store.events.append([
      {
        id: id("evt", clock.now() + 400 + i),
        runId,
        ts: clock.now() + 400 + i,
        type: "clean_round.recorded",
        payload: {
          cleanRound: {
            id: id("cr", clock.now() + 200 + i),
            runId,
            checkpointHash: currentHash,
            roundIndex: i,
            reviewRoundIndex: i,
            axes: proof.map((execution) => execution.axis),
            ensemble: proof.map((execution) => execution.requestedModel),
            rawFindings: 0,
            validatedBlocking: 0,
            novel: true,
            createdAt: clock.now() + i,
          },
        },
        causedBy: [],
        actor: { kind: "system" },
        artifacts: [],
      },
    ]);
  }
  return { runId, currentHash, priorHash: prior.commitHash };
}

function seedRollbackSwapFixture(
  store: Store,
  clock: FakeClock,
  fixture: { repoDir: string; root: string; base: string; integrated: string },
): { runId: string; currentHash: string; worseHash: string; betterHash: string } {
  const { runId } = seed(store, clock, fixture, { cleanRounds: 1 });
  const first = store.repos.checkpoints.listByRun(runId)[0]!;
  const betterHash = "d".repeat(40);
  const worseHash = "e".repeat(40);
  const currentHash = "f".repeat(40);
  const better: Checkpoint = {
    ...first,
    id: id("cp", clock.now() + 60),
    seq: first.seq + 1,
    commitHash: betterHash,
    parentId: first.id,
    evidence: { ...first.evidence, testsPassed: 3, testsFailed: 0, testsTotal: 3 },
    createdAt: clock.now() + 60,
  };
  const worse: Checkpoint = {
    ...first,
    id: id("cp", clock.now() + 70),
    seq: better.seq + 1,
    commitHash: worseHash,
    parentId: better.id,
    evidence: { ...first.evidence, testsPassed: 0, testsFailed: 1, testsTotal: 1 },
    createdAt: clock.now() + 70,
  };
  const current: Checkpoint = {
    ...first,
    id: id("cp", clock.now() + 80),
    seq: worse.seq + 1,
    commitHash: currentHash,
    parentId: worse.id,
    evidence: { ...first.evidence, testsPassed: 1, testsFailed: 0, testsTotal: 1 },
    createdAt: clock.now() + 80,
  };
  const run = store.repos.runs.get(runId)!;
  store.events.append([
    {
      id: id("evt", clock.now() + 61),
      runId,
      ts: clock.now() + 61,
      type: "checkpoint.created",
      payload: { checkpoint: better },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
    {
      id: id("evt", clock.now() + 71),
      runId,
      ts: clock.now() + 71,
      type: "checkpoint.created",
      payload: { checkpoint: worse },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
    {
      id: id("evt", clock.now() + 81),
      runId,
      ts: clock.now() + 81,
      type: "checkpoint.created",
      payload: { checkpoint: current },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
    {
      id: id("evt", clock.now() + 82),
      runId,
      ts: clock.now() + 82,
      type: "run.phase_changed",
      payload: { run: { ...run, currentCheckpointHash: currentHash, updatedAt: clock.now() + 82 } },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
  ]);
  return { runId, currentHash, worseHash, betterHash };
}

function persistOscillationSamples(store: Store, clock: FakeClock, runId: string, hashes: string[]): void {
  hashes.forEach((hash, index) => {
    store.events.append([
      {
        id: id("evt", clock.now() + 600 + index),
        runId,
        ts: clock.now() + 600 + index,
        type: "pathology.sample",
        payload: {
          sample: {
            version: 1,
            runId,
            boundaryEventId: id("evt", clock.now() + 500 + index),
            boundarySeq: 50 + index,
            observedAt: clock.now() + index,
            checkpointHash: hash,
            findingObservations: [],
            progress: {
              checkpointHash: hash,
              evidence: null,
              integratedTaskIds: [],
              resolvedValidBlockingFingerprints: [],
              successfulGateFingerprints: [],
              acceptedEvidenceRefs: [],
              cleanRoundKeys: [],
            },
            disagreementRounds: [],
            taskIds: [],
            taskWorkClasses: [],
            budget: {
              runTokens: 0,
              knownRunUsd: 0,
              unknownCostCalls: [],
              perTask: {},
              sourceWatermark: null,
              usageConflict: false,
              elapsedMs: 0,
              limits: { maxRunTokens: null, maxRunUsd: null, maxTaskTokens: null, maxRunWallClockMinutes: null },
              unusedCliMetadata: { budgetTokens: null, budgetUsd: null, applied: false },
              exhaustedDimensions: [],
            },
          },
        },
        causedBy: [],
        actor: { kind: "system" },
        artifacts: [],
      },
    ]);
  });
}

function seedOscillating(
  store: Store,
  clock: FakeClock,
  fixture: { repoDir: string; root: string; base: string; integrated: string },
): { runId: string; currentHash: string; priorHash: string } {
  const { runId } = seed(store, clock, fixture, { cleanRounds: 1 });
  const currentHash = "c".repeat(40);
  const prior = store.repos.checkpoints.listByRun(runId)[0]!;
  const dominated: Checkpoint = {
    id: id("cp", clock.now() + 90),
    runId,
    seq: prior.seq + 1,
    commitHash: currentHash,
    parentId: prior.id,
    source: "integration",
    taskId: prior.taskId,
    evidence: {
      ...prior.evidence,
      testsPassed: 0,
      testsFailed: 0,
      testsTotal: 1,
    },
    createdAt: clock.now() + 90,
  };
  const run = store.repos.runs.get(runId)!;
  store.events.append([
    {
      id: id("evt", clock.now() + 91),
      runId,
      ts: clock.now() + 91,
      type: "checkpoint.created",
      payload: { checkpoint: dominated },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
    {
      id: id("evt", clock.now() + 92),
      runId,
      ts: clock.now() + 92,
      type: "run.phase_changed",
      payload: { run: { ...run, currentCheckpointHash: currentHash, updatedAt: clock.now() + 92 } },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
  ]);
  return { runId, currentHash, priorHash: prior.commitHash };
}

function reviewRound(runId: string, checkpointHash: string, roundIndex: number, salt = 0): ReviewExecution[] {
  return (["correctness", "regression", "adversarial"] as const).map((axis, index) => ({
    id: id("rvex", NOW + salt + roundIndex * 10 + index),
    runId,
    checkpointHash,
    roundIndex,
    axis,
    requestedModel: { provider: "p", model: `m${index + 1}` },
    completed: true,
    findings: [],
    startedAt: NOW + roundIndex,
    finishedAt: NOW + roundIndex,
  }));
}
