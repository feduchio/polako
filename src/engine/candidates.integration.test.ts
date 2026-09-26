import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcceptanceArtifact } from "../domain/acceptance.js";
import { defaultConfig } from "../domain/config.js";
import type { CheckResult } from "../domain/checks.js";
import { inspectManifestHashes } from "../project/discovery.js";
import type { ProjectProfile } from "../project/profile.js";
import { CommandPolicy } from "../sandbox/allowlist.js";
import { Git } from "../sandbox/git.js";
import { WorktreeSandbox } from "../sandbox/worktree.js";
import { id } from "../shared/ids.js";
import type { SandboxHandle } from "../sandbox/worktree.js";
import {
  noChangeVerdict,
  runCandidatesParallel,
  runGates,
  ScriptedCandidateWorker,
  type CandidateGates,
} from "./candidates.js";
import { GitBranchRunHead, integrateWinner } from "./integration.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("B2 candidate execution", () => {
  it("runs candidates in parallel from the same base and separates passing from failing gates", async () => {
    const fixture = await repositoryFixture();
    let running = 0;
    let peak = 0;
    let sequence = 0;
    const observedBases: string[] = [];
    const worker = new ScriptedCandidateWorker<{ id: string }>(async (_task, worktree) => {
      observedBases.push(worktree.baseCommit);
      running++;
      peak = Math.max(peak, running);
      const value = sequence++ === 0 ? "pass" : "fail";
      await new Promise((resolve) => setTimeout(resolve, 30));
      writeFileSync(join(worktree.path, "outcome.txt"), value);
      running--;
      return { status: "completed" };
    });

    const results = await runCandidatesParallel({
      runId: id("run"),
      task: { id: "task" },
      baseCheckpoint: fixture.base,
      n: 2,
      worker,
      sandbox: fixture.sandbox,
      policy: fixture.policy,
      gates: fixture.gates,
    });

    expect(peak).toBe(2);
    expect(observedBases).toEqual([fixture.base, fixture.base]);
    expect(results.map((result) => result.status).sort()).toEqual(["failed_gates", "passed"]);
    expect(results.every((result) => result.baseCheckpoint === fixture.base)).toBe(true);
    expect(results.every((result) => result.headCommit !== null)).toBe(true);
  });

  it("gives each candidate a fresh worker via workerFactory so mutable state cannot leak", async () => {
    const fixture = await repositoryFixture();
    const seenWorkers: object[] = [];
    let sequence = 0;

    const results = await runCandidatesParallel({
      runId: id("run"),
      task: { id: "task" },
      baseCheckpoint: fixture.base,
      n: 2,
      workerFactory: () => {
        const local = { notes: [] as string[] };
        return new ScriptedCandidateWorker<{ id: string }>((_task, worktree) => {
          seenWorkers.push(local);
          local.notes.push("mine");
          // A shared worker would accumulate notes across candidates; factory isolation keeps one.
          expect(local.notes).toEqual(["mine"]);
          writeFileSync(join(worktree.path, "outcome.txt"), sequence++ === 0 ? "pass" : "fail");
          return { status: "completed" };
        });
      },
      sandbox: fixture.sandbox,
      policy: fixture.policy,
      gates: fixture.gates,
    });

    expect(seenWorkers).toHaveLength(2);
    expect(seenWorkers[0]).not.toBe(seenWorkers[1]);
    expect(results.map((result) => result.status).sort()).toEqual(["failed_gates", "passed"]);
  });

  it("rejects protected-path changes before acceptance materialization", async () => {
    const fixture = await repositoryFixture();
    const artifact: AcceptanceArtifact = {
      id: id("acc"),
      runId: id("run"),
      taskId: null,
      kind: "regression_test",
      relativePath: "protected.txt",
      sha256: "b".repeat(64),
      evidenceFor: null,
      createdAt: Date.now(),
    };
    const materialize = vi.fn();
    const result = await runCandidatesParallel({
      runId: artifact.runId,
      task: { id: "task" },
      baseCheckpoint: fixture.base,
      n: 1,
      worker: new ScriptedCandidateWorker<{ id: string }>((_task, worktree) => {
        writeFileSync(join(worktree.path, artifact.relativePath), "tampered");
        return { status: "completed" };
      }),
      sandbox: fixture.sandbox,
      policy: fixture.policy,
      gates: {
        ...fixture.gates,
        acceptanceArtifacts: [artifact],
        materializeAcceptance: materialize,
      },
    });

    expect(result[0]?.status).toBe("failed_gates");
    expect(result[0]?.gateResult?.candidateProtectedPathProblems).toEqual([
      { path: artifact.relativePath, reason: "modified" },
    ]);
    expect(materialize).not.toHaveBeenCalled();
  });
});

