import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselineSnapshot, CheckResult } from "../domain/checks.js";
import { defaultConfig } from "../domain/config.js";
import type { Candidate, GateReport } from "../domain/candidate.js";
import { createTaskFromRequirement } from "../domain/task.js";
import { inspectManifestHashes } from "../project/discovery.js";
import type { ProjectProfile } from "../project/profile.js";
import { Git } from "../sandbox/git.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { Scheduler } from "../scheduler/index.js";
import { stubDriverFor } from "./stubs.js";
import { RunEngine } from "./engine.js";
import { createComparingDriver } from "./candidateDrivers.js";
import type { PolishConfig } from "../domain/config.js";
import { VerifierAdapter } from "../verify/sidecar.js";
import type { VerifierStrategy } from "../verify/strategy.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("B3 production comparing driver", () => {
  let store: Store;
  let clock: FakeClock;
  let sched: Scheduler;
  let fixture: Awaited<ReturnType<typeof repositoryFixture>>;
  let strongId: string;
  let weakId: string;
  let tieAId: string;
  let tieBId: string;
  let passId: string;
  let failId: string;

  beforeEach(async () => {
    fixture = await repositoryFixture();
    store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    clock = new FakeClock(1_700_000_000_000);
    sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 60_000 });
    strongId = id("cand", clock.now());
    weakId = id("cand", clock.now() + 1);
    tieAId = id("cand", clock.now() + 2);
    tieBId = id("cand", clock.now() + 3);
    passId = id("cand", clock.now() + 4);
    failId = id("cand", clock.now() + 5);
  });

  afterEach(() => {
    store.close();
  });

  it("records candidate.compared with deterministic winner when one dominates", async () => {
    const { runId, taskId } = seedComparingRun(store, clock, fixture, [
      passedCandidate(strongId, fixture.base, [
        check("gate", "pass"),
        check("extra", "pass", { total: 3, passed: 3, failed: 0, skipped: 0, failingTests: [] }),
      ]),
      passedCandidate(weakId, fixture.base, [
        check("gate", "pass"),
        check("extra", "skipped"),
      ]),
    ]);
    const engine = engineWithComparing();
    await engine.tickRun(runId);

    const compared = store.events.list(runId, { types: ["candidate.compared"] })[0];
    expect(compared?.payload["method"]).toBe("deterministic");
    expect(compared?.payload["winner"]).toBe(strongId);
    expect(compared?.payload["evidence"]).toEqual([]);
    const task = store.repos.tasks.get(taskId);
    expect(task?.selectedCandidateId).toBe(strongId);
    expect(store.repos.candidates.get(strongId)?.state).toBe("WINNER");
    expect(store.repos.candidates.get(weakId)?.state).toBe("LOSER");
  });

  it("records pairwise rationale when metrics tie and scripted judge breaks the tie", async () => {
    const strategy: VerifierStrategy = {
      comparePair: (a, b) => Promise.resolve({
        winner: b.id,
        rationale: `Prefer ${b.id} on scope`,
        scores: { [a.id]: 4, [b.id]: 7 },
      }),
    };
    const { runId } = seedComparingRun(store, clock, fixture, [
      passedCandidate(tieAId, fixture.base, [check("gate", "pass")], { files: 1, insertions: 2, deletions: 0 }),
      passedCandidate(tieBId, fixture.base, [check("gate", "pass")], { files: 1, insertions: 2, deletions: 0 }),
    ]);
    const engine = engineWithComparing({ resolveVerifierStrategy: () => strategy });
    await engine.tickRun(runId);

    const compared = store.events.list(runId, { types: ["candidate.compared"] })[0];
    expect(compared?.payload["method"]).toBe("pairwise");
    expect(compared?.payload["winner"]).toBe(tieBId);
    const evidence = compared?.payload["evidence"] as { rationale: string }[];
    expect(evidence[0]?.rationale).toContain(`Prefer ${tieBId}`);
    expect(compared?.artifacts).toHaveLength(1);
  });

  it("does not invent a winner when no eligible candidates remain", async () => {
    const { runId, taskId } = seedComparingRun(store, clock, fixture, []);
    const engine = engineWithComparing();
    await engine.tickRun(runId);

    const compared = store.events.list(runId, { types: ["candidate.compared"] })[0];
    expect(compared?.payload["winner"]).toBeNull();
    expect(compared?.payload["method"]).toBe("none");
    expect(store.repos.tasks.get(taskId)?.selectedCandidateId).toBeNull();
    expect(store.repos.runs.get(runId)?.phase).toBe("PLANNING");
  });

  it("never selects a failed-gate candidate even when the judge prefers it", async () => {
    const strategy: VerifierStrategy = {
      comparePair: (_a, b) => Promise.resolve({
        winner: b.id,
        rationale: "Judge wants failed candidate",
        scores: { [_a.id]: 1, [b.id]: 10 },
      }),
    };
    const { runId } = seedComparingRun(store, clock, fixture, [
      passedCandidate(passId, fixture.base, [check("gate", "pass")]),
      failedCandidate(failId, fixture.base),
    ]);
    const engine = engineWithComparing({ resolveVerifierStrategy: () => strategy });
    await engine.tickRun(runId);

    const compared = store.events.list(runId, { types: ["candidate.compared"] })[0];
    expect(compared?.payload["winner"]).toBe(passId);
    expect(compared?.payload["method"]).toBe("deterministic");
  });

  it("does not require Python when backend=ts", async () => {
    const { runId } = seedComparingRun(store, clock, fixture, [
      passedCandidate(tieAId, fixture.base, [check("gate", "pass")], { files: 1, insertions: 2, deletions: 0 }),
      passedCandidate(tieBId, fixture.base, [check("gate", "pass")], { files: 1, insertions: 8, deletions: 0 }),
    ]);
    const tsConfig = defaultConfig();
    tsConfig.verifier.backend = "ts";
    const engine = engineWithComparing({}, tsConfig);
    await engine.tickRun(runId);
    const compared = store.events.list(runId, { types: ["candidate.compared"] })[0];
    expect(compared?.payload["backend"]).toBe("ts");
    expect(compared?.payload["fallback"]).toBe(false);
    expect(compared?.payload["client"]).toBe("none");
    expect(compared?.payload["method"]).toBe("pairwise");
    expect(compared?.payload["winner"]).toBe(tieAId);
  });

  it("still yields a tournament result when the sidecar is down", async () => {
    const { runId } = seedComparingRun(store, clock, fixture, [
      passedCandidate(tieAId, fixture.base, [check("gate", "pass")], { files: 1, insertions: 2, deletions: 0 }),
      passedCandidate(tieBId, fixture.base, [check("gate", "pass")], { files: 1, insertions: 8, deletions: 0 }),
    ]);
    const sidecarConfig = defaultConfig();
    sidecarConfig.verifier.backend = "sidecar";
    const engine = engineWithComparing({
      resolveVerifierStrategy: () => new VerifierAdapter({
        command: "__polish_missing_python__",
        requestTimeoutMs: 50,
      }),
    }, sidecarConfig);
    await engine.tickRun(runId);
    const compared = store.events.list(runId, { types: ["candidate.compared"] })[0];
    expect(compared?.payload["backend"]).toBe("sidecar");
    expect(compared?.payload["fallback"]).toBe(true);
    expect(compared?.payload["client"]).toBe("scripted");
    expect(compared?.payload["winner"]).toBe(tieAId);
    expect(store.repos.candidates.get(tieAId)?.state).toBe("WINNER");
  });

  function engineWithComparing(
    extra: { resolveVerifierStrategy?: () => VerifierStrategy } = {},
    config: PolishConfig = defaultConfig(),
  ): RunEngine {
    const engine = new RunEngine({
      store,
      clock,
      scheduler: sched,
      config,
      assertProjectClean: () => undefined,
    }, false);
    for (const phase of ["CREATED", "DISCOVERING_PROJECT", "BASELINING", "INTERPRETING_MISSION", "DISCOVERING_MODELS", "PLANNING", "REVIEWING", "VALIDATING", "CONVERGENCE_CHECK"] as const) {
      engine.registerPhase(phase, stubDriverFor(phase));
    }
    engine.registerPhase("COMPARING", createComparingDriver(extra));
    return engine;
  }
});

