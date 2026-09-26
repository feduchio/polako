import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerOutcome } from "../agents/types.js";
import { defaultConfig } from "../domain/config.js";
import { findingFingerprint, type Finding } from "../domain/finding.js";
import { createInvestigationTask } from "../domain/task.js";
import { inspectManifestHashes } from "../project/discovery.js";
import type { ProjectProfile } from "../project/profile.js";
import { CommandPolicy } from "../sandbox/allowlist.js";
import type { ProcessResult } from "../sandbox/process.js";
import { Git } from "../sandbox/git.js";
import type { SandboxHandle } from "../sandbox/worktree.js";
import { WorktreeSandbox } from "../sandbox/worktree.js";
import { Scheduler } from "../scheduler/index.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { createExecutingDriver, type CandidateDriverOptions } from "./candidateDrivers.js";
import { ScriptedCandidateWorker } from "./candidates.js";
import { classifyReproduction, INVESTIGATION_EVENT } from "./investigation.js";
import type { PhaseContext } from "./types.js";

const NOW = 1_700_000_000_000;
const REPRO = ["node", "repro.js"];
const LIMIT_SOURCE = "module.exports = (n) => Math.min(n, 10);\n";

type Script = (worktree: SandboxHandle) => WorkerOutcome;
const openStores: Store[] = [];