describe("B2 temporary integration workspace", () => {
  it("advances the run head only after integration gates pass", async () => {
    const fixture = await repositoryFixture();
    const winner = await commitOnBranch(fixture.repoDir, fixture.base, "winner-pass", "pass");
    const runHead = new GitBranchRunHead(fixture.repoDir, "run");

    const result = await integrateWinner({
      runId: id("run"),
      winnerCommit: winner,
      sandbox: fixture.sandbox,
      policy: fixture.policy,
      gates: fixture.gates,
      runHead,
    });

    expect(result.status).toBe("integrated");
    expect(result.advanced).toBe(true);
    expect(await runHead.read()).toBe(result.integratedCommit);
    expect(await runHead.read()).not.toBe(fixture.base);
    expect(readFileSync(join(fixture.repoDir, "outcome.txt"), "utf8")).toBe("base");
  });

  it("leaves the run head unchanged when integration gates fail", async () => {
    const fixture = await repositoryFixture();
    const winner = await commitOnBranch(fixture.repoDir, fixture.base, "winner-fail", "fail");
    const runHead = new GitBranchRunHead(fixture.repoDir, "run");

    const result = await integrateWinner({
      runId: id("run"),
      winnerCommit: winner,
      sandbox: fixture.sandbox,
      policy: fixture.policy,
      gates: fixture.gates,
      runHead,
    });

    expect(result.status).toBe("failed_gates");
    expect(result.advanced).toBe(false);
    expect(await runHead.read()).toBe(fixture.base);
  });

  it("leaves the run head unchanged when after-gate runtime validation fails", async () => {
    const fixture = await repositoryFixture();
    const winner = await commitOnBranch(fixture.repoDir, fixture.base, "winner-runtime", "pass");
    const runHead = new GitBranchRunHead(fixture.repoDir, "run");

    const result = await integrateWinner({
      runId: id("run"),
      winnerCommit: winner,
      sandbox: fixture.sandbox,
      policy: fixture.policy,
      gates: fixture.gates,
      runHead,
      afterGates: async () => false,
    });

    expect(result.status).toBe("failed_runtime");
    expect(result.advanced).toBe(false);
    expect(await runHead.read()).toBe(fixture.base);
  });
});

describe("candidate gates prepare the project's dependencies", () => {
  /** A checkout that declares a dependency and has none, like any candidate worktree. */
  function uninstalledCheckout(): string {
    const dir = mkdtempSync(join(tmpdir(), "polish-gate-deps-"));
    cleanup.push(dir);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: "vitest run" }, devDependencies: { vitest: "^4" } }),
    );
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    return dir;
  }

  function scriptedHandle(dir: string, issued: string[][]): SandboxHandle {
    return {
      id: "sb_gate",
      path: dir,
      branch: null,
      baseCommit: "a".repeat(40),
      git: {} as SandboxHandle["git"],
      run: async (argv) => {
        issued.push([...argv]);
        if (argv[1] === "install") { mkdirSync(join(dir, "node_modules", "vitest"), { recursive: true }); writeFileSync(join(dir, "node_modules", "vitest", "package.json"), '{"name":"vitest"}'); }
        return {
          argv: [...argv],
          cwd: dir,
          exitCode: 0,
          signal: null,
          stdout: " Tests  1 passed (1)\n",
          stderr: "",
          truncated: false,
          timedOut: false,
          aborted: false,
          durationMs: 1,
          startedAt: 0,
        };
      },
      headCommit: async () => "a".repeat(40),
      commitAll: async () => null,
      changedFiles: async () => [],
      diffStat: async () => ({ files: 0, insertions: 0, deletions: 0 }),
      diff: async () => "",
      destroy: async () => undefined,
    };
  }

  function gatesFor(dir: string, prepare: boolean): CandidateGates {
    const hashes = inspectManifestHashes(dir);
    const profile: ProjectProfile = {
      projectPath: dir,
      alias: null,
      packageManager: "pnpm",
      framework: "vitest",
      checks: [{ name: "test", kind: "test", command: ["pnpm", "run", "test"], mandatory: true }],
      manifestHashes: hashes.manifestHashes,
      scriptsHash: hashes.scriptsHash,
      discoveredAt: Date.now(),
    };
    return {
      profile,
      baseline: {
        id: id("base"),
        runId: id("run"),
        commitHash: "a".repeat(40),
        checks: [{ name: "test", kind: "test", status: "pass", exitCode: 0, durationMs: 1, summary: null, outputRef: null }],
        configHashes: hashes.manifestHashes,
        scriptsHash: hashes.scriptsHash,
        toolchain: {},
        createdAt: Date.now(),
      },
      acceptanceArtifacts: [],
      verifyAcceptance: () => [],
      materializeAcceptance: () => undefined,
      ...(prepare ? { prepareDependencies: { enabled: true, timeoutMs: 60_000 } } : {}),
    };
  }

  it("installs before gating, so the wall does not simply move from BASELINING to GATING", async () => {
    const dir = uninstalledCheckout();
    const issued: string[][] = [];
    const installs: unknown[] = [];
    const gates = { ...gatesFor(dir, true), onDependencyInstall: (r: unknown) => installs.push(r) };
    await runGates({ runId: id("run"), commitHash: "a".repeat(40), sandbox: scriptedHandle(dir, issued), gates });
    expect(issued[0]).toEqual(["pnpm", "install", "--frozen-lockfile"]);
    expect(issued[1]).toEqual(["pnpm", "run", "test"]);
    expect(installs).toMatchObject([{ attempted: true, ready: true }]);
  });

  it("installs even when the gates do not ask, because omission cannot mean skip", async () => {
    // The mutant this kills: deleting the `prepareDependencies` assignment in `resolveGates`, which
    // a review round did with 93 tests still green. Preparation is not a favour a call site does;
    // saying nothing means prepare, so the deletion loses the operator's setting, not the step.
    const dir = uninstalledCheckout();
    const issued: string[][] = [];
    await runGates({
      runId: id("run"),
      commitHash: "a".repeat(40),
      sandbox: scriptedHandle(dir, issued),
      gates: gatesFor(dir, false),
    });
    expect(issued[0]).toEqual(["pnpm", "install", "--frozen-lockfile"]);
    expect(issued[1]).toEqual(["pnpm", "run", "test"]);
  });
});

