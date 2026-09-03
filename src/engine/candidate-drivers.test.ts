import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselineSnapshot } from "../domain/checks.js";
import { defaultConfig } from "../domain/config.js";
import { createTaskFromRequirement } from "../domain/task.js";
import { inspectManifestHashes } from "../project/discovery.js";
import type { ProjectProfile } from "../project/profile.js";
import { CommandPolicy } from "../sandbox/allowlist.js";
import { Git } from "../sandbox/git.js";
import { WorktreeSandbox } from "../sandbox/worktree.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { Scheduler } from "../scheduler/index.js";
import { stubDriverFor } from "./stubs.js";
import { RunEngine } from "./engine.js";
import {
  createExecutingDriver,
  createGatingDriver,
  createIntegratingDriver,
  pickFirstPassedCandidate,
  seedWinnerForTests,
  type CandidateDriverOptions,
} from "./candidateDrivers.js";
import { ScriptedCandidateWorker, type CandidateGates } from "./candidates.js";
import { GitBranchRunHead } from "./integration.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("B2 production candidate drivers", () => {
  let store: Store;
  let clock: FakeClock;
  let sched: Scheduler;
  let engine: RunEngine;
  let fixture: Awaited<ReturnType<typeof repositoryFixture>>;
  let driverOptions: CandidateDriverOptions;

  beforeEach(async () => {
    fixture = await repositoryFixture();
    store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    clock = new FakeClock(1_700_000_000_000);
    sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 60_000 });
    driverOptions = buildDriverOptions(fixture);
    engine = new RunEngine({ store, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined }, false);
    for (const phase of ["CREATED", "DISCOVERING_PROJECT", "BASELINING", "INTERPRETING_MISSION", "DISCOVERING_MODELS", "PLANNING", "REVIEWING", "VALIDATING", "CONVERGENCE_CHECK"] as const) {
      engine.registerPhase(phase, stubDriverFor(phase));
    }
    engine.registerPhase("EXECUTING", createExecutingDriver(driverOptions));
    engine.registerPhase("GATING", createGatingDriver(driverOptions));
    engine.registerPhase("COMPARING", comparingTestDriver());
    engine.registerPhase("INTEGRATING", createIntegratingDriver(driverOptions));
  });

  afterEach(() => {
    store.close();
  });

  it("EXECUTING creates N worktrees with commits and candidate.created events", async () => {
    const { runId, taskId } = seedRun(store, clock, fixture);
    await engine.tickRun(runId);
    const run = store.repos.runs.get(runId)!;
    expect(run.phase).toBe("GATING");
    const candidates = store.repos.candidates.listByTask(taskId);
    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.headCommit !== null)).toBe(true);
    expect(candidates.filter((candidate) => candidate.state === "IMPLEMENTED")).toHaveLength(2);
    expect(store.events.list(runId, { types: ["candidate.created"] })).toHaveLength(2);
    expect(store.events.list(runId, { types: ["candidate.state_changed"] })).toHaveLength(2);
    expect(await fixture.sandbox.list()).toHaveLength(0);
  });

  it("GATING records candidate.gated and separates passing from failing candidates", async () => {
    const { runId, taskId } = seedRun(store, clock, fixture);
    await engine.tickRun(runId);
    await engine.tickRun(runId);
    const run = store.repos.runs.get(runId)!;
    expect(run.phase).toBe("COMPARING");
    const candidates = store.repos.candidates.listByTask(taskId);
    expect(candidates.map((candidate) => candidate.state).sort()).toEqual(["FAILED_GATES", "PASSED_GATES"]);
    expect(store.events.list(runId, { types: ["candidate.gated"] })).toHaveLength(2);
    expect(candidates.find((candidate) => candidate.state === "PASSED_GATES")?.gateReport?.passed).toBe(true);
    expect(candidates.find((candidate) => candidate.state === "FAILED_GATES")?.gateReport?.passed).toBe(false);
  });

  it("INTEGRATING advances the run head only when integration gates pass", async () => {
    const { runId } = seedRun(store, clock, fixture);
    await engine.tickRun(runId);
    await engine.tickRun(runId);
    await engine.tickRun(runId);
    await engine.tickRun(runId);
    const run = store.repos.runs.get(runId)!;
    expect(run.phase).toBe("REVIEWING");
    expect(run.currentCheckpointHash).not.toBe(fixture.base);
    expect(store.events.list(runId, { types: ["integration.started", "integration.finished"] }).length).toBe(2);
    expect(store.events.list(runId, { types: ["checkpoint.created"] })).toHaveLength(1);
    const runHead = new GitBranchRunHead(fixture.repoDir, "run");
    expect(await runHead.read()).toBe(run.currentCheckpointHash);
  });

  it("leaves the run head unchanged when integration gates fail", async () => {
    const failCommit = await commitOnBranch(fixture.repoDir, fixture.base, "winner-fail", "fail");
    const { runId } = seedIntegratingRun(store, clock, fixture, failCommit);
    await engine.tickRun(runId);
    const run = store.repos.runs.get(runId)!;
    expect(run.currentCheckpointHash).toBe(fixture.base);
    const finished = store.events.list(runId, { types: ["integration.finished"] })[0];
    expect(finished?.payload["advanced"]).toBe(false);
    const runHead = new GitBranchRunHead(fixture.repoDir, "run");
    expect(await runHead.read()).toBe(fixture.base);
  });

  it("revalidates a stale winner against the moved head and leaves head unchanged on conflict", async () => {
    const { runId } = seedRun(store, clock, fixture);
    await engine.tickRun(runId);
    await engine.tickRun(runId);
    await engine.tickRun(runId);

    const git = new Git(fixture.repoDir);
    await git.run(["checkout", "-q", "run"]);
    writeFileSync(join(fixture.repoDir, "outcome.txt"), "moved-head");
    const movedHead = await git.commitAll("advance head without integration");
    expect(movedHead).not.toBeNull();
    store.events.append([{
      id: id("evt", clock.now()),
      runId,
      ts: clock.now(),
      type: "run.phase_changed",
      payload: { run: { ...store.repos.runs.get(runId)!, currentCheckpointHash: movedHead, updatedAt: clock.now() } },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    }]);

    await engine.tickRun(runId);
    const runHead = new GitBranchRunHead(fixture.repoDir, "run");
    expect(await runHead.read()).toBe(movedHead);
    const finished = store.events.list(runId, { types: ["integration.finished"] }).at(-1);
    expect(finished?.payload["advanced"]).toBe(false);
    expect(finished?.payload["status"]).toBe("conflict");
  });

  it("treats no_changes as a failed candidate outcome", async () => {
    const emptyFixture = await repositoryFixture();
    const emptyStore = openStore({ artifactsDir: join(emptyFixture.root, "artifacts") });
    const emptyEngine = new RunEngine({
      store: emptyStore,
      clock,
      scheduler: sched,
      config: defaultConfig(),
      assertProjectClean: () => undefined,
    }, false);
    const emptyOptions = buildDriverOptions(emptyFixture, () => new ScriptedCandidateWorker(async () => ({ status: "completed" })));
    emptyEngine.registerPhase("EXECUTING", createExecutingDriver(emptyOptions));
    emptyEngine.registerPhase("GATING", createGatingDriver(emptyOptions));
    emptyEngine.registerPhase("PLANNING", stubDriverFor("PLANNING"));
    const { runId, taskId } = seedRun(emptyStore, clock, emptyFixture);
    await emptyEngine.tickRun(runId);
    const candidates = emptyStore.repos.candidates.listByTask(taskId);
    expect(candidates.every((candidate) => candidate.state === "FAILED_GATES")).toBe(true);
    expect(candidates[0]?.gateReport?.failures[0]?.reason).toBe("no_changes");
    emptyStore.close();
  });

  it("retries EXECUTING after zero survivors instead of waiting on failed candidates", async () => {
    const emptyFixture = await repositoryFixture();
    const emptyStore = openStore({ artifactsDir: join(emptyFixture.root, "artifacts") });
    const emptyEngine = new RunEngine({
      store: emptyStore,
      clock,
      scheduler: sched,
      config: defaultConfig(),
      assertProjectClean: () => undefined,
    }, false);
    const emptyOptions = buildDriverOptions(emptyFixture, () => new ScriptedCandidateWorker(async () => ({ status: "completed" })));
    emptyEngine.registerPhase("EXECUTING", createExecutingDriver(emptyOptions));
    emptyEngine.registerPhase("GATING", createGatingDriver(emptyOptions));
    emptyEngine.registerPhase("PLANNING", stubDriverFor("PLANNING"));
    const { runId, taskId } = seedRun(emptyStore, clock, emptyFixture);
    await emptyEngine.tickRun(runId);
    await emptyEngine.tickRun(runId);
    expect(emptyStore.repos.runs.get(runId)?.phase).toBe("PLANNING");
    expect(emptyStore.repos.tasks.get(taskId)?.state).toBe("READY");
    const firstAttempt = emptyStore.repos.candidates.listByTask(taskId).length;
    await emptyEngine.tickRun(runId);
    await emptyEngine.tickRun(runId);
    expect(emptyStore.repos.runs.get(runId)?.phase).toBe("GATING");
    expect(emptyStore.repos.candidates.listByTask(taskId).length).toBeGreaterThan(firstAttempt);
    emptyStore.close();
  });

  it("does not advance the run head when required runtime validation cannot run", async () => {
    const config = { ...defaultConfig(), runtimeValidation: { mode: "required" as const, level: "smoke" as const } };
    const requiredEngine = new RunEngine({
      store,
      clock,
      scheduler: sched,
      config,
      assertProjectClean: () => undefined,
    }, false);
    requiredEngine.registerPhase("INTEGRATING", createIntegratingDriver(driverOptions));
    const passCommit = await commitOnBranch(fixture.repoDir, fixture.base, "winner-required-runtime", "pass");
    const { runId } = seedIntegratingRun(store, clock, fixture, passCommit);
    await requiredEngine.tickRun(runId);
    const runHead = new GitBranchRunHead(fixture.repoDir, "run");
    expect(await runHead.read()).toBe(fixture.base);
    const finished = store.events.list(runId, { types: ["integration.finished"] })[0];
    expect(finished?.payload["advanced"]).toBe(false);
    expect(finished?.payload["status"]).toBe("failed_runtime");
  });
});