describe("investigation tasks", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const store of openStores.splice(0)) store.close();
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("a reproduction that fails when the engine re-runs it makes the finding VALID and creates the fix", async () => {
    const setup = await fixture(cleanup, (worktree) => {
      writeFileSync(join(worktree.path, "repro.js"), "process.exit(require('./limit.js')(20) === 20 ? 0 : 1);\n");
      return { status: "completed", reproduction: { argv: REPRO } };
    });
    const result = await setup.execute();

    expect(result).toEqual({ status: "complete", nextPhase: "PLANNING" });
    expect(setup.store.repos.findings.get(setup.findingId)?.status).toBe("VALID");
    expect(setup.store.repos.tasks.get(setup.taskId)?.state).toBe("SATISFIED");
    const validation = setup.store.repos.validations.listByFinding(setup.findingId).at(-1);
    expect(validation?.method).toBe("deterministic_reproduction");
    expect(validation?.rationale).toMatch(/exit code 1/);
    const fix = setup.store.repos.tasks.listByRun(setup.runId).find((task) => task.origin.kind === "valid_finding");
    expect(fix?.acceptance).toEqual(["`node repro.js` exits 0 with the reproduction files in place"]);
    expect(fix?.description).toContain("REPRODUCTION FILE repro.js:");
    const completed = setup.store.events.list(setup.runId, { types: [INVESTIGATION_EVENT] });
    expect(completed.map((event) => event.payload["verdict"])).toEqual(["VALID"]);
    expect(completed[0]?.payload["addedFiles"]).toEqual(["repro.js"]);
  });

  it("a worker that says the defect is real but whose command passes gets the finding REJECTED", async () => {
    const setup = await fixture(cleanup, (worktree) => {
      writeFileSync(join(worktree.path, "repro.js"), "process.exit(require('./limit.js')(20) === 10 ? 0 : 1);\n");
      return { status: "completed", reproduction: { argv: REPRO } };
    });
    await setup.execute();

    expect(setup.store.repos.findings.get(setup.findingId)?.status).toBe("REJECTED");
    expect(setup.store.repos.tasks.get(setup.taskId)?.state).toBe("SATISFIED");
    expect(setup.store.repos.tasks.listByRun(setup.runId).filter((task) => task.origin.kind === "valid_finding")).toEqual([]);
  });

  it("refuses a reproduction that edits tracked files and leaves the finding UNCERTAIN", async () => {
    const setup = await fixture(cleanup, (worktree) => {
      writeFileSync(join(worktree.path, "limit.js"), "module.exports = (n) => n;\n");
      writeFileSync(join(worktree.path, "repro.js"), "process.exit(1);\n");
      return { status: "completed", reproduction: { argv: REPRO } };
    });
    await setup.execute();

    expect(setup.store.repos.findings.get(setup.findingId)?.status).toBe("UNCERTAIN");
    const task = setup.store.repos.tasks.get(setup.taskId);
    expect(task?.state).toBe("READY");
    expect(task?.attempts).toBe(1);
    const completed = setup.store.events.list(setup.runId, { types: [INVESTIGATION_EVENT] });
    expect(completed[0]?.payload["reason"]).toBe("investigation worker modified tracked files");
  });

  it("blocks the investigation once its attempts are used up", async () => {
    const setup = await fixture(cleanup, () => ({ status: "completed" }), 1);
    await setup.execute();

    expect(setup.store.repos.tasks.get(setup.taskId)?.state).toBe("BLOCKED");
    const completed = setup.store.events.list(setup.runId, { types: [INVESTIGATION_EVENT] });
    expect(completed[0]?.payload).toMatchObject({
      reason: "investigation worker finished without a reproduction command",
      exhausted: true,
    });
  });

  it("records a confirmed reproduction in the mission's acceptance corpus, and a refuted one nowhere", async () => {
    const valid = await fixture(cleanup, (worktree) => {
      writeFileSync(join(worktree.path, "repro.js"), "process.exit(1);\n");
      return { status: "completed", reproduction: { argv: REPRO } };
    });
    await valid.execute();
    const validEntries = corpusEntries(valid.store, valid.runId);
    expect(validEntries).toHaveLength(1);
    expect(validEntries[0]).toMatchObject({ kind: "regression_test", metadata: { findingId: valid.findingId, argv: REPRO } });

    const rejected = await fixture(cleanup, (worktree) => {
      writeFileSync(join(worktree.path, "repro.js"), "process.exit(0);\n");
      return { status: "completed", reproduction: { argv: REPRO } };
    });
    await rejected.execute();
    expect(rejected.store.repos.findings.get(rejected.findingId)?.status).toBe("REJECTED");
    expect(corpusEntries(rejected.store, rejected.runId)).toEqual([]);
  });

  it("a reproduction that never reached the question is retried, not applied as a verdict", async () => {
    const setup = await fixture(cleanup, (worktree) => {
      writeFileSync(join(worktree.path, "repro.js"), "require('./missing-helper.js');\n");
      return { status: "completed", reproduction: { argv: REPRO } };
    });
    await setup.execute();

    expect(setup.store.repos.findings.get(setup.findingId)?.status).toBe("UNCERTAIN");
    expect(setup.store.repos.tasks.get(setup.taskId)?.state).toBe("READY");
    expect(setup.store.repos.validations.listByFinding(setup.findingId)).toEqual([]);
    const completed = setup.store.events.list(setup.runId, { types: [INVESTIGATION_EVENT] });
    expect(completed.map((event) => event.payload["verdict"])).toEqual(["UNCERTAIN", null]);
    expect(completed[1]?.payload["reason"]).toBe("reproduction could not load a module it needs");
  });

  it("retries a worker that failed with the worker's own reason", async () => {
    const setup = await fixture(cleanup, () => ({ status: "failed", error: "worker ran out of turns" }));
    await setup.execute();

    expect(setup.store.repos.findings.get(setup.findingId)?.status).toBe("UNCERTAIN");
    const completed = setup.store.events.list(setup.runId, { types: [INVESTIGATION_EVENT] });
    expect(completed.map((event) => event.payload["reason"])).toEqual(["investigation worker failed: worker ran out of turns"]);
  });

  it("resumes a RUNNING investigation on its current attempt", async () => {
    const setup = await fixture(cleanup, () => ({ status: "completed" }));
    const task = setup.store.repos.tasks.get(setup.taskId)!;
    setup.store.events.append([event(setup.runId, "task.state_changed", { task: { ...task, state: "RUNNING", attempts: 1 } })]);
    await setup.execute();

    const after = setup.store.repos.tasks.get(setup.taskId);
    expect(after).toMatchObject({ state: "READY", attempts: 1 });
    const completed = setup.store.events.list(setup.runId, { types: [INVESTIGATION_EVENT] });
    expect(completed.map((item) => item.payload["attempt"])).toEqual([1]);
    const states = setup.store.events
      .list(setup.runId, { types: ["task.state_changed"] })
      .map((item) => (item.payload["task"] as { state: string }).state);
    expect(states).toEqual(["RUNNING", "READY"]);
  });

  it("cancels an investigation whose finding was decided some other way", async () => {
    const setup = await fixture(cleanup, () => {
      throw new Error("must not run a worker");
    }, undefined, "REJECTED");
    await setup.execute();
    expect(setup.store.repos.tasks.get(setup.taskId)?.state).toBe("CANCELLED");
  });
});

describe("classifyReproduction", () => {
  const base: ProcessResult = {
    argv: REPRO,
    cwd: "/tmp",
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr: "",
    truncated: false,
    timedOut: false,
    aborted: false,
    durationMs: 1,
    startedAt: NOW,
  };

  it("counts only a command that reached the question", () => {
    expect(classifyReproduction(base, []).verdict).toBe("VALID");
    expect(classifyReproduction({ ...base, exitCode: 0 }, []).verdict).toBe("REJECTED");
    expect(classifyReproduction({ ...base, exitCode: 127 }, []).verdict).toBe("UNCERTAIN");
    expect(classifyReproduction({ ...base, stderr: "Error: Cannot find module 'vitest'" }, []).verdict).toBe("UNCERTAIN");
    expect(classifyReproduction({ ...base, timedOut: true, exitCode: null }, []).verdict).toBe("UNCERTAIN");
    const syntax = { ...base, stderr: "/tmp/x/repro.js:1\nSyntaxError: Unexpected token" };
    expect(classifyReproduction(syntax, [{ path: "repro.js" }]).verdict).toBe("UNCERTAIN");
    expect(classifyReproduction(syntax, [{ path: "other.js" }]).verdict).toBe("VALID");
  });

  it("an aborted reproduction says nothing about the finding", () => {
    expect(classifyReproduction({ ...base, aborted: true, exitCode: null }, [])).toEqual({
      verdict: "UNCERTAIN",
      rationale: "reproduction was aborted",
      exitCode: null,
    });
  });
});

