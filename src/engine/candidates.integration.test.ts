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
import {
  runCandidatesParallel,
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