function comparingTestDriver() {
  return (ctx: Parameters<typeof seedWinnerForTests>[0]) => {
    const task = ctx.store.repos.tasks.listByRun(ctx.run.id).find((item) => item.state === "GATED");
    if (task === undefined) return { status: "waiting" as const };
    const winner = pickFirstPassedCandidate(ctx, task.id);
    if (winner === null) return { status: "waiting" as const };
    seedWinnerForTests(ctx, task.id, winner.id);
    return { status: "complete" as const, nextPhase: "INTEGRATING" as const };
  };
}

function buildDriverOptions(
  fixture: Awaited<ReturnType<typeof repositoryFixture>>,
  factory?: () => ScriptedCandidateWorker<{ id: string }>,
): CandidateDriverOptions {
  let sequence = 0;
  return {
    sandbox: fixture.sandbox,
    policy: fixture.policy,
    workerFactory: () => (_index) => {
      if (factory !== undefined) return factory();
      const value = sequence++ === 0 ? "pass" : "fail";
      return new ScriptedCandidateWorker((_task, worktree) => {
        writeFileSync(join(worktree.path, "outcome.txt"), value);
        return { status: "completed" };
      });
    },
    resolveProfile: () => fixture.gates.profile,
    resolveGates: (ctx) => ({
      ...fixture.gates,
      baseline: { ...fixture.gates.baseline, runId: ctx.run.id },
    }),
    resolveRunHead: () => new GitBranchRunHead(fixture.repoDir, "run"),
  };
}

