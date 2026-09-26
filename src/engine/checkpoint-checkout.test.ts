import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProductionDeps, installProductionDrivers } from "../daemon/composition.js";
import type { BaselineSnapshot } from "../domain/checks.js";
import type { Checkpoint } from "../domain/checkpoint.js";
import { defaultConfig } from "../domain/config.js";
import { findingFingerprint, type Finding } from "../domain/finding.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { Git } from "../sandbox/git.js";
import { WorktreeSandbox, type CreateSandboxInput, type Sandbox, type SandboxHandle } from "../sandbox/worktree.js";
import { PolishError } from "../shared/errors.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { Scheduler } from "../scheduler/index.js";
import { RunEngine } from "./engine.js";
import { runAxisReview, type RunAxisReviewResult } from "../review/swarm.js";
import { CheckpointCheckoutEvidenceWorker, detachedCheckoutPolicy } from "./checkpointCheckout.js";
import { createReviewingDriver, createValidatingDriver, type ReviewDriverOptions } from "./reviewDrivers.js";
import { stubDriverFor } from "./stubs.js";

const NOW = 1_700_000_000_000;
const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("B-selfhost-5 checkpoint checkout isolation", () => {
  it("REVIEWING uses an isolated checkout: clean wrong-HEAD user files are not evidence", async () => {
    const fixture = await polarityRepo();
    const created: CheckoutSnap[] = [];
    const destroyed: string[] = [];
    const usedRoots: { path: string; head: string }[] = [];
    const reviewed: RunAxisReviewResult[] = [];
    const { engine, store, clock } = reviewingHarness(
      fixture,
      spySandbox(fixture, created, destroyed),
      (provider) => {
        provider
          .script("reviewer", [{ kind: "reply", content: reviewJson("correctness", "checkpoint-only.ts") }])
          .script("reviewer", [{ kind: "reply", content: reviewJson("regression", "user-only.ts") }])
          .script("reviewer", [{ kind: "reply", content: reviewJson("adversarial", "checkpoint-only.ts") }]);
      },
      async (input) => {
        const root = input.repositoryRoot;
        expect(root).toBeDefined();
        usedRoots.push({ path: realpathSync(root!), head: await new Git(root!).revParse() });
        const result = await runAxisReview(input);
        reviewed.push(result);
        return result;
      },
    );
    const { runId } = seedRun(store, clock, fixture, "REVIEWING");
    await engine.tickRun(runId);

    expect(created).toHaveLength(1);
    const snap = created[0]!;
    expect(snap.head).toBe(fixture.checkpoint);
    expect(snap.path).not.toBe(realpathSync(fixture.repoDir));
    expect(snap.hasCheckpointFile).toBe(true);
    expect(snap.hasUserFile).toBe(false);
    expect(existsSync(join(fixture.repoDir, "user-only.ts"))).toBe(true);
    expect(existsSync(join(fixture.repoDir, "checkpoint-only.ts"))).toBe(false);
    expect(destroyed).toEqual([snap.id]);
    expect(store.repos.runs.get(runId)?.phase).toBe("VALIDATING");

    expect(usedRoots.length).toBeGreaterThan(0);
    for (const used of usedRoots) {
      expect(used.path).not.toBe(realpathSync(fixture.repoDir));
      expect(used.head).toBe(fixture.checkpoint);
    }
    const findings = reviewed.flatMap((item) => item.findings);
    const userOnly = findings.find((finding) => finding.evidence.some((ref) => ref.path === "user-only.ts"));
    expect(userOnly).toBeDefined();
    expect(userOnly!.evidenceIssues.some((issue) => /does not exist/i.test(issue))).toBe(true);
    const checkpointOnly = findings.find((finding) => finding.evidence.some((ref) => ref.path === "checkpoint-only.ts"));
    expect(checkpointOnly).toBeDefined();
    expect(checkpointOnly!.evidenceIssues).toEqual([]);
  });

  it("destroys a created checkout when isolation assert fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "polish-b5-destroy-"));
    cleanup.push(root);
    const destroyed: string[] = [];
    const handle: SandboxHandle = {
      id: "val-leak",
      path: root,
      branch: null,
      baseCommit: "a".repeat(40),
      git: new Git(root),
      run: async () => {
        throw new Error("unused");
      },
      headCommit: async () => "a".repeat(40),
      commitAll: async () => null,
      changedFiles: async () => [],
      diffStat: async () => ({ files: 0, insertions: 0, deletions: 0 }),
      diff: async () => "",
      destroy: async () => {
        destroyed.push("val-leak");
      },
    };
    const sandbox: Sandbox = {
      kind: "worktree",
      isolates: false,
      create: async () => handle,
      list: async () => [],
      destroyAll: async () => undefined,
    };
    const worker = new CheckpointCheckoutEvidenceWorker({
      sandbox,
      policy: detachedCheckoutPolicy(),
      projectPath: root,
      persistOutput: () => ({ sha256: "c".repeat(64), kind: "test_output", bytes: 0 }),
      now: () => NOW,
      nextId: () => "val-leak",
    });
    const result = await worker.reproduce(testFinding("a".repeat(40)));
    expect(result.verdict).toBe("UNCERTAIN");
    expect(result.rationale).toMatch(/must not equal run.projectPath/);
    expect(destroyed).toEqual(["val-leak"]);
  });

  it("VALIDATING checks out the finding's checkpoint and runs nothing the finding names", async () => {
    const fixture = await polarityRepo({ withTests: true });
    const created: CheckoutSnap[] = [];
    const destroyed: string[] = [];
    const { engine, store, clock } = validatingHarness(fixture, spySandbox(fixture, created, destroyed));
    const { runId } = seedRun(store, clock, fixture, "VALIDATING", [testFinding(fixture.checkpoint)]);
    await engine.tickRun(runId);

    expect(created.some((snap) => snap.baseCommit === fixture.checkpoint)).toBe(true);
    expect(created.every((snap) => snap.path !== realpathSync(fixture.repoDir))).toBe(true);
    expect(created.every((snap) => snap.head === fixture.checkpoint)).toBe(true);
    const finding = store.repos.findings.listByRun(runId)[0]!;
    expect(finding.status).toBe("UNCERTAIN");
    expect(store.repos.validations.listByFinding(finding.id).flatMap((validation) => validation.evidenceRefs)).toEqual([]);
    expect(destroyed.length).toBeGreaterThanOrEqual(1);
    expect(destroyed).toEqual(created.map((snap) => snap.id));
  });

  it("tryRuntime discovery uses the checkpoint checkout, not a user-only fixture", async () => {
    const fixture = await polarityRepo({ withUserRuntime: true });
    const { engine, store, clock } = validatingHarness(fixture, realSandbox(fixture));
    const { runId } = seedRun(store, clock, fixture, "VALIDATING", [runtimeFinding(fixture.checkpoint)]);
    await engine.tickRun(runId);
    const finding = store.repos.findings.listByRun(runId)[0]!;
    expect(finding.status).toBe("UNCERTAIN");
    const validation = store.repos.validations.listByFinding(finding.id)[0];
    expect(validation?.verdict).toBe("UNCERTAIN");
    expect(validation?.rationale ?? "").toMatch(/no runtime\/ directory|no safe scenario|runtime reproduction requested/i);
  });

  it("zero-option drivers fail closed and never root evidence at projectPath", async () => {
    const fixture = await polarityRepo({ withTests: true });
    const reviewing = reviewingHarness(fixture, undefined, (provider) => {
      provider.script("reviewer", [{ kind: "reply", content: reviewJson("correctness", "user-only.ts") }]);
    });
    const reviewRun = seedRun(reviewing.store, reviewing.clock, fixture, "REVIEWING");
    await expect(reviewing.engine.tickRun(reviewRun.runId)).rejects.toThrow(/sandbox/i);
    expect(reviewing.store.repos.reviewExecutions.listByRun(reviewRun.runId).filter((item) => item.completed)).toHaveLength(0);

    const validating = validatingHarness(fixture, undefined);
    const validateRun = seedRun(validating.store, validating.clock, fixture, "VALIDATING", [testFinding(fixture.checkpoint)]);
    await expect(validating.engine.tickRun(validateRun.runId)).rejects.toThrow(/sandbox/i);
    expect(validating.store.repos.findings.listByRun(validateRun.runId)[0]?.status).toBe("RAW");
  });

  it("installProductionDrivers default VALIDATING worker checkouts finding.checkpointHash", async () => {
    const fixture = await polarityRepo({ withTests: true });
    const created: CheckoutSnap[] = [];
    const destroyed: string[] = [];
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    cleanup.push(join(fixture.root, "artifacts"));
    const clock = new FakeClock(NOW);
    const config = defaultConfig();
    const provider = new ScriptedProvider("scripted", [
      { name: "worker", capabilities: FAKE_CAPABILITIES.frontier },
      { name: "planner", capabilities: FAKE_CAPABILITIES.strong },
      { name: "judge", capabilities: FAKE_CAPABILITIES.strong },
    ]);
    const sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: config.lanes, leaseMs: 60_000 });
    const engine = new RunEngine({ store, clock, scheduler: sched, config, assertProjectClean: () => undefined }, false);
    const deps = buildProductionDeps({
      store,
      clock,
      config,
      home: join(fixture.root, "home"),
      providers: [provider],
      resolveSandbox: () => spySandbox(fixture, created, destroyed),
    });
    installProductionDrivers(engine, deps);
    const { runId } = seedRun(store, clock, fixture, "VALIDATING", [testFinding(fixture.checkpoint)]);
    await engine.tickRun(runId);
    expect(created.some((snap) => snap.baseCommit === fixture.checkpoint)).toBe(true);
    expect(created.every((snap) => snap.path !== realpathSync(fixture.repoDir))).toBe(true);
    expect(store.repos.findings.listByRun(runId)[0]?.status).toBe("UNCERTAIN");
    expect(destroyed.length).toBeGreaterThanOrEqual(1);
    store.close();
  });

  it("create failure is recorded and does not hang or fall back to projectPath", async () => {
    const fixture = await polarityRepo({ withTests: true });
    const failing = failingSandbox();
    const reviewing = reviewingHarness(fixture, failing, (provider) => {
      provider.script("reviewer", [{ kind: "reply", content: "[]" }]);
    });
    const reviewRun = seedRun(reviewing.store, reviewing.clock, fixture, "REVIEWING");
    await expect(reviewing.engine.tickRun(reviewRun.runId)).rejects.toThrow(/checkout failed|create failed/i);
    const failed = reviewing.store.repos.reviewExecutions.listByRun(reviewRun.runId);
    expect(failed.some((item) => item.error !== undefined && !item.completed)).toBe(true);
    expect(reviewing.store.repos.runs.get(reviewRun.runId)?.phase).toBe("REVIEWING");

    const validating = validatingHarness(fixture, failing);
    const validateRun = seedRun(validating.store, validating.clock, fixture, "VALIDATING", [testFinding(fixture.checkpoint)]);
    await validating.engine.tickRun(validateRun.runId);
    expect(validating.store.repos.findings.listByRun(validateRun.runId)[0]?.status).toBe("UNCERTAIN");
  });

  it("assigns unique checkout ids across findings", async () => {
    const fixture = await polarityRepo({ withTests: true });
    const ids: string[] = [];
    const inner = realSandbox(fixture);
    const sandbox: Sandbox = {
      kind: inner.kind,
      isolates: inner.isolates,
      create: async (input) => {
        ids.push(input.id);
        return inner.create(input);
      },
      list: () => inner.list(),
      destroyAll: () => inner.destroyAll(),
    };
    const { engine, store, clock } = validatingHarness(fixture, sandbox);
    const first = testFinding(fixture.checkpoint);
    const second = testFinding(fixture.checkpoint, { id: id("find", NOW + 3), claim: "a second failing test", createdAt: NOW + 3, updatedAt: NOW + 3 });
    const { runId } = seedRun(store, clock, fixture, "VALIDATING", [first, second]);
    await engine.tickRun(runId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(2);
  });
});

