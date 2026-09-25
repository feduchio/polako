import { composeWorkerInstruction } from "../context/workerInstruction.js";
import { ProtocolRegistry, defaultProtocolsRoot } from "../protocols/loader.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CORPUS_EXECUTABLE_STATUS, type RuntimeEvidence } from "../domain/acceptance.js";
import type { BaselineSnapshot } from "../domain/checks.js";
import { defaultConfig } from "../domain/config.js";
import { createTaskFromRequirement } from "../domain/task.js";
import { inspectManifestHashes } from "../project/discovery.js";
import type { ProjectProfile } from "../project/profile.js";
import { FixtureRuntimeValidator } from "../runtime/index.js";
import type { RuntimeValidator } from "../runtime/types.js";
import { CommandPolicy } from "../sandbox/allowlist.js";
import { Git } from "../sandbox/git.js";
import { WorktreeSandbox } from "../sandbox/worktree.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { MissionAcceptanceService } from "../store/missionAcceptance.js";
import { Scheduler } from "../scheduler/index.js";
import { stubDriverFor } from "./stubs.js";
import { RunEngine } from "./engine.js";
import {
  createComparingDriver,
  createExecutingDriver,
  createGatingDriver,
  createIntegratingDriver,
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
    const config = defaultConfig();
    config.verifier.backend = "ts";
    sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: config.lanes, leaseMs: 60_000 });
    driverOptions = buildDriverOptions(fixture);
    engine = new RunEngine({ store, clock, scheduler: sched, config, assertProjectClean: () => undefined }, false);
    for (const phase of ["CREATED", "DISCOVERING_PROJECT", "BASELINING", "INTERPRETING_MISSION", "DISCOVERING_MODELS", "PLANNING", "REVIEWING", "VALIDATING", "CONVERGENCE_CHECK"] as const) {
      engine.registerPhase(phase, stubDriverFor(phase));
    }
    engine.registerPhase("EXECUTING", createExecutingDriver(driverOptions));
    engine.registerPhase("GATING", createGatingDriver(driverOptions));
    engine.registerPhase("COMPARING", createComparingDriver());
    engine.registerPhase("INTEGRATING", createIntegratingDriver(driverOptions));
  });

  afterEach(() => {
    store.close();
  });

  /** INTEGRATING-only engine with a real fixture validator, for B-selfhost-6 runtime evidence. */
  function runtimeEngine(mode: "auto" | "required"): RunEngine {
    const config = { ...defaultConfig(), runtimeValidation: { mode, level: "smoke" as const } };
    const withRuntime = new RunEngine(
      { store, clock, scheduler: sched, config, assertProjectClean: () => undefined },
      false,
    );
    withRuntime.registerPhase(
      "INTEGRATING",
      createIntegratingDriver({ ...driverOptions, runtimeValidators: [new FixtureRuntimeValidator()] }),
    );
    return withRuntime;
  }

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

  it("GATING terminates the run when a gate checkout cannot be made able to produce evidence", async () => {
    // Finding 54, one layer down from the baseline. A candidate must not be judged on an
    // environment it never controlled, and the failure must not recur on every tick.
    const options = buildDriverOptions(fixture, () =>
      new ScriptedCandidateWorker((_task, worktree) => {
        // A check that does not pass, in a checkout declaring a package nothing installed here.
        // Both halves matter: the failure is what cannot be attributed to the candidate, and a
        // check that *passed* would be evidence whatever the environment looked like (MC11).
        writeFileSync(join(worktree.path, "outcome.txt"), "fail");
        writeFileSync(
          join(worktree.path, "package.json"),
          JSON.stringify({ name: "demo", devDependencies: { vitest: "^4" } }),
        );
        return { status: "completed" };
      }),
    );
    const gateEngine = new RunEngine(
      { store, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined },
      false,
    );
    gateEngine.registerPhase("EXECUTING", createExecutingDriver(options));
    gateEngine.registerPhase(
      "GATING",
      createGatingDriver({
        ...options,
        // Install disabled, so preparation cannot succeed and no command is issued.
        resolveGates: async (ctx, task) => ({
          ...(await options.resolveGates!(ctx, task)),
          prepareDependencies: { enabled: false, timeoutMs: 1000 },
        }),
      }),
    );
    const { runId } = seedRun(store, clock, fixture);
    await gateEngine.tickRun(runId);
    await gateEngine.tickRun(runId);

    const run = store.repos.runs.get(runId)!;
    expect(run.phase).toBe("FAILED");
    expect(run.terminalReason?.code).toBe("environment_not_ready");
    expect(run.terminalReason?.question).toContain("sandbox.installDependencies");
    // No candidate was judged on it, and a further tick cannot repeat the attempt.
    const candidates = store.repos.candidates.listByRun(runId);
    const states = candidates.map((candidate) => candidate.state);
    expect(states).not.toContain("PASSED_GATES");
    expect(states).not.toContain("FAILED_GATES");
    // And each discard says why. `Candidate.error` exists so a discard is not mistaken for
    // infrastructure noise, which is exactly what this one would look like without it. MC18.
    for (const candidate of candidates.filter((each) => each.state === "DISCARDED")) {
      expect(candidate.error).toContain("no evidence");
      expect(candidate.error).toContain("dependency install is disabled");
    }
    const gated = store.events.list(runId, { types: ["candidate.gated"] });
    expect(gated.length).toBeGreaterThan(0);
    for (const event of gated) {
      const payload = event.payload as { candidate: { state: string; error: string | null } };
      expect(payload.candidate.error).toContain("no evidence");
    }
    await gateEngine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("FAILED");
  });

  it("does not terminate the run when only one candidate's checkout is unpreparable", async () => {
    // A candidate can break its own install by editing package.json without its lockfile. That is
    // a fact about that candidate, not about the mission.
    let seq = 0;
    const options = buildDriverOptions(fixture, () => {
      const poison = seq++ === 0;
      return new ScriptedCandidateWorker((_task, worktree) => {
        writeFileSync(join(worktree.path, "outcome.txt"), poison ? "fail" : "pass");
        if (poison) {
          writeFileSync(
            join(worktree.path, "package.json"),
            JSON.stringify({ name: "demo", devDependencies: { vitest: "^4" } }),
          );
        }
        return { status: "completed" };
      });
    });
    const gateEngine = new RunEngine(
      { store, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined },
      false,
    );
    gateEngine.registerPhase("EXECUTING", createExecutingDriver(options));
    gateEngine.registerPhase(
      "GATING",
      createGatingDriver({
        ...options,
        resolveGates: async (ctx, task) => ({
          ...(await options.resolveGates!(ctx, task)),
          prepareDependencies: { enabled: false, timeoutMs: 1000 },
        }),
      }),
    );
    const { runId, taskId } = seedRun(store, clock, fixture);
    await gateEngine.tickRun(runId);
    await gateEngine.tickRun(runId);

    const run = store.repos.runs.get(runId)!;
    expect(run.phase).not.toBe("FAILED");
    const states = store.repos.candidates.listByTask(taskId).map((candidate) => candidate.state);
    expect(states).toContain("DISCARDED");
    expect(states).toContain("PASSED_GATES");
  });

  it("gates a candidate whose checks pass in an unpreparable checkout, rather than discarding it", async () => {
    // MC11, one layer down from the baseline it was written for: a check that passed is evidence
    // whatever the environment looked like. Refusing it here would discard a real observation and
    // make an undeclared dependency enough to kill a good candidate.
    // The check runs in a subdirectory that declares a package nothing installed, so the
    // environment is unpreparable exactly where the check runs. The root manifest is untouched:
    // rewriting it would fail the gate for silencing and hide what this test is about.
    const options = buildDriverOptions(fixture, () =>
      new ScriptedCandidateWorker((_task, worktree) => {
        mkdirSync(join(worktree.path, "pkg"), { recursive: true });
        writeFileSync(join(worktree.path, "pkg", "outcome.txt"), "pass");
        writeFileSync(
          join(worktree.path, "pkg", "package.json"),
          JSON.stringify({ name: "demo", devDependencies: { vitest: "^4" } }),
        );
        return { status: "completed" };
      }),
    );
    const gateEngine = new RunEngine(
      { store, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined },
      false,
    );
    gateEngine.registerPhase("EXECUTING", createExecutingDriver(options));
    gateEngine.registerPhase(
      "GATING",
      createGatingDriver({
        ...options,
        resolveGates: async (ctx, task) => {
          const gates = await options.resolveGates!(ctx, task);
          const [check] = gates.profile.checks;
          return {
            ...gates,
            profile: { ...gates.profile, checks: [{ ...check!, cwd: "pkg" }] },
            prepareDependencies: { enabled: false, timeoutMs: 1000 },
          };
        },
      }),
    );
    const { runId, taskId } = seedRun(store, clock, fixture);
    await gateEngine.tickRun(runId);
    await gateEngine.tickRun(runId);

    expect(store.repos.runs.get(runId)?.phase).not.toBe("FAILED");
    const states = store.repos.candidates.listByTask(taskId).map((candidate) => candidate.state);
    expect(states).toContain("PASSED_GATES");
    expect(states).not.toContain("DISCARDED");
  });

  it("carries the operator's install setting from config into the gates", async () => {
    // Without this the gates prepare with defaults, which is the safe direction but not the
    // configured one: an operator who set `installDependencies: false` would still see an install
    // attempted in every candidate checkout. Observes the assignment in `resolveGates`, which a
    // review round deleted with 93 tests still green. Finding 54.
    const { resolveGates: _productionResolvesThem, ...options } = buildDriverOptions(fixture, () =>
      new ScriptedCandidateWorker((_task, worktree) => {
        writeFileSync(join(worktree.path, "outcome.txt"), "fail");
        writeFileSync(
          join(worktree.path, "package.json"),
          JSON.stringify({ name: "demo", devDependencies: { vitest: "^4" } }),
        );
        return { status: "completed" };
      }),
    );
    const config = defaultConfig();
    config.sandbox.installDependencies = false;
    const gateEngine = new RunEngine(
      { store, clock, scheduler: sched, config, assertProjectClean: () => undefined },
      false,
    );
    gateEngine.registerPhase("EXECUTING", createExecutingDriver(options));
    gateEngine.registerPhase("GATING", createGatingDriver(options));
    const { runId } = seedRun(store, clock, fixture);
    await gateEngine.tickRun(runId);
    await gateEngine.tickRun(runId);

    const run = store.repos.runs.get(runId)!;
    expect(run.phase).toBe("FAILED");
    // The disabled branch of the refusal, which is only reachable when the setting arrived.
    expect(run.terminalReason?.question).toContain("sandbox.installDependencies");
    expect(run.terminalReason?.summary).toContain("dependency install is disabled");
  });

  it("INTEGRATING terminates the run when the integration workspace cannot be prepared", async () => {
    // A manifest declaring a package that nothing installed, committed on the winner branch.
    const winner = await commitOnBranch(fixture.repoDir, fixture.base, "winner-unpreparable", "fail", {
      "package.json": JSON.stringify({ name: "demo", devDependencies: { vitest: "^4" } }),
    });
    const { runId } = seedIntegratingRun(store, clock, fixture, winner);
    const intEngine = new RunEngine(
      { store, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined },
      false,
    );
    intEngine.registerPhase(
      "INTEGRATING",
      createIntegratingDriver({
        ...driverOptions,
        resolveGates: async (ctx, task) => ({
          ...(await driverOptions.resolveGates!(ctx, task)),
          prepareDependencies: { enabled: false, timeoutMs: 1000 },
        }),
      }),
    );
    await intEngine.tickRun(runId);

    const run = store.repos.runs.get(runId)!;
    expect(run.phase).toBe("FAILED");
    expect(run.terminalReason?.code).toBe("environment_not_ready");
    // And it does not retry the same fresh workspace on the next tick.
    await intEngine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("FAILED");
  });

  it("records the model that ran each candidate, everywhere the run reports one", async () => {
    // B-selfhost-9. The router-selected ref already reached AgentRunner and the transcript; the
    // Candidate record and every event actor carried `worker/candidate-N` instead. Nothing in the
    // suite observed it, which is why replacing it broke no expectation.
    const models = [
      { provider: "openrouter", model: "alpha-1" },
      { provider: "openrouter", model: "beta-2" },
    ];
    let next = 0;
    const options = buildDriverOptions(fixture, () => {
      const model = models[next++ % models.length]!;
      return new ScriptedCandidateWorker((_task, worktree) => {
        writeFileSync(join(worktree.path, "outcome.txt"), model.model);
        return { status: "completed" };
      }, model);
    });
    const own = new RunEngine(
      { store, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined },
      false,
    );
    for (const phase of ["CREATED", "DISCOVERING_PROJECT", "BASELINING", "INTERPRETING_MISSION", "DISCOVERING_MODELS", "PLANNING", "REVIEWING", "VALIDATING", "CONVERGENCE_CHECK"] as const) {
      own.registerPhase(phase, stubDriverFor(phase));
    }
    own.registerPhase("EXECUTING", createExecutingDriver(options));

    const { runId, taskId } = seedRun(store, clock, fixture);
    await own.tickRun(runId);

    // The record the tournament, the report and the observer all read.
    const recorded = store.repos.candidates.listByTask(taskId).map((candidate) => candidate.model);
    expect(recorded).toHaveLength(2);
    expect([...recorded].sort((a, b) => a.model.localeCompare(b.model))).toEqual(models);

    // And the event log, which is the surface `displayModel` renders from. Match on the model
    // field: `actor.kind` is legitimately "worker" and must not be confused for the defect.
    const events = store.events.list(runId, {});
    const started = events.filter((event) => event.type === "worker.started");
    expect(started).toHaveLength(2);
    for (const event of started) {
      const payload = event.payload as { model: { provider: string; model: string } };
      expect(models).toContainEqual(payload.model);
      expect(event.actor.model).toEqual(payload.model);
    }
    const created = events.filter((event) => event.type === "candidate.created");
    expect(created).toHaveLength(2);
    for (const event of created) expect(models).toContainEqual(event.actor.model);

    const synthetic = events.filter((event) => JSON.stringify(event).includes('"provider":"worker"'));
    expect(synthetic).toEqual([]);
  });

  it("names the budget when a pack overflow kills every candidate", async () => {
    // The cap and the task are the same for all N, so overflow fails them identically. Without
    // the code and the counts on the candidate, that is indistinguishable from a sandbox fault,
    // and the task burns its retries reproducing it.
    const registry = ProtocolRegistry.load(defaultProtocolsRoot());
    const options = buildDriverOptions(fixture, () =>
      new ScriptedCandidateWorker((task) => {
        // The real throw from the real seam, not a hand-made error.
        composeWorkerInstruction({
          registry,
          task: task as unknown as Parameters<typeof composeWorkerInstruction>[0]["task"],
          findings: [],
          profile: null,
          tools: [],
          maxPackTokens: 1,
        });
        return { status: "completed" };
      }),
    );
    const own = new RunEngine(
      { store, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined },
      false,
    );
    for (const phase of ["CREATED", "DISCOVERING_PROJECT", "BASELINING", "INTERPRETING_MISSION", "DISCOVERING_MODELS", "PLANNING", "REVIEWING", "VALIDATING", "CONVERGENCE_CHECK"] as const) {
      own.registerPhase(phase, stubDriverFor(phase));
    }
    own.registerPhase("EXECUTING", createExecutingDriver(options));

    const { runId, taskId } = seedRun(store, clock, fixture);
    await own.tickRun(runId);

    const candidates = store.repos.candidates.listByTask(taskId);
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      expect(candidate.state).toBe("DISCARDED");
      expect(candidate.error).toContain("BUDGET_EXCEEDED");
      expect(candidate.error).toMatch(/require ~\d+ tokens > max 1/);
    }
    // And the run-visible event carries it, so an operator reading the log sees the budget.
    const created = store.events.list(runId, { types: ["candidate.created"] });
    expect(created).toHaveLength(2);
    for (const event of created) {
      const payload = event.payload as { candidate: { error: string | null } };
      expect(payload.candidate.error).toContain("BUDGET_EXCEEDED");
    }
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
    expect(candidates.every((candidate) => (candidate.gateReport?.diffStat.files ?? 0) > 0)).toBe(true);
    expect(candidates.every((candidate) => candidate.diffRef?.kind === "candidate_diff")).toBe(true);
    for (const candidate of candidates) {
      if (candidate.diffRef === null) throw new Error("missing candidate diff artifact");
      expect(store.artifacts.getText(candidate.diffRef.sha256)).toContain("diff --git");
    }
  });

  it("INTEGRATING advances the run head only when integration gates pass", async () => {
    const { runId, taskId } = seedRun(store, clock, fixture);
    await engine.tickRun(runId);
    await engine.tickRun(runId);
    const passed = store.repos.candidates.listByTask(taskId)
      .find((candidate) => candidate.state === "PASSED_GATES");
    if (passed?.headCommit === undefined || passed.headCommit === null) {
      throw new Error("missing passed candidate");
    }
    const misleadingDiff = store.artifacts.put(
      "diff --git a/src/a.test.ts b/src/a.test.ts\n+test only\n",
      "candidate_diff",
      `${passed.baseCheckpointHash}..${passed.headCommit}`,
    );
    store.events.append([{
      id: id("evt", clock.now()),
      runId,
      ts: clock.now(),
      type: "candidate.state_changed",
      payload: { candidate: { ...passed, diffRef: misleadingDiff } },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [misleadingDiff],
    }]);
    await engine.tickRun(runId);
    await engine.tickRun(runId);
    const run = store.repos.runs.get(runId)!;
    expect(run.phase).toBe("REVIEWING");
    expect(run.currentCheckpointHash).not.toBe(fixture.base);
    expect(store.events.list(runId, { types: ["integration.started", "integration.finished"] }).length).toBe(2);
    const checkpointEvents = store.events.list(runId, { types: ["checkpoint.created"] });
    expect(checkpointEvents).toHaveLength(1);
    expect(checkpointEvents[0]?.payload["change"]).toEqual({
      taskId,
      parentHash: fixture.base,
      headHash: run.currentCheckpointHash,
      paths: ["outcome.txt"],
      classification: "production",
      causalEventId: checkpointEvents[0]?.id,
    });
    const runHead = new GitBranchRunHead(fixture.repoDir, "run");
    expect(await runHead.read()).toBe(run.currentCheckpointHash);
  });

  it("admits a fixing task's test after integration and executes it for the next task", async () => {
    const testPath = "tests/corpus-regression.test.mjs";
    const corpusCommand = ["node", testPath];
    const winner = await commitOnBranch(fixture.repoDir, fixture.base, "winner-corpus", "pass", {
      "tests/a.fixture.ts": "export const fixture = true;\n",
      "tests/aScenario.ts": "export const scenario = true;\n",
      "tests/test-helper.ts": "export const helper = true;\n",
      [testPath]: "process.stdout.write('CORPUS-REGRESSION-RAN\\n');\n",
    });
    const { runId, taskId } = seedIntegratingRun(store, clock, fixture, winner);
    const findingId = id("find", clock.now());
    const validationId = id("fval", clock.now());
    const fixingTask = {
      ...store.repos.tasks.get(taskId)!,
      origin: { kind: "valid_finding" as const, findingId, validationId, verdict: "VALID" as const },
    };
    store.events.append([{
      id: id("evt", clock.now()),
      runId,
      ts: clock.now(),
      type: "task.state_changed",
      payload: { task: fixingTask },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    }]);
    const run = store.repos.runs.get(runId)!;
    const corpus = new MissionAcceptanceService(store, clock);
    const pending = corpus.record({
      missionId: run.missionId,
      sourceRunId: runId,
      requirementRef: "R1",
      kind: "regression_test",
      summary: "Validated finding",
      evidenceRefs: [],
      artifactHashes: ["a".repeat(64)],
      metadata: {
        findingId,
        validationId,
        executableStatus: CORPUS_EXECUTABLE_STATUS.pendingIntegration,
      },
    });
    const secondFindingId = id("find", clock.now() + 1);
    const secondValidationId = id("fval", clock.now() + 1);
    const second = {
      ...createTaskFromRequirement(id("interp", clock.now()), "R2", {
        id: id("task", clock.now()),
        runId,
        title: "Change outcome again",
        description: "WHAT: update outcome.txt again",
        kind: "bugfix" as const,
        acceptance: ["Checks pass"],
        complexity: "normal" as const,
        baseCheckpointHash: fixture.base,
        now: clock.now(),
      }),
      origin: {
        kind: "valid_finding" as const,
        findingId: secondFindingId,
        validationId: secondValidationId,
        verdict: "VALID" as const,
      },
      state: "READY" as const,
    };
    store.events.append([{
      id: id("evt", clock.now()),
      runId,
      ts: clock.now(),
      type: "task.created",
      payload: { task: second },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    }]);
    corpus.record({
      missionId: run.missionId,
      sourceRunId: runId,
      requirementRef: "R2",
      kind: "regression_test",
      summary: "Second validated finding",
      evidenceRefs: [],
      artifactHashes: ["b".repeat(64)],
      metadata: {
        findingId: secondFindingId,
        validationId: secondValidationId,
        executableStatus: CORPUS_EXECUTABLE_STATUS.pendingIntegration,
      },
    });
    const profile = {
      ...fixture.gates.profile,
      checks: [
        ...fixture.gates.profile.checks,
        { name: "corpus-regression", kind: "custom" as const, command: corpusCommand, mandatory: true },
      ],
    };
    const policy = CommandPolicy.forProject(profile.checks.map((check) => check.command), null);
    const { resolveGates: _testOverride, ...productionOptions } = driverOptions;
    let candidateIndex = 0;
    const options: CandidateDriverOptions = {
      ...productionOptions,
      policy,
      resolveProfile: () => profile,
      workerFactory: () => () => {
        const value = candidateIndex++ === 0 ? "pass-again" : "fail";
        return new ScriptedCandidateWorker((_task, worktree) => {
          writeFileSync(join(worktree.path, "outcome.txt"), value);
          return { status: "completed" };
        });
      },
    };
    const lifecycle = new RunEngine(
      { store, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined },
      false,
    );
    lifecycle.registerPhase("INTEGRATING", createIntegratingDriver(options));
    lifecycle.registerPhase("EXECUTING", createExecutingDriver(options));
    lifecycle.registerPhase("GATING", createGatingDriver(options));

    await lifecycle.tickRun(runId);

    const admitted = store.repos.acceptanceCorpus.get(pending.id);
    expect(admitted?.executable?.relativePath).toBe(testPath);
    expect(admitted?.executable?.sha256).not.toBe(pending.artifactHashes[0]);
    expect(store.events.list(runId, { types: ["acceptance.recorded"] })).toHaveLength(1);
    const checkpoint = store.repos.runs.get(runId)!.currentCheckpointHash!;
    expect(store.repos.tasks.get(second.id)?.baseCheckpointHash).toBe(checkpoint);

    store.events.append([{
      id: id("evt", clock.now() + 1),
      runId,
      ts: clock.now() + 1,
      type: "run.phase_changed",
      payload: {
        run: {
          ...store.repos.runs.get(runId)!,
          phase: "EXECUTING" as const,
          updatedAt: clock.now() + 1,
        },
      },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    }]);

    await lifecycle.tickRun(runId);
    await lifecycle.tickRun(runId);

    const secondCandidates = store.repos.candidates.listByTask(second.id);
    const passed = secondCandidates.find((candidate) => candidate.state === "PASSED_GATES");
    expect(passed, JSON.stringify(secondCandidates.map((candidate) => ({
      state: candidate.state,
      error: candidate.error,
      gateReport: candidate.gateReport,
    })), null, 2)).toBeDefined();
    expect(passed?.gateReport?.checks)
      .toContainEqual(expect.objectContaining({ name: "corpus-regression", status: "pass" }));
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
    expect(run.phase).toBe("PLANNING");
    expect(store.repos.tasks.listByRun(runId)[0]?.state).toBe("READY");
  });

  it("does not admit a pending corpus executable before integration gates pass", async () => {
    const winner = await commitOnBranch(fixture.repoDir, fixture.base, "winner-failed-corpus", "fail", {
      "tests/regression.test.mjs": "process.exit(0);\n",
    });
    const { runId, taskId } = seedIntegratingRun(store, clock, fixture, winner);
    const findingId = id("find", clock.now());
    const validationId = id("fval", clock.now());
    const task = {
      ...store.repos.tasks.get(taskId)!,
      origin: { kind: "valid_finding" as const, findingId, validationId, verdict: "VALID" as const },
    };
    store.events.append([{
      id: id("evt", clock.now()),
      runId,
      ts: clock.now(),
      type: "task.state_changed",
      payload: { task },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    }]);
    const run = store.repos.runs.get(runId)!;
    const corpus = new MissionAcceptanceService(store, clock);
    const pending = corpus.record({
      missionId: run.missionId,
      sourceRunId: runId,
      requirementRef: "R1",
      kind: "regression_test",
      summary: "Validated finding",
      evidenceRefs: [],
      artifactHashes: ["a".repeat(64)],
      metadata: {
        findingId,
        validationId,
        executableStatus: CORPUS_EXECUTABLE_STATUS.pendingIntegration,
      },
    });
    const { resolveGates: _testOverride, ...productionOptions } = driverOptions;
    const integration = new RunEngine(
      { store, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined },
      false,
    );
    integration.registerPhase("INTEGRATING", createIntegratingDriver({
      ...productionOptions,
      resolveProfile: () => fixture.gates.profile,
    }));

    await integration.tickRun(runId);

    expect(store.events.list(runId, { types: ["acceptance.recorded"] })).toEqual([]);
    expect(store.repos.acceptanceCorpus.get(pending.id)?.metadata["executableStatus"])
      .toBe(CORPUS_EXECUTABLE_STATUS.pendingIntegration);
    expect(store.repos.runs.get(runId)?.currentCheckpointHash).toBe(fixture.base);
  });

  it("finishes the integrated task and stops explicitly when corpus admission throws", async () => {
    const winner = await commitOnBranch(fixture.repoDir, fixture.base, "winner-corpus-inventory-error", "pass", {
      "tests/regression.test.mjs": "process.exit(0);\n",
    });
    const { runId, taskId } = seedIntegratingRun(store, clock, fixture, winner);
    const findingId = id("find", clock.now());
    const validationId = id("fval", clock.now());
    const task = {
      ...store.repos.tasks.get(taskId)!,
      origin: { kind: "valid_finding" as const, findingId, validationId, verdict: "VALID" as const },
    };
    store.events.append([{
      id: id("evt", clock.now()),
      runId,
      ts: clock.now(),
      type: "task.state_changed",
      payload: { task },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    }]);
    const run = store.repos.runs.get(runId)!;
    const corpus = new MissionAcceptanceService(store, clock);
    const pending = corpus.record({
      missionId: run.missionId,
      sourceRunId: runId,
      requirementRef: "R1",
      kind: "regression_test",
      summary: "Validated finding",
      evidenceRefs: [],
      artifactHashes: ["a".repeat(64)],
      metadata: {
        findingId,
        validationId,
        executableStatus: CORPUS_EXECUTABLE_STATUS.pendingIntegration,
      },
    });
    const { resolveGates: _testOverride, ...productionOptions } = driverOptions;
    const integration = new RunEngine(
      { store, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined },
      false,
    );
    integration.registerPhase("INTEGRATING", createIntegratingDriver({
      ...productionOptions,
      resolveProfile: () => fixture.gates.profile,
    }));
    const admission = vi.spyOn(store.acceptance, "putContent")
      .mockImplementationOnce(() => { throw new Error("CAS unavailable"); });
    try {
      await integration.tickRun(runId);
    } finally {
      admission.mockRestore();
    }

    expect(store.repos.tasks.get(taskId)?.state).toBe("INTEGRATED");
    expect(store.repos.runs.get(runId)?.phase).toBe("FAILED");
    expect(store.repos.runs.get(runId)?.terminalReason?.summary).toContain("admission_exception: CAS unavailable");
    expect(store.repos.acceptanceCorpus.get(pending.id)?.metadata["executableStatus"])
      .toBe(CORPUS_EXECUTABLE_STATUS.pendingIntegration);
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

  /**
   * R3, finding 55. Three runs in the store end `FAILED` with `terminalReason: null`, so the
   * operator cannot tell work that failed its gates from work that was never done.
   */
  describe("zero survivors name their cause", () => {
    const exhaust = (emptyStore: Store, runId: string, taskId: string, candidates: { state: "DISCARDED" | "FAILED_GATES"; error?: string; gated: boolean }[]): void => {
      const task = emptyStore.repos.tasks.get(taskId)!;
      emptyStore.events.append([
        {
          id: id("evt", clock.now() + 50),
          runId,
          ts: clock.now() + 50,
          type: "task.state_changed",
          payload: { task: { ...task, state: "GATED", attempts: defaultConfig().retry.maxAttempts, updatedAt: clock.now() + 50 } },
          causedBy: [],
          actor: { kind: "system" },
          artifacts: [],
        },
        ...candidates.map((spec, index) => ({
          id: id("evt", clock.now() + 60 + index),
          runId,
          ts: clock.now() + 60 + index,
          type: "candidate.created",
          payload: {
            candidate: {
              id: id("cand", clock.now() + 60 + index),
              runId,
              taskId,
              attempt: defaultConfig().retry.maxAttempts,
              model: { provider: "p", model: `m${index}` },
              baseCheckpointHash: task.baseCheckpointHash,
              branch: `polish/${runId}/candidates/c${index}`,
              worktreePath: null,
              headCommit: null,
              state: spec.state,
              gateReport: spec.gated
                ? {
                    gatedCommit: task.baseCheckpointHash,
                    checks: [],
                    injectedAcceptance: [],
                    failures: [{ reason: "mandatory_check_failed" as const, detail: "test failed" }],
                    passed: false,
                    diffStat: { files: 1, insertions: 1, deletions: 0 },
                    createdAt: clock.now(),
                  }
                : null,
              diffRef: null,
              transcriptRef: null,
              error: spec.error ?? null,
              createdAt: clock.now() + 60 + index,
              updatedAt: clock.now() + 60 + index,
            },
          },
          causedBy: [],
          actor: { kind: "system" as const },
          artifacts: [],
        })),
      ]);
    };

    const gatingEngineOn = (emptyStore: Store, emptyFixture: Awaited<ReturnType<typeof repositoryFixture>>): RunEngine => {
      const engine = new RunEngine({ store: emptyStore, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined }, false);
      engine.registerPhase("GATING", createGatingDriver(buildDriverOptions(emptyFixture, () => new ScriptedCandidateWorker(async () => ({ status: "completed" })))));
      for (const phase of ["PLANNING", "COMPARING", "EXECUTING"] as const) engine.registerPhase(phase, stubDriverFor(phase));
      return engine;
    };

    const seedGating = async (): Promise<{ store: Store; engine: RunEngine; runId: string; taskId: string }> => {
      const emptyFixture = await repositoryFixture();
      const emptyStore = openStore({ artifactsDir: join(emptyFixture.root, "artifacts") });
      const { runId, taskId } = seedRun(emptyStore, clock, emptyFixture);
      const run = emptyStore.repos.runs.get(runId)!;
      emptyStore.events.append([{
        id: id("evt", clock.now() + 40),
        runId,
        ts: clock.now() + 40,
        type: "run.phase_changed",
        payload: { run: { ...run, phase: "GATING", updatedAt: clock.now() + 40 } },
        causedBy: [],
        actor: { kind: "system" },
        artifacts: [],
      }]);
      return { store: emptyStore, engine: gatingEngineOn(emptyStore, emptyFixture), runId, taskId };
    };

    it("asks a human when the provider refused every candidate, because nothing was judged", async () => {
      const { store: s, engine, runId, taskId } = await seedGating();
      exhaust(s, runId, taskId, [
        { state: "DISCARDED", error: 'ProviderError: rate limited: {"limit_source":"openrouter_free_tier_daily"}', gated: false },
        { state: "DISCARDED", error: 'ProviderError: rate limited: {"limit_source":"openrouter_free_tier_daily"}', gated: false },
      ]);
      await engine.tickRun(runId);

      const run = s.repos.runs.get(runId)!;
      expect(run.phase).toBe("NEEDS_HUMAN");
      expect(run.terminalReason?.code).toBe("provider_budget_exhausted");
      expect(run.terminalReason?.summary).toContain("refused all 2");
      expect(run.terminalReason?.summary).toContain("attempt 5");
      expect(run.terminalReason?.summary).toContain("openrouter_free_tier_daily");
      s.close();
    });

    it("fails with repeated_failure when the candidates were judged and lost", async () => {
      const { store: s, engine, runId, taskId } = await seedGating();
      exhaust(s, runId, taskId, [{ state: "FAILED_GATES", gated: true }, { state: "FAILED_GATES", gated: true }]);
      await engine.tickRun(runId);

      const run = s.repos.runs.get(runId)!;
      expect(run.phase).toBe("FAILED");
      expect(run.terminalReason?.code).toBe("repeated_failure");
      expect(run.terminalReason?.summary).toContain("2 reached a gate and failed");
      expect(run.terminalReason?.summary).toContain("0 were refused by the provider");
      s.close();
    });

    // Waiting repairs an allowance and nothing else. Telling an operator to wait for a 404, a 400
    // or a local context-budget overflow is telling them to wait for something that never comes.
    // Three outcomes, not two. `repeated_failure` means the work was done and judged; when nothing
    // reached a gate, nothing was judged, and only an allowance is worth waiting for.
    it.each([
      ["ProviderError: rate limited: 429", "provider_budget_exhausted", "refused all 1"],
      ["ProviderError: not found: 404", "no_candidate_finished", "0 reached a gate and failed"],
      ["ProviderError: bad request (400): schema", "no_candidate_finished", "1 ended otherwise"],
      ["ProviderError: auth failed (403)", "no_candidate_finished", "1 ended otherwise"],
      ["ProviderError: request timed out after 120000ms", "no_candidate_finished", "1 ended otherwise"],
      ["BUDGET_EXCEEDED", "no_candidate_finished", "1 ended otherwise"],
      ["STOPPED", "no_candidate_finished", "1 ended otherwise"],
    ] as const)("classifies %s as %s", async (error, code, fragment) => {
      const { store: s3, engine, runId, taskId } = await seedGating();
      exhaust(s3, runId, taskId, [{ state: "DISCARDED", error, gated: false }]);
      await engine.tickRun(runId);
      const reason = s3.repos.runs.get(runId)?.terminalReason;
      expect(reason?.code).toBe(code);
      expect(reason?.summary).toContain(fragment);
      // The raw error reaches the operator whichever branch was taken.
      expect(reason?.summary).toContain(error.slice(0, 20));
      s3.close();
    });

    // A mixed attempt is where "every candidate failed its gates" becomes a false sentence, and
    // where the operator most needs the breakdown.
    // R3 at the one place every phase advance passes through: eight runs in the store are terminal
    // with no reason, from three different call sites.
    it("gives a terminal phase a reason even when the driver supplies none", async () => {
      const emptyFixture = await repositoryFixture();
      const emptyStore = openStore({ artifactsDir: join(emptyFixture.root, "artifacts") });
      const engine = new RunEngine({ store: emptyStore, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined }, false);
      engine.registerPhase("GATING", () => Promise.resolve({ status: "complete" as const, nextPhase: "FAILED" as const }));
      const { runId } = seedRun(emptyStore, clock, emptyFixture);
      const run = emptyStore.repos.runs.get(runId)!;
      emptyStore.events.append([{
        id: id("evt", clock.now() + 40),
        runId,
        ts: clock.now() + 40,
        type: "run.phase_changed",
        payload: { run: { ...run, phase: "GATING", updatedAt: clock.now() + 40 } },
        causedBy: [],
        actor: { kind: "system" },
        artifacts: [],
      }]);
      await engine.tickRun(runId);

      const failed = emptyStore.repos.runs.get(runId)!;
      expect(failed.phase).toBe("FAILED");
      expect(failed.terminalReason?.code).toBe("internal_error");
      expect(failed.terminalReason?.summary).toContain("from GATING without a stated reason");
      emptyStore.close();
    });

    // A recorder that can fail is a recorder that can replace the error it was recording.
    it("records a driver failure as an event before the engine does anything else", async () => {
      const emptyFixture = await repositoryFixture();
      const emptyStore = openStore({ artifactsDir: join(emptyFixture.root, "artifacts") });
      const engine = new RunEngine({ store: emptyStore, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined }, false);
      engine.registerPhase("PLANNING", () => { throw new Error("council exploded"); });
      const { runId } = seedRun(emptyStore, clock, emptyFixture);
      const run = emptyStore.repos.runs.get(runId)!;
      emptyStore.events.append([{
        id: id("evt", clock.now() + 40),
        runId,
        ts: clock.now() + 40,
        type: "run.phase_changed",
        payload: { run: { ...run, phase: "PLANNING", updatedAt: clock.now() + 40 } },
        causedBy: [],
        actor: { kind: "system" },
        artifacts: [],
      }]);
      await expect(engine.tickRun(runId)).rejects.toThrow("council exploded");

      const recorded = emptyStore.events.list(runId, { types: ["run.driver_failed"] });
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.payload["phase"]).toBe("PLANNING");
      expect(recorded[0]?.payload["error"]).toContain("council exploded");
      // Paused, and now the pause has a cause an operator can read.
      expect(emptyStore.repos.runs.get(runId)?.control).toBe("PAUSED");
      emptyStore.close();
    });

    it("counts a mixed attempt instead of generalising it", async () => {
      const { store: s2, engine, runId, taskId } = await seedGating();
      exhaust(s2, runId, taskId, [
        { state: "FAILED_GATES", gated: true },
        { state: "DISCARDED", error: "ProviderError: rate limited: 429", gated: false },
      ]);
      await engine.tickRun(runId);

      const run = s2.repos.runs.get(runId)!;
      expect(run.phase).toBe("FAILED");
      expect(run.terminalReason?.code).toBe("repeated_failure");
      expect(run.terminalReason?.summary).toContain("1 reached a gate and failed");
      expect(run.terminalReason?.summary).toContain("1 were refused by the provider");
      s2.close();
    });

    // Neither judged nor refused by a provider: still a reason, never `null`.
    it("names a cause even when the discard has no provider error", async () => {
      const { store: s, engine, runId, taskId } = await seedGating();
      exhaust(s, runId, taskId, [{ state: "DISCARDED", error: "gate checkout produced no evidence: npm ci failed", gated: false }]);
      await engine.tickRun(runId);

      const run = s.repos.runs.get(runId)!;
      expect(run.phase).toBe("FAILED");
      expect(run.terminalReason?.code).toBe("no_candidate_finished");
      expect(run.terminalReason?.summary).toContain("npm ci failed");
      s.close();
    });

    it("keeps providers_unavailable only when a refusal is mixed with work that never reached a gate", async () => {
      const { store: s, engine, runId, taskId } = await seedGating();
      exhaust(s, runId, taskId, [
        { state: "DISCARDED", error: "ProviderError: rate limited: 429", gated: false },
        { state: "DISCARDED", error: "BUDGET_EXCEEDED", gated: false },
      ]);
      await engine.tickRun(runId);
      const run = s.repos.runs.get(runId)!;
      expect(run.phase).toBe("FAILED");
      expect(run.terminalReason?.code).toBe("providers_unavailable");
      expect(run.terminalReason?.summary).toContain("1 were refused by the provider");
      expect(run.terminalReason?.summary).toContain("1 ended otherwise");
      s.close();
    });
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

  it("fails required integration closed when templates exist but no validator can run them", async () => {
    const winner = await commitOnBranch(fixture.repoDir, fixture.base, "winner-unusable-validator", "pass", {
      "runtime/check.mjs": "process.exit(0);\n",
    });
    const { runId } = seedIntegratingRun(store, clock, fixture, winner);
    const config = { ...defaultConfig(), runtimeValidation: { mode: "required" as const, level: "smoke" as const } };
    const unusableEngine = new RunEngine(
      { store, clock, scheduler: sched, config, assertProjectClean: () => undefined },
      false,
    );
    unusableEngine.registerPhase(
      "INTEGRATING",
      createIntegratingDriver({ ...driverOptions, runtimeValidators: [unsupportedValidator()] }),
    );
    await unusableEngine.tickRun(runId);

    const run = store.repos.runs.get(runId)!;
    expect(run.currentCheckpointHash).toBe(fixture.base);
    const finished = store.events.list(runId, { types: ["integration.finished"] })[0];
    expect(finished?.payload["advanced"]).toBe(false);
    expect(finished?.payload["status"]).toBe("failed_runtime");
    expect(runtimeEvidenceEntries(store, run.missionId)).toEqual([]);
  });

  it("persists checkpoint-bound runtime evidence from the integration checkout under auto", async () => {
    const winner = await commitOnBranch(fixture.repoDir, fixture.base, "winner-auto-runtime", "pass", {
      "runtime/check.mjs": "process.exit(0);\n",
    });
    const { runId } = seedIntegratingRun(store, clock, fixture, winner);
    await runtimeEngine("auto").tickRun(runId);

    const run = store.repos.runs.get(runId)!;
    expect(run.currentCheckpointHash).not.toBe(fixture.base);
    const evidence = runtimeEvidenceEntries(store, run.missionId);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.status).toBe("passed");
    expect(evidence[0]?.checkpointHash).toBe(run.currentCheckpointHash);
    expect(evidence[0]?.scenarioId).toBe("runtime/check.mjs");
  });

  it("falls back to project.discovered templates when the checkout has no runtime directory", async () => {
    const winner = await commitOnBranch(fixture.repoDir, fixture.base, "winner-discovered-runtime", "pass", {
      "scripts/smoke.mjs": "process.exit(0);\n",
    });
    const { runId } = seedIntegratingRun(store, clock, fixture, winner);
    appendDiscoveredTemplates(store, clock, runId, ["scripts/smoke.mjs"]);
    await runtimeEngine("required").tickRun(runId);

    const run = store.repos.runs.get(runId)!;
    expect(run.currentCheckpointHash).not.toBe(fixture.base);
    const evidence = runtimeEvidenceEntries(store, run.missionId);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.status).toBe("passed");
    expect(evidence[0]?.scenarioId).toBe("scripts/smoke.mjs");
    expect(evidence[0]?.checkpointHash).toBe(run.currentCheckpointHash);
  });

  it("prefers checkout discovery over stale run-start templates", async () => {
    const winner = await commitOnBranch(fixture.repoDir, fixture.base, "winner-fresh-runtime", "pass", {
      "runtime/check.mjs": "process.exit(0);\n",
      "scripts/stale.mjs": "process.exit(1);\n",
    });
    const { runId } = seedIntegratingRun(store, clock, fixture, winner);
    appendDiscoveredTemplates(store, clock, runId, ["scripts/stale.mjs"]);
    await runtimeEngine("auto").tickRun(runId);

    const run = store.repos.runs.get(runId)!;
    expect(run.currentCheckpointHash).not.toBe(fixture.base);
    const evidence = runtimeEvidenceEntries(store, run.missionId);
    expect(evidence.map((entry) => entry.scenarioId)).toEqual(["runtime/check.mjs"]);
  });

  it("admits no runtime evidence when run-head CAS rejects the gated workspace", async () => {
    const winner = await commitOnBranch(fixture.repoDir, fixture.base, "winner-stale-runtime", "pass", {
      "runtime/check.mjs": "process.exit(0);\n",
    });
    const { runId } = seedIntegratingRun(store, clock, fixture, winner);
    const stale = new RunEngine(
      { store, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined },
      false,
    );
    stale.registerPhase("INTEGRATING", createIntegratingDriver({
      ...driverOptions,
      runtimeValidators: [new FixtureRuntimeValidator()],
      resolveRunHead: () => ({
        read: () => Promise.resolve(fixture.base),
        compareAndSet: () => Promise.resolve(false),
      }),
    }));

    await stale.tickRun(runId);

    expect(store.events.list(runId, { types: ["integration.finished"] })[0]?.payload["status"])
      .toBe("stale_head");
    expect(runtimeEvidenceEntries(store, store.repos.runs.get(runId)!.missionId)).toEqual([]);
    expect(store.events.list(runId, { types: ["acceptance.recorded"] })).toEqual([]);
  });

  it("keeps failed runtime diagnostics without admitting a protected executable", async () => {
    const winner = await commitOnBranch(fixture.repoDir, fixture.base, "winner-failing-runtime", "pass", {
      "runtime/check.mjs": "process.exit(1);\n",
    });
    const { runId } = seedIntegratingRun(store, clock, fixture, winner);
    await runtimeEngine("auto").tickRun(runId);

    const run = store.repos.runs.get(runId)!;
    expect(run.currentCheckpointHash).toBe(fixture.base);
    const finished = store.events.list(runId, { types: ["integration.finished"] })[0];
    expect(finished?.payload["advanced"]).toBe(false);
    expect(finished?.payload["status"]).toBe("failed_runtime");
    const evidence = runtimeEvidenceEntries(store, run.missionId);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.status).toBe("failed");
    expect(evidence[0]?.checkpointHash).toBe(finished?.payload["integratedCommit"]);
    expect(store.events.list(runId, { types: ["acceptance.recorded"] })).toEqual([]);
  });
});

