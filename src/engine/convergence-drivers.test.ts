import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BaselineSnapshot } from "../domain/checks.js";
import type { Checkpoint } from "../domain/checkpoint.js";
import { defaultConfig } from "../domain/config.js";
import { hasConverged, type CleanRound } from "../domain/convergence.js";
import type { ReviewExecution } from "../domain/review.js";
import { createTaskFromRequirement } from "../domain/task.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { MissionAcceptanceService } from "../store/missionAcceptance.js";
import { Scheduler } from "../scheduler/index.js";
import { RunEngine } from "./engine.js";
import { createConvergenceDriver } from "./convergenceDrivers.js";
import { createValidatingDriver } from "./reviewDrivers.js";
import { stubDriverFor } from "./stubs.js";

const NOW = 1_700_000_000_000;
const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("B6 production CONVERGENCE_CHECK driver", () => {
  let store: Store;
  let clock: FakeClock;
  let sched: Scheduler;
  let engine: RunEngine;
  let fixture: Fixture;

  beforeEach(() => {
    fixture = repositoryFixture();
    store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    clock = new FakeClock(NOW);
    sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 60_000 });
    engine = new RunEngine({ store, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined }, false);
    for (const phase of ["CREATED", "DISCOVERING_PROJECT", "BASELINING", "INTERPRETING_MISSION", "DISCOVERING_MODELS", "PLANNING", "EXECUTING", "GATING", "COMPARING", "INTEGRATING", "REVIEWING"] as const) {
      engine.registerPhase(phase, stubDriverFor(phase));
    }
    engine.registerPhase("VALIDATING", createValidatingDriver());
    engine.registerPhase("CONVERGENCE_CHECK", createConvergenceDriver());
  });

  afterEach(() => {
    store.close();
  });

  it("rejects DONE for change-required missions missing production evidence", async () => {
    const { runId } = seedConvergenceRun(store, clock, fixture, { withProductionEvidence: false });
    recordCleanRounds(store, clock, runId, fixture.integrated, 3);
    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("FAILED");
  });

  it("stays in REVIEWING when required clean rounds are not met", async () => {
    const { runId } = seedConvergenceRun(store, clock, fixture, { withProductionEvidence: true, cleanRounds: 1 });
    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("REVIEWING");
  });

  it("reaches DONE when anti-fake-DONE, clean rounds, and runtime evidence pass", async () => {
    const { runId } = seedConvergenceRun(store, clock, fixture, {
      withProductionEvidence: true,
      cleanRounds: 3,
      withRuntimeEvidence: true,
    });
    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("DONE");
  });

  it("does not count clean rounds from a previous checkpoint", async () => {
    const { runId } = seedConvergenceRun(store, clock, fixture, { withProductionEvidence: true, cleanRounds: 3 });
    const hashA = fixture.integrated;
    const hashB = "c".repeat(40);
    recordCleanRounds(store, clock, runId, hashA, 3);
    expect(hasConverged(store.repos.cleanRounds.listByRun(runId), hashA, 3)).toBe(true);

    const run = store.repos.runs.get(runId)!;
    store.events.append([{
      id: id("evt", clock.now()),
      runId,
      ts: clock.now(),
      type: "run.phase_changed",
      payload: { run: { ...run, currentCheckpointHash: hashB, updatedAt: clock.now() } },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    }]);
    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("REVIEWING");
  });

  it("rolls back a dominated checkpoint on the integration lane and goes to SIMPLIFYING", async () => {
    const { runId, dominatedHash, priorHash } = seedDominatedConvergenceRun(store, clock, fixture);
    const runHead = {
      read: vi.fn(async () => dominatedHash),
      compareAndSet: vi.fn(async () => true),
    };
    engine.registerPhase("CONVERGENCE_CHECK", createConvergenceDriver({ resolveRunHead: () => runHead }));
    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("SIMPLIFYING");
    expect(store.repos.runs.get(runId)?.currentCheckpointHash).toBe(priorHash);
    expect(runHead.compareAndSet).toHaveBeenCalledWith(dominatedHash, priorHash);
    const rollback = store.repos.checkpoints.listByRun(runId).find((checkpoint) => checkpoint.source === "rollback");
    expect(rollback?.commitHash).toBe(priorHash);
  });

  it("does not persist rollback when run-head CAS fails", async () => {
    const { runId, dominatedHash } = seedDominatedConvergenceRun(store, clock, fixture);
    const runHead = {
      read: vi.fn(async () => dominatedHash),
      compareAndSet: vi.fn(async () => false),
    };
    engine.registerPhase("CONVERGENCE_CHECK", createConvergenceDriver({ resolveRunHead: () => runHead }));
    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("NEEDS_HUMAN");
    expect(store.repos.runs.get(runId)?.currentCheckpointHash).toBe(dominatedHash);
    expect(store.repos.checkpoints.listByRun(runId).some((checkpoint) => checkpoint.source === "rollback")).toBe(false);
  });

  it("blocks DONE when runtime=required and final evidence is missing", async () => {
    const config = defaultConfig();
    config.runtimeValidation.mode = "required";
    engine = new RunEngine({ store, clock, scheduler: sched, config, assertProjectClean: () => undefined }, false);
    for (const phase of ["CREATED", "DISCOVERING_PROJECT", "BASELINING", "INTERPRETING_MISSION", "DISCOVERING_MODELS", "PLANNING", "EXECUTING", "GATING", "COMPARING", "INTEGRATING", "REVIEWING", "VALIDATING"] as const) {
      engine.registerPhase(phase, stubDriverFor(phase));
    }
    engine.registerPhase("CONVERGENCE_CHECK", createConvergenceDriver());
    const { runId } = seedConvergenceRun(store, clock, fixture, { withProductionEvidence: true, cleanRounds: 3 });
    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("REVIEWING");
  });
});