interface Fixture {
  root: string;
  repoDir: string;
  base: string;
  checkpoint: string;
  userHead: string;
}

interface CheckoutSnap {
  id: string;
  path: string;
  head: string;
  baseCommit: string;
  hasCheckpointFile: boolean;
  hasUserFile: boolean;
}

async function polarityRepo(opts: { withTests?: boolean; withUserRuntime?: boolean } = {}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "polish-b5-checkout-"));
  cleanup.push(root);
  const repoDir = join(root, "repo");
  mkdirSync(repoDir);
  const passingTest = [
    "console.log('TAP version 13');",
    "console.log('1..1');",
    "console.log('ok 1 checkpoint');",
    "process.exit(0);",
  ].join("\n");
  const failingTest = [
    "console.log('TAP version 13');",
    "console.log('1..1');",
    "console.log('not ok 1 user-only');",
    "process.exit(1);",
  ].join("\n");
  const pkg = (script: string) => JSON.stringify({ name: "polish-b5-checkout", private: true, scripts: { test: script } }, null, 2);
  writeFileSync(join(repoDir, "package.json"), pkg("node tests/repro.test.mjs"));
  writeFileSync(join(repoDir, "README.md"), "base\n");
  const git = await Git.init(repoDir);
  const base = await git.commitAll("base");
  if (base === null) throw new Error("base commit missing");
  await git.createBranch("run", base);
  mkdirSync(join(repoDir, "tests"), { recursive: true });
  if (opts.withTests === true) {
    writeFileSync(join(repoDir, "tests/repro.test.mjs"), passingTest);
  }
  writeFileSync(join(repoDir, "checkpoint-only.ts"), "export const checkpoint = true;\n");
  const checkpoint = await git.commitAll("checkpoint");
  if (checkpoint === null) throw new Error("checkpoint commit missing");

  unlinkSync(join(repoDir, "checkpoint-only.ts"));
  writeFileSync(join(repoDir, "user-only.ts"), "export const userOnly = true;\n");
  if (opts.withTests === true) writeFileSync(join(repoDir, "tests/repro.test.mjs"), failingTest);
  if (opts.withUserRuntime === true) {
    mkdirSync(join(repoDir, "runtime"));
    writeFileSync(join(repoDir, "runtime/scenario.mjs"), "process.exit(1);\n");
  }
  const userHead = await git.commitAll("user head");
  if (userHead === null) throw new Error("user head missing");
  return { root, repoDir, base, checkpoint, userHead };
}