/** Present but unusable: forces `required` down the RuntimeUnavailableError path. */
function unsupportedValidator(): RuntimeValidator {
  return {
    id: "unsupported-runtime",
    supports: () => false,
    availability: () => Promise.resolve({ available: false, capability: "UNAVAILABLE", reason: "unsupported" }),
    validate: () => Promise.reject(new Error("unsupported validator must never execute a scenario")),
  };
}

function runtimeEvidenceEntries(store: Store, missionId: string): RuntimeEvidence[] {
  return store.repos.acceptanceCorpus
    .forMission(missionId)
    .entries.filter((entry) => entry.kind === "runtime_evidence")
    .map((entry) => entry.runtimeEvidence)
    .filter((evidence): evidence is RuntimeEvidence => evidence !== undefined);
}

function appendDiscoveredTemplates(store: Store, clock: FakeClock, runId: string, scripts: string[]): void {
  store.events.append([
    {
      id: id("evt", clock.now() + 5),
      runId,
      ts: clock.now() + 5,
      type: "project.discovered",
      payload: {
        runtimeTemplates: scripts.map((script) => ({
          id: script,
          kind: "node_script",
          relativeScript: script,
          sideEffectPolicy: "safe",
        })),
      },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
  ]);
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
    state: "SELECTED" as const,
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
  extraFiles: Record<string, string> = {},
): Promise<string> {
  const git = new Git(repoDir);
  await git.run(["checkout", "-q", "-b", branch, base]);
  writeFileSync(join(repoDir, "outcome.txt"), outcome);
  for (const [relativePath, body] of Object.entries(extraFiles)) {
    const target = join(repoDir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, { mode: 0o644 });
  }
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