async function repositoryFixture(): Promise<{
  repoDir: string;
  base: string;
  sandbox: WorktreeSandbox;
  policy: CommandPolicy;
  gates: CandidateGates;
}> {
  const root = mkdtempSync(join(tmpdir(), "polish-b2-"));
  cleanup.push(root);
  const repoDir = join(root, "repo");
  const worktrees = join(root, "worktrees");
  mkdirSync(repoDir);
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
  const baselineCheck: CheckResult = {
    name: "gate",
    kind: "custom",
    status: "pass",
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
      scriptsHash: hashes.scriptsHash,
      toolchain: {},
      createdAt: Date.now(),
    },
    acceptanceArtifacts: [],
    materializeAcceptance: () => undefined,
    verifyAcceptance: () => [],
  };
  return {
    repoDir,
    base,
    sandbox: new WorktreeSandbox(repoDir, worktrees, defaultConfig().sandbox),
    policy,
    gates,
  };
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
  await git.run(["checkout", "-q", "main"]);
  return commit;
}

describe("the checkout a worker is handed", () => {
  it("is prepared, and reported, before the worker starts", async () => {
    const fixture = await unpreparedRepositoryFixture({ admitInstall: true });
    const order: string[] = [];
    const reported: { ready: boolean; detail: string | null }[] = [];
    const worker = new ScriptedCandidateWorker<{ id: string }>((_task, worktree) => {
      order.push("worker");
      writeFileSync(join(worktree.path, "outcome.txt"), "pass");
      return { status: "completed" };
    });

    await runCandidatesParallel({
      runId: id("run"),
      task: { id: "task" },
      baseCheckpoint: fixture.base,
      n: 1,
      worker,
      sandbox: fixture.sandbox,
      policy: fixture.policy,
      skipGates: true,
      gates: {
        ...fixture.gates,
        // Disabled, so the case is hermetic: no install runs and no network is touched. What is
        // under test is that the worker's own checkout is inspected and the verdict recorded
        // before the worker is handed it, not that an install succeeds.
        prepareDependencies: { enabled: false, timeoutMs: 1_000 },
        onDependencyInstall: (result) => {
          order.push("prepare");
          reported.push({ ready: result.ready, detail: result.detail });
        },
      },
    });

    // Deleting the preparation call site leaves this empty: nothing else reports on the worker's
    // checkout, because the gate checkout is a different sandbox and runs afterwards.
    expect(order).toEqual(["prepare", "worker"]);
    expect(reported).toEqual([{ ready: false, detail: "dependency install is disabled" }]);
  });

  it("issues the install command for it, and does not merely report on it", async () => {
    // The case above fixes the order and nothing else: a preparation step whose body always
    // reported "disabled" without looking at the checkout satisfies it, and a reviewer found
    // exactly that mutant surviving. This one observes the install being issued. It stays hermetic
    // by withholding the install command from the policy, so the sandbox refuses it before a
    // process is spawned -- `npm ci` never runs, and `attempted: true` is reachable only by
    // entering the install path.
    const fixture = await unpreparedRepositoryFixture({ admitInstall: false });
    const started: string[][] = [];
    const attempts: boolean[] = [];
    const worker = new ScriptedCandidateWorker<{ id: string }>((_task, worktree) => {
      writeFileSync(join(worktree.path, "outcome.txt"), "pass");
      return { status: "completed" };
    });

    await runCandidatesParallel({
      runId: id("run"),
      task: { id: "task" },
      baseCheckpoint: fixture.base,
      n: 1,
      worker,
      sandbox: fixture.sandbox,
      policy: fixture.policy,
      skipGates: true,
      gates: {
        ...fixture.gates,
        prepareDependencies: { enabled: true, timeoutMs: 1_000 },
        onDependencyInstallStart: (info) => {
          started.push([...info.command]);
        },
        onDependencyInstall: (result) => {
          attempts.push(result.attempted);
        },
      },
    });

    expect(started).toEqual([["npm", "ci"]]);
    expect(attempts).toEqual([true]);
  });
});