function corpusEntries(store: Store, runId: string) {
  return store.repos.acceptanceCorpus.forMission(store.repos.runs.get(runId)!.missionId).entries;
}

async function fixture(
  cleanup: string[],
  script: Script,
  maxAttempts?: number,
  findingStatus: Finding["status"] = "UNCERTAIN",
): Promise<{
  store: Store;
  runId: string;
  taskId: string;
  findingId: string;
  execute: () => ReturnType<ReturnType<typeof createExecutingDriver>>;
}> {
  const root = mkdtempSync(join(tmpdir(), "polish-investigation-"));
  cleanup.push(root);
  const repoDir = join(root, "repo");
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "polish-investigation-fixture", scripts: {} }));
  writeFileSync(join(repoDir, "limit.js"), LIMIT_SOURCE);
  const git = await Git.init(repoDir);
  const base = await git.commitAll("base");
  if (base === null) throw new Error("fixture base commit missing");

  const store = openStore({ artifactsDir: join(root, "artifacts") });
  openStores.push(store);
  const clock = new FakeClock(NOW);
  const config = defaultConfig();
  if (maxAttempts !== undefined) config.retry.maxAttempts = maxAttempts;
  const scheduler = new Scheduler(store, clock, { workerId: "w1", laneLimits: config.lanes, leaseMs: 60_000 });
  const runId = id("run", NOW);
  const finding = uncertainFinding(runId, base);
  const task = createInvestigationTask(finding, 2, {
    id: id("task", NOW),
    runId,
    title: "Investigate limit",
    description: "WHAT: does limit clamp to 10?",
    acceptance: ["The reproduction decides it"],
    complexity: "normal",
    baseCheckpointHash: base,
    now: NOW,
  });
  const hashes = inspectManifestHashes(repoDir);
  const profile: ProjectProfile = {
    projectPath: repoDir,
    alias: null,
    packageManager: null,
    framework: "unknown",
    checks: [],
    manifestHashes: hashes.manifestHashes,
    scriptsHash: hashes.scriptsHash,
    discoveredAt: NOW,
  };
  store.events.append([
    event(runId, "run.created", {
      run: {
        id: runId,
        missionId: id("msn", NOW),
        projectPath: repoDir,
        runBranch: "run",
        phase: "EXECUTING",
        control: "RUNNING",
        currentCheckpointHash: base,
        baselineId: null,
        interpretationId: null,
        createdAt: NOW,
        updatedAt: NOW,
        terminalReason: null,
      },
    }),
    event(runId, "finding.raised", { finding }),
    event(runId, "task.created", { task }),
    ...(findingStatus === "UNCERTAIN"
      ? []
      : [event(runId, "finding.status_changed", { finding: { ...finding, status: findingStatus }, from: "UNCERTAIN", to: findingStatus })]),
  ]);
  const options: CandidateDriverOptions = {
    sandbox: new WorktreeSandbox(repoDir, join(root, "worktrees"), config.sandbox),
    policy: CommandPolicy.forProject([REPRO], null),
    workerFactory: () => () => new ScriptedCandidateWorker((_task, worktree) => script(worktree)),
    resolveGates: () => ({
      profile,
      baseline: {
        id: id("base", NOW),
        runId,
        commitHash: base,
        checks: [],
        configHashes: hashes.manifestHashes,
        scriptsHash: hashes.scriptsHash,
        toolchain: {},
        createdAt: NOW,
      },
      acceptanceArtifacts: [],
      materializeAcceptance: () => undefined,
      verifyAcceptance: () => [],
    }),
  };
  const execute = () => {
    const run = store.repos.runs.get(runId);
    if (run === null) throw new Error("run missing");
    const ctx: PhaseContext = { run, store, scheduler, clock, config };
    return createExecutingDriver(options)(ctx);
  };
  return { store, runId, taskId: task.id, findingId: finding.id, execute };
}

function uncertainFinding(runId: string, checkpointHash: string): Finding {
  const raw = {
    criterion: "correctness.limit",
    severity: "high" as const,
    blocking: true,
    claim: "limit does not clamp values above 10",
    evidence: [{ path: "limit.js", line: 1 }],
    reproduction: [],
  };
  return {
    id: id("find", NOW),
    runId,
    checkpointHash,
    axis: "correctness",
    reportedBy: { kind: "reviewer" },
    status: "UNCERTAIN",
    duplicateOf: null,
    fingerprint: findingFingerprint(raw),
    investigationRounds: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...raw,
  };
}

function event(runId: string, type: string, payload: Record<string, unknown>) {
  return {
    id: id("evt", NOW),
    runId,
    ts: NOW,
    type,
    payload,
    causedBy: [] as string[],
    actor: { kind: "system" as const },
    artifacts: [] as [],
  };
}