function realSandbox(fixture: Fixture): WorktreeSandbox {
  return new WorktreeSandbox(fixture.repoDir, join(fixture.root, "worktrees"), defaultConfig().sandbox);
}

function spySandbox(fixture: Fixture, created: CheckoutSnap[], destroyed: string[]): Sandbox {
  const inner = realSandbox(fixture);
  return {
    kind: inner.kind,
    isolates: inner.isolates,
    create: async (input) => {
      const handle = await inner.create(input);
      created.push({
        id: handle.id,
        path: realpathSync(handle.path),
        head: await handle.headCommit(),
        baseCommit: input.baseCommit,
        hasCheckpointFile: existsSync(join(handle.path, "checkpoint-only.ts")),
        hasUserFile: existsSync(join(handle.path, "user-only.ts")),
      });
      return wrapDestroy(handle, destroyed);
    },
    list: () => inner.list(),
    destroyAll: () => inner.destroyAll(),
  };
}

function wrapDestroy(handle: SandboxHandle, destroyed: string[]): SandboxHandle {
  return {
    ...handle,
    destroy: async () => {
      destroyed.push(handle.id);
      await handle.destroy();
    },
  };
}

function failingSandbox(): Sandbox {
  return {
    kind: "worktree",
    isolates: false,
    create: async (_input: CreateSandboxInput) => {
      throw new PolishError("SANDBOX_ERROR", "create failed");
    },
    list: async () => [],
    destroyAll: async () => undefined,
  };
}

