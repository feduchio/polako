/**
 * P1.8 AC1 and AC2, at the gate. The store-level checks in
 * `src/store/corpus-executable.test.ts` show that an executable can be admitted and that the
 * union is a union; these show that the union is **injected, protected, hash-verified and
 * executed** in the evaluation checkout of a candidate for a **different** task, which is what
 * `docs/PLAN.md` §7 means by the corpus being cumulative and first-class.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SYSTEM_ACTOR } from "../domain/common.js";
import { createMission } from "../domain/mission.js";
import { discoverProject } from "../project/discovery.js";
import { buildBaselineSnapshot, runIndependentGates } from "../project/checkRunner.js";
import type { SandboxHandle } from "../sandbox/worktree.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { MissionAcceptanceService, acceptanceArtifactsForGate } from "../store/missionAcceptance.js";
import { resolveGates } from "./candidateDrivers.js";
import { createTaskFromRequirement } from "../domain/task.js";
import { defaultConfig } from "../domain/config.js";

const NOW = 1_700_000_000_000;
const cleanup: string[] = [];
/** Checkouts whose gate actually executed the injected corpus test. */
const observed = new Set<string>();
/** Prints a marker, so "the check ran it" is observable rather than inferred from an exit code. */
const CORPUS_TEST = "process.stdout.write('CORPUS-REGRESSION-RAN\\n');\n";

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function checkoutSandbox(dir: string, changedFiles: readonly string[] = []): SandboxHandle {
  return {
    id: "sb_1",
    path: dir,
    branch: null,
    baseCommit: "a".repeat(40),
    git: {} as SandboxHandle["git"],
    run: async (argv) => {
      const stdout = execFileSync(argv[0] ?? "node", argv.slice(1), { cwd: dir, encoding: "utf8" });
      if (stdout.includes("CORPUS-REGRESSION-RAN")) observed.add(dir);
      return {
        argv: [...argv],
        cwd: dir,
        exitCode: 0,
        signal: null,
        stdout,
        stderr: "",
        truncated: false,
        timedOut: false,
        aborted: false,
        durationMs: 1,
        startedAt: NOW,
      };
    },
    headCommit: async () => "a".repeat(40),
    commitAll: async () => null,
    changedFiles: async () => [...changedFiles],
    diffStat: async () => ({ files: 0, insertions: 0, deletions: 0 }),
    diff: async () => "",
    destroy: async () => undefined,
  };
}