function check(
  name: string,
  status: CheckResult["status"],
  summary: CheckResult["summary"] = null,
): CheckResult {
  return {
    name,
    kind: name === "gate" ? "custom" : "test",
    status,
    exitCode: status === "pass" ? 0 : 1,
    durationMs: 1,
    summary,
    outputRef: null,
  };
}

function passedCandidate(
  candidateId: string,
  commitHash: string,
  checks: CheckResult[],
  diffStat: GateReport["diffStat"] = { files: 1, insertions: 2, deletions: 0 },
): Candidate {
  const now = 1;
  return {
    id: candidateId,
    runId: "run_seed",
    taskId: "task_seed",
    attempt: 1,
    model: { provider: "worker", model: candidateId },
    baseCheckpointHash: commitHash,
    branch: candidateId,
    worktreePath: null,
    headCommit: commitHash,
    state: "PASSED_GATES",
    gateReport: {
      gatedCommit: commitHash,
      checks,
      injectedAcceptance: [],
      failures: [],
      passed: true,
      diffStat,
      createdAt: now,
    },
    transcriptRef: null,
    diffRef: null,
    createdAt: now,
    updatedAt: now,
  };
}

function failedCandidate(candidateId: string, commitHash: string): Candidate {
  return {
    ...passedCandidate(candidateId, commitHash, [check("gate", "fail")]),
    state: "FAILED_GATES",
    gateReport: {
      gatedCommit: commitHash,
      checks: [check("gate", "fail")],
      injectedAcceptance: [],
      failures: [{ reason: "mandatory_check_failed", detail: "gate failed" }],
      passed: false,
      diffStat: { files: 1, insertions: 1, deletions: 0 },
      createdAt: 1,
    },
  };
}