function reviewingHarness(
  fixture: Fixture,
  sandbox: Sandbox | undefined,
  script: (provider: ScriptedProvider) => void,
  runAxisReviewImpl?: ReviewDriverOptions["runAxisReview"],
): { engine: RunEngine; store: Store; clock: FakeClock } {
  const store = openStore({ artifactsDir: join(fixture.root, `artifacts-${Math.random().toString(16).slice(2)}`) });
  const clock = new FakeClock(NOW);
  const sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 60_000 });
  const provider = new ScriptedProvider("reviews", [{ name: "reviewer", capabilities: FAKE_CAPABILITIES.strong }]);
  script(provider);
  const engine = new RunEngine({ store, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined }, false);
  for (const phase of ["CREATED", "DISCOVERING_PROJECT", "BASELINING", "INTERPRETING_MISSION", "DISCOVERING_MODELS", "PLANNING", "EXECUTING", "GATING", "COMPARING", "INTEGRATING", "VALIDATING", "CONVERGENCE_CHECK"] as const) {
    engine.registerPhase(phase, stubDriverFor(phase));
  }
  engine.registerPhase(
    "REVIEWING",
    createReviewingDriver({
      resolveReviewers: () => [{ provider, model: { provider: "reviews", model: "reviewer" } }],
      ...(sandbox === undefined ? {} : { sandbox }),
      ...(runAxisReviewImpl === undefined ? {} : { runAxisReview: runAxisReviewImpl }),
    }),
  );
  return { engine, store, clock };
}