function seedIntegratingRun(
  store: Store,
  clock: FakeClock,
  fixture: Awaited<ReturnType<typeof repositoryFixture>>,
  winnerCommit: string,
): { runId: string; taskId: string } {
  const seeded = seedRun(store, clock, fixture);
  const candidateId = id("cand", clock.now());
  const now = clock.now();
  const candidate = {
    id: candidateId,
    runId: seeded.runId,
    taskId: seeded.taskId,
    attempt: 1,
    model: { provider: "worker", model: "candidate-0" },
    baseCheckpointHash: fixture.base,
    branch: `polish/${seeded.runId}/winner`,
    worktreePath: null,
    headCommit: winnerCommit,
    state: "WINNER" as const,
    gateReport: null,
    transcriptRef: null,
    diffRef: null,
    createdAt: now,
    updatedAt: now,
  };
  const task = {
    ...store.repos.tasks.get(seeded.taskId)!,
    state: "QUEUED_FOR_INTEGRATION" as const,
    selectedCandidateId: candidateId,
    updatedAt: now,
  };
  store.events.append([
    {
      id: id("evt", now),
      runId: seeded.runId,
      ts: now,
      type: "run.phase_changed",
      payload: { run: { ...store.repos.runs.get(seeded.runId)!, phase: "INTEGRATING", updatedAt: now } },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
    {
      id: id("evt", now + 1),
      runId: seeded.runId,
      ts: now + 1,
      type: "candidate.created",
      payload: { candidate },
      causedBy: [],
      actor: { kind: "worker", model: candidate.model },
      artifacts: [],
    },
    {
      id: id("evt", now + 2),
      runId: seeded.runId,
      ts: now + 2,
      type: "task.state_changed",
      payload: { task },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
  ]);
  return seeded;
}

async function commitOnBranch(
  repoDir: string,
  base: string,
  branch: string,
  outcome: string,
): Promise<string> {
  const git = new Git(repoDir);
  await git.run(["checkout", "-q", "-b", branch, base]);
  writeFileSync(join(repoDir, "outcome.txt"), outcome);
  const commit = await git.commitAll(branch);
  if (commit === null) throw new Error("winner commit missing");
  await git.run(["checkout", "-q", "run"]);
  return commit;
}

function seedRun(
  store: Store,
  clock: FakeClock,
  fixture: Awaited<ReturnType<typeof repositoryFixture>>,
): { runId: string; taskId: string } {
  const runId = id("run", clock.now());
  const interpretationId = id("interp", clock.now());
  const task = createTaskFromRequirement(interpretationId, "R1", {
    id: id("task", clock.now()),
    runId,
    title: "Change outcome",
    description: "WHAT: update outcome.txt",
    kind: "bugfix",
    acceptance: ["Checks pass"],
    complexity: "normal",
    baseCheckpointHash: fixture.base,
    now: clock.now(),
  });
  const baseline: BaselineSnapshot = { ...fixture.gates.baseline, id: id("base", clock.now()), runId };
  const run = {
    id: runId,
    missionId: id("msn", clock.now()),
    projectPath: fixture.repoDir,
    runBranch: "run",
    phase: "EXECUTING" as const,
    control: "RUNNING" as const,
    currentCheckpointHash: fixture.base,
    baselineId: baseline.id,
    interpretationId,
    createdAt: clock.now(),
    updatedAt: clock.now(),
    terminalReason: null,
  };
  store.events.append([
    {
      id: id("evt", clock.now()),
      runId,
      ts: clock.now(),
      type: "run.created",
      payload: { run },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
    {
      id: id("evt", clock.now() + 1),
      runId,
      ts: clock.now() + 1,
      type: "baseline.snapshotted",
      payload: { baseline },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
    {
      id: id("evt", clock.now() + 2),
      runId,
      ts: clock.now() + 2,
      type: "task.created",
      payload: { task: { ...task, state: "READY" as const } },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
  ]);
  return { runId, taskId: task.id };
}

async function repositoryFixture(): Promise<{
  root: string;
  repoDir: string;
  base: string;
  sandbox: WorktreeSandbox;
  policy: CommandPolicy;
  gates: CandidateGates;
}> {
  const root = mkdtempSync(join(tmpdir(), "polish-b2-drivers-"));
  cleanup.push(root);
  const repoDir = join(root, "repo");
  const worktrees = join(root, "worktrees");
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "polish-b2-fixture", scripts: {} }));
  const git = await Git.init(repoDir);
  writeFileSync(join(repoDir, "outcome.txt"), "base");
  const base = await git.commitAll("base");
  if (base === null) throw new Error("fixture base commit missing");
  await git.createBranch("run", base);

  const command = [
    "node",
    "-e",
    "process.exit(require('node:fs').readFileSync('outcome.txt','utf8') === 'fail' ? 1 : 0)",
  ];
  const policy = CommandPolicy.forProject([command], null);
  const hashes = inspectManifestHashes(repoDir);
  const scriptsHash = hashes.scriptsHash;
  const profile: ProjectProfile = {
    projectPath: repoDir,
    alias: null,
    packageManager: null,
    framework: "unknown",
    checks: [{ name: "gate", kind: "custom", command, mandatory: true }],
    manifestHashes: hashes.manifestHashes,
    scriptsHash,
    discoveredAt: Date.now(),
  };
  const baselineCheck = {
    name: "gate",
    kind: "custom" as const,
    status: "pass" as const,
    exitCode: 0,
    durationMs: 1,
    summary: null,
    outputRef: null,
  };
  const gates: CandidateGates = {
    profile,
    baseline: {
      id: id("base"),
      runId: id("run"),
      commitHash: base,
      checks: [baselineCheck],
      configHashes: hashes.manifestHashes,
      scriptsHash,
      toolchain: {},
      createdAt: Date.now(),
    },
    acceptanceArtifacts: [],
    materializeAcceptance: () => undefined,
    verifyAcceptance: () => [],
  };
  return {
    root,
    repoDir,
    base,
    sandbox: new WorktreeSandbox(repoDir, worktrees, defaultConfig().sandbox),
    policy,
    gates,
  };
}