async function unpreparedRepositoryFixture(options: { admitInstall?: boolean } = {}): Promise<{
  base: string;
  sandbox: WorktreeSandbox;
  policy: CommandPolicy;
  gates: CandidateGates;
}> {
  const root = mkdtempSync(join(tmpdir(), "polish-worker-prep-"));
  cleanup.push(root);
  const repoDir = join(root, "repo");
  mkdirSync(repoDir);
  const git = await Git.init(repoDir);
  // A declared dependency and no `node_modules` is what a fresh worktree of a real project looks
  // like, and it is the state that made a worker read a module-resolution error as a test verdict.
  writeFileSync(
    join(repoDir, "package.json"),
    `${JSON.stringify({ name: "fixture", devDependencies: { tsx: "^4.0.0" } }, null, 2)}\n`,
  );
  writeFileSync(join(repoDir, "outcome.txt"), "base");
  const base = await git.commitAll("base");
  if (base === null) throw new Error("fixture base commit missing");
  await git.createBranch("run", base);

  const command = ["npm", "test"];
  const hashes = inspectManifestHashes(repoDir);
  const profile: ProjectProfile = {
    projectPath: repoDir,
    alias: null,
    packageManager: "npm",
    framework: "unknown",
    checks: [{ name: "test", kind: "test", command, mandatory: true }],
    manifestHashes: hashes.manifestHashes,
    scriptsHash: hashes.scriptsHash,
    discoveredAt: Date.now(),
  };
  return {
    base,
    sandbox: new WorktreeSandbox(repoDir, join(root, "worktrees"), defaultConfig().sandbox),
    // `forProject` admits the install command only when it is told the package manager, so
    // withholding it is how a case observes a refused install without spawning one.
    policy: CommandPolicy.forProject([command], options.admitInstall === false ? null : "npm"),
    gates: {
      profile,
      baseline: {
        id: id("base"),
        runId: id("run"),
        commitHash: base,
        checks: [],
        configHashes: hashes.manifestHashes,
        scriptsHash: hashes.scriptsHash,
        toolchain: {},
        createdAt: Date.now(),
      },
      acceptanceArtifacts: [],
      materializeAcceptance: () => undefined,
      verifyAcceptance: () => [],
    },
  };
}

describe("noChangeVerdict", () => {
  const check = (name: string, status: CheckResult["status"]): CheckResult => ({
    name,
    kind: "test",
    status,
    exitCode: status === "pass" ? 0 : 1,
    durationMs: 1,
    summary: null,
    outputRef: null,
  });
  const gate = (checks: CheckResult[], passed = true) => ({
    checks,
    silencing: [],
    acceptanceProblems: [],
    candidateProtectedPathProblems: [],
    regression: { newlyFailing: [], newlyPassing: [], degradedChecks: [], improvedChecks: [] },
    passed,
  }) as unknown as Parameters<typeof noChangeVerdict>[0];
  const profile = {
    checks: [
      { name: "test", kind: "test", command: ["npm", "run", "test"], mandatory: true },
      { name: "lint", kind: "lint", command: ["npm", "run", "lint"], mandatory: false },
    ],
  } as unknown as ProjectProfile;

  it("needs every check to pass outright, not merely to match the baseline", () => {
    expect(noChangeVerdict(gate([check("test", "pass")]), profile)).toBeNull();
    expect(noChangeVerdict(gate([check("test", "pass"), check("lint", "skipped")]), profile)).toBeNull();
    expect(noChangeVerdict(gate([check("test", "fail")]), profile)).toBe("checks do not pass on the unchanged base: test=fail");
    expect(noChangeVerdict(gate([check("test", "skipped")]), profile)).toMatch(/no check ran/);
    expect(noChangeVerdict(gate([check("test", "skipped"), check("lint", "pass")]), profile)).toBe("checks do not pass on the unchanged base: test=skipped");
    expect(noChangeVerdict(gate([]), profile)).toMatch(/no check ran/);
    expect(noChangeVerdict(gate([check("test", "pass")], false), profile)).toBe("gates on the unchanged base did not pass");
  });
});