function validatingHarness(fixture: Fixture, sandbox: Sandbox | undefined): { engine: RunEngine; store: Store; clock: FakeClock } {
  const store = openStore({ artifactsDir: join(fixture.root, `artifacts-${Math.random().toString(16).slice(2)}`) });
  const clock = new FakeClock(NOW);
  const sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 60_000 });
  const engine = new RunEngine({ store, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined }, false);
  for (const phase of ["CREATED", "DISCOVERING_PROJECT", "BASELINING", "INTERPRETING_MISSION", "DISCOVERING_MODELS", "PLANNING", "EXECUTING", "GATING", "COMPARING", "INTEGRATING", "REVIEWING", "CONVERGENCE_CHECK"] as const) {
    engine.registerPhase(phase, stubDriverFor(phase));
  }
  engine.registerPhase("VALIDATING", createValidatingDriver(sandbox === undefined ? {} : { sandbox }));
  return { engine, store, clock };
}

function seedRun(
  store: Store,
  clock: FakeClock,
  fixture: Fixture,
  phase: "REVIEWING" | "VALIDATING",
  findings: Finding[] = [],
): { runId: string } {
  const runId = id("run", clock.now());
  const missionId = id("msn", clock.now());
  for (const finding of findings) finding.runId = runId;
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
    commitHash: fixture.checkpoint,
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
    phase,
    control: "RUNNING" as const,
    currentCheckpointHash: fixture.checkpoint,
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
    ...findings.map((finding, index) => ({
      id: id("evt", clock.now() + 20 + index),
      runId,
      ts: clock.now() + 20 + index,
      type: "finding.raised" as const,
      payload: { finding },
      causedBy: [] as string[],
      actor: { kind: "reviewer" as const },
      artifacts: [],
    })),
  ]);
  return { runId };
}

function testFinding(checkpointHash: string, overrides: Partial<Finding> = {}): Finding {
  const raw = {
    criterion: "regression",
    severity: "high" as const,
    blocking: true,
    claim: "the failing test reproduces the defect",
    evidence: [{ path: "tests/repro.test.mjs", line: 1 }],
    reproduction: ["npm test"],
    suggestedCheck: "regression test should fail at the checkpoint",
    ...overrides,
  };
  return {
    id: id("find", NOW),
    runId: id("run", NOW),
    checkpointHash,
    axis: "regression",
    reportedBy: { kind: "reviewer" },
    status: "RAW",
    duplicateOf: null,
    fingerprint: findingFingerprint(raw),
    investigationRounds: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...raw,
    ...overrides,
  };
}

function runtimeFinding(checkpointHash: string): Finding {
  const raw = {
    criterion: "runtime",
    severity: "high" as const,
    blocking: true,
    claim: "runtime scenario reproduces the defect",
    evidence: [{ path: "runtime/scenario.mjs", line: 1 }],
    reproduction: ["run the runtime scenario"],
    suggestedCheck: "runtime scenario should fail",
  };
  return {
    id: id("find", NOW + 1),
    runId: id("run", NOW),
    checkpointHash,
    axis: "correctness",
    reportedBy: { kind: "reviewer" },
    status: "RAW",
    duplicateOf: null,
    fingerprint: findingFingerprint(raw),
    investigationRounds: 0,
    createdAt: NOW + 1,
    updatedAt: NOW + 1,
    ...raw,
  };
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