function seedComparingRun(
  store: Store,
  clock: FakeClock,
  fixture: Awaited<ReturnType<typeof repositoryFixture>>,
  candidates: Candidate[],
): { runId: string; taskId: string } {
  const runId = id("run", clock.now());
  const interpretationId = id("interp", clock.now());
  const taskId = id("task", clock.now());
  const task = createTaskFromRequirement(interpretationId, "R1", {
    id: taskId,
    runId,
    title: "Compare candidates",
    description: "WHAT: pick best outcome",
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
    phase: "COMPARING" as const,
    control: "RUNNING" as const,
    currentCheckpointHash: fixture.base,
    baselineId: baseline.id,
    interpretationId,
    createdAt: clock.now(),
    updatedAt: clock.now(),
    terminalReason: null,
  };
  const gatedTask = { ...task, state: "GATED" as const, updatedAt: clock.now() };
  const now = clock.now();
  const boundCandidates = candidates.map((candidate) => ({
    ...candidate,
    runId,
    taskId,
    baseCheckpointHash: fixture.base,
  }));
  store.events.append([
    {
      id: id("evt", now),
      runId,
      ts: now,
      type: "run.created",
      payload: { run },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
    {
      id: id("evt", now + 1),
      runId,
      ts: now + 1,
      type: "baseline.snapshotted",
      payload: { baseline },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
    {
      id: id("evt", now + 2),
      runId,
      ts: now + 2,
      type: "task.created",
      payload: { task: gatedTask },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
    ...boundCandidates.map((candidate, index) => ({
      id: id("evt", now + 3 + index),
      runId,
      ts: now + 3 + index,
      type: "candidate.created" as const,
      payload: { candidate },
      causedBy: [] as string[],
      actor: { kind: "worker" as const, model: candidate.model },
      artifacts: [],
    })),
  ]);
  return { runId, taskId };
}

async function repositoryFixture(): Promise<{
  root: string;
  repoDir: string;
  base: string;
  gates: { baseline: BaselineSnapshot; profile: ProjectProfile };
}> {
  const root = mkdtempSync(join(tmpdir(), "polish-b3-comparing-"));
  cleanup.push(root);
  const repoDir = join(root, "repo");
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "polish-b3-fixture", scripts: {} }));
  const git = await Git.init(repoDir);
  writeFileSync(join(repoDir, "outcome.txt"), "base");
  const base = await git.commitAll("base");
  if (base === null) throw new Error("fixture base commit missing");
  await git.createBranch("run", base);

  const command = ["node", "-e", "process.exit(0)"];
  const hashes = inspectManifestHashes(repoDir);
  const profile: ProjectProfile = {
    projectPath: repoDir,
    alias: null,
    packageManager: null,
    framework: "unknown",
    checks: [{ name: "gate", kind: "custom", command, mandatory: true }],
    manifestHashes: hashes.manifestHashes,
    scriptsHash: hashes.scriptsHash,
    discoveredAt: Date.now(),
  };
  const gates = {
    profile,
    baseline: {
      id: id("base"),
      runId: id("run"),
      commitHash: base,
      checks: [{
        name: "gate",
        kind: "custom" as const,
        status: "pass" as const,
        exitCode: 0,
        durationMs: 1,
        summary: null,
        outputRef: null,
      }],
      configHashes: hashes.manifestHashes,
      scriptsHash: hashes.scriptsHash,
      toolchain: {},
      createdAt: Date.now(),
    },
  };
  return { root, repoDir, base, gates };
}