interface Fixture {
  root: string;
  repoDir: string;
  base: string;
  integrated: string;
}

function repositoryFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "polish-b6-"));
  cleanup.push(root);
  const repoDir = join(root, "repo");
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "polish-b6-fixture" }));
  const base = "a".repeat(40);
  const integrated = "b".repeat(40);
  return { root, repoDir, base, integrated };
}

function seedConvergenceRun(
  store: Store,
  clock: FakeClock,
  fixture: Fixture,
  options: {
    withProductionEvidence: boolean;
    cleanRounds?: number;
    withRuntimeEvidence?: boolean;
  },
): { runId: string } {
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
  const events = [
    { id: id("evt", clock.now()), runId, ts: clock.now(), type: "run.created" as const, payload: { run }, causedBy: [] as string[], actor: { kind: "system" as const }, artifacts: [] },
    { id: id("evt", clock.now() + 1), runId, ts: clock.now() + 1, type: "baseline.snapshotted" as const, payload: { baseline }, causedBy: [] as string[], actor: { kind: "system" as const }, artifacts: [] },
    { id: id("evt", clock.now() + 2), runId, ts: clock.now() + 2, type: "task.created" as const, payload: { task }, causedBy: [] as string[], actor: { kind: "system" as const }, artifacts: [] },
    { id: id("evt", clock.now() + 3), runId, ts: clock.now() + 3, type: "checkpoint.created" as const, payload: { checkpoint }, causedBy: [] as string[], actor: { kind: "system" as const }, artifacts: [] },
  ];
  store.events.append(events);

  if (options.withProductionEvidence) {
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
    const reviewExecutions = reviewRound(runId, fixture.integrated, 1);
    store.events.append([
      { id: id("evt", clock.now() + 10), runId, ts: clock.now() + 10, type: "candidate.created", payload: { candidate }, causedBy: [], actor: { kind: "worker", model: candidate.model }, artifacts: [] },
      ...reviewExecutions.map((execution, index) => ({
        id: id("evt", clock.now() + 20 + index),
        runId,
        ts: clock.now() + 20 + index,
        type: "review.finished" as const,
        payload: { execution },
        causedBy: [] as string[],
        actor: { kind: "system" as const },
        artifacts: [],
      })),
    ]);
  }

  if (options.cleanRounds !== undefined && options.cleanRounds > 0) {
    recordCleanRounds(store, clock, runId, fixture.integrated, options.cleanRounds);
  }

  if (options.withRuntimeEvidence) {
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

  return { runId };
}

function seedDominatedConvergenceRun(
  store: Store,
  clock: FakeClock,
  fixture: Fixture,
): { runId: string; dominatedHash: string; priorHash: string } {
  const { runId } = seedConvergenceRun(store, clock, fixture, { withProductionEvidence: true });
  const dominatedHash = "c".repeat(40);
  const prior = store.repos.checkpoints.listByRun(runId)[0]!;
  const dominated: Checkpoint = {
    id: id("cp", clock.now() + 50),
    runId,
    seq: prior.seq + 1,
    commitHash: dominatedHash,
    parentId: prior.id,
    source: "integration",
    taskId: prior.taskId,
    evidence: {
      ...prior.evidence,
      gates: { test: "fail" },
      testsPassed: 0,
      testsFailed: 1,
      testsTotal: 1,
    },
    createdAt: clock.now() + 50,
  };
  const run = store.repos.runs.get(runId)!;
  store.events.append([
    {
      id: id("evt", clock.now() + 51),
      runId,
      ts: clock.now() + 51,
      type: "checkpoint.created",
      payload: { checkpoint: dominated },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
    {
      id: id("evt", clock.now() + 52),
      runId,
      ts: clock.now() + 52,
      type: "run.phase_changed",
      payload: { run: { ...run, currentCheckpointHash: dominatedHash, updatedAt: clock.now() + 52 } },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
  ]);
  return { runId, dominatedHash, priorHash: prior.commitHash };
}

function reviewRound(runId: string, checkpointHash: string, roundIndex: number): ReviewExecution[] {
  return (["correctness", "regression", "adversarial"] as const).map((axis, index) => ({
    id: id("rvex", NOW + index),
    runId,
    checkpointHash,
    roundIndex,
    axis,
    requestedModel: { provider: "p", model: `m${index + 1}` },
    completed: true,
    findings: [],
    startedAt: NOW,
    finishedAt: NOW,
  }));
}

function recordCleanRounds(store: Store, clock: FakeClock, runId: string, checkpointHash: string, count: number): void {
  for (let i = 1; i <= count; i += 1) {
    const cleanRound: CleanRound = {
      id: id("cr", clock.now() + i),
      runId,
      checkpointHash,
      roundIndex: i,
      axes: ["correctness", "regression", "adversarial"],
      ensemble: [
        { provider: "p", model: "m1" },
        { provider: "p", model: "m2" },
        { provider: "p", model: "m3" },
      ],
      rawFindings: 0,
      validatedBlocking: 0,
      novel: true,
      createdAt: clock.now() + i,
    };
    store.events.append([{
      id: id("evt", clock.now() + 100 + i),
      runId,
      ts: clock.now() + 100 + i,
      type: "clean_round.recorded",
      payload: { cleanRound },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    }]);
  }
}