describe("an admitted corpus executable reaches a later candidate's gate", () => {
  const setUp = () => {
    const home = mkdtempSync(join(tmpdir(), "polish-corpus-gate-home-"));
    cleanup.push(home);
    const store: Store = openStore({ artifactsDir: join(home, "artifacts") });
    const clock = new FakeClock(NOW);
    const corpus = new MissionAcceptanceService(store, clock);
    const mission = createMission({ id: id("msn", NOW), projectPath: "/repo", text: "fix it", createdAt: NOW });
    const runId = id("run", NOW);
    const taskAId = id("task", NOW);
    store.events.append([
      { id: id("evt", NOW), runId, ts: NOW, type: "mission.recorded", payload: { mission }, causedBy: [], actor: SYSTEM_ACTOR, artifacts: [] },
      {
        id: id("evt", NOW),
        runId,
        ts: NOW,
        type: "run.created",
        payload: {
          run: {
            id: runId, missionId: mission.id, projectPath: "/repo", runBranch: "polish/run",
            phase: "CREATED", control: "RUNNING", currentCheckpointHash: null, baselineId: null,
            interpretationId: null, createdAt: NOW, updatedAt: NOW, terminalReason: null,
          },
        },
        causedBy: [], actor: SYSTEM_ACTOR, artifacts: [],
      },
    ]);
    // Task A's finding produced this entry; task A then integrated and admitted its test file.
    const entry = corpus.record({
      missionId: mission.id,
      sourceRunId: runId,
      requirementRef: "R1",
      kind: "regression_test",
      summary: "Validated finding",
      evidenceRefs: [],
      artifactHashes: [],
      metadata: { findingId: id("find", NOW) },
    });
    corpus.admitExecutable({
      entryId: entry.id,
      artifact: {
        id: id("acc", NOW),
        runId,
        // Task A's artifact. Task B's `forTask` must not return it, or the union below is
        // satisfied by the run-scoped lookup and proves nothing.
        taskId: taskAId,
        kind: "regression_test",
        relativePath: "tests/corpus-regression.test.mjs",
        sha256: store.acceptance.putContent(CORPUS_TEST, "corpus:test"),
        evidenceFor: null,
        createdAt: NOW,
      },
    });
    // Task B's own artifacts are empty: the corpus is the only source of a protected path here,
    // which is the whole claim.
    const artifacts = acceptanceArtifactsForGate(
      [],
      corpus.get(mission.id),
      (artifactId) => store.repos.acceptance.get(artifactId) ?? undefined,
    );
    return { store, artifacts, missionId: mission.id, runId, taskAId };
  };

  const checkoutFor = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "polish-corpus-gate-checkout-"));
    cleanup.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
    return dir;
  };

  const gateOver = async (store: Store, artifacts: Parameters<typeof runIndependentGates>[0]["acceptanceArtifacts"], dir: string, changed: readonly string[] = []) => {
    const profile = discoverProject(dir);
    profile.checks = [{
      name: "corpus-regression",
      kind: "custom",
      command: ["node", "tests/corpus-regression.test.mjs"],
      mandatory: true,
    }];
    const baseline = buildBaselineSnapshot({
      runId: id("run", NOW),
      commitHash: "a".repeat(40),
      checks: [],
      profile,
    });
    return runIndependentGates({
      runId: baseline.runId,
      commitHash: baseline.commitHash,
      sandbox: checkoutSandbox(dir, changed),
      profile,
      acceptanceArtifacts: artifacts,
      materializeAcceptance: (checkoutDir, list) => { store.acceptance.materialize(checkoutDir, list); },
      verifyAcceptance: (checkoutDir, list) => store.acceptance.verify(checkoutDir, list),
      baseline,
    });
  };

  it("injects it, hash-verifies it, and the check executes it", async () => {
    const { store, artifacts } = setUp();
    expect(artifacts.map((a) => a.relativePath)).toEqual(["tests/corpus-regression.test.mjs"]);
    const dir = checkoutFor();
    expect(existsSync(join(dir, "tests/corpus-regression.test.mjs"))).toBe(false);

    const result = await gateOver(store, artifacts, dir);
    const ranMarker = observed.has(dir);

    // Injected, with the admitted bytes.
    expect(readFileSync(join(dir, "tests/corpus-regression.test.mjs"), "utf8")).toBe(CORPUS_TEST);
    // Hash-verified: canonical inspection found nothing to report.
    expect(result.acceptanceProblems).toEqual([]);
    // Executed. The marker is the point: a present file that no check runs is the state this
    // item exists to end.
    const ran = result.checks.find((check) => check.name === "corpus-regression");
    expect(ran?.status).toBe("pass");
    expect(ranMarker).toBe(true);
    expect(result.passed).toBe(true);
  });

  /**
   * The call site, not the function. `acceptanceArtifactsForGate` is correct and unwired looks
   * identical from its own check: reverting `createGateDeps` to
   * `ctx.store.repos.acceptance.forTask(...)` alone passes every criterion above.
   */
  it("is what the driver's own gate deps carry", async () => {
    const { store, artifacts, missionId, runId } = setUp();
    const dir = checkoutFor();
    const profile = discoverProject(dir);
    profile.checks = [];
    const baselineId = id("base", NOW);
    const baseline = buildBaselineSnapshot({
      runId, commitHash: "a".repeat(40), checks: [], profile,
    });
    store.events.append([{
      id: id("evt", NOW), runId, ts: NOW, type: "baseline.snapshotted",
      payload: { baseline: { ...baseline, id: baselineId } },
      causedBy: [], actor: SYSTEM_ACTOR, artifacts: [],
    }]);
    const task = createTaskFromRequirement(id("interp", NOW), "R2", {
      id: id("task", NOW), runId, title: "second task", description: "WHAT: second",
      kind: "bugfix", acceptance: ["x"], complexity: "normal",
      baseCheckpointHash: "a".repeat(40), now: NOW,
    });
    const ctx = {
      run: {
        id: runId, missionId, projectPath: dir, runBranch: "polish/run", phase: "GATING" as const,
        control: "RUNNING" as const, currentCheckpointHash: "a".repeat(40), baselineId,
        interpretationId: null, createdAt: NOW, updatedAt: NOW, terminalReason: null,
      },
      store,
      scheduler: {} as never,
      clock: new FakeClock(NOW),
      config: defaultConfig(),
    };
    const gates = await resolveGates(ctx, { resolveProfile: () => profile } as never, task);
    expect(gates.acceptanceArtifacts.map((a) => a.relativePath))
      .toEqual(artifacts.map((a) => a.relativePath));
  });

  it("fails the gate when the candidate has tampered with it", async () => {
    const { store, artifacts } = setUp();
    const dir = checkoutFor();
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, "tests/corpus-regression.test.mjs"), "process.exit(0);\n");

    const result = await gateOver(store, artifacts, dir, ["tests/corpus-regression.test.mjs"]);

    expect(result.passed).toBe(false);
    expect(result.candidateProtectedPathProblems.map((problem) => problem.path))
      .toContain("tests/corpus-regression.test.mjs");
  });
});
