import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselineSnapshot } from "../domain/checks.js";
import type { Checkpoint } from "../domain/checkpoint.js";
import { SYSTEM_ACTOR } from "../domain/common.js";
import { defaultConfig } from "../domain/config.js";
import type { CleanRound } from "../domain/convergence.js";
import type { MissionInterpretation } from "../domain/mission.js";
import type { ReviewExecution } from "../domain/review.js";
import { createTaskFromRequirement, type Task, type TaskState } from "../domain/task.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { CommandPolicy } from "../sandbox/allowlist.js";
import { Git } from "../sandbox/git.js";
import { WorktreeSandbox } from "../sandbox/worktree.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { Scheduler } from "../scheduler/index.js";
import { inspectManifestHashes } from "../project/discovery.js";
import type { ProjectProfile } from "../project/profile.js";
import { stubDriverFor } from "./stubs.js";
import { RunEngine } from "./engine.js";
import { createPlanningDriver } from "./councilDrivers.js";
import {
  createComparingDriver,
  createExecutingDriver,
  createGatingDriver,
  createIntegratingDriver,
  type CandidateDriverOptions,
} from "./candidateDrivers.js";
import { ScriptedCandidateWorker, type CandidateGates } from "./candidates.js";
import { createConvergenceDriver } from "./convergenceDrivers.js";
import { GitBranchRunHead } from "./integration.js";
import type { PhaseContext, PhaseDriver } from "./types.js";

const NOW = 1_700_000_000_000;
const SHA = "b".repeat(64);
const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("B-selfhost-3 multi-task DONE", () => {
  describe("INTEGRATING three-way fork", () => {
    let store: Store;
    let clock: FakeClock;
    let engine: RunEngine;
    let fixture: Awaited<ReturnType<typeof repositoryFixture>>;

    beforeEach(async () => {
      fixture = await repositoryFixture();
      store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
      clock = new FakeClock(NOW);
      const sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 60_000 });
      engine = new RunEngine({ store, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined }, false);
      for (const phase of [
        "CREATED",
        "DISCOVERING_PROJECT",
        "BASELINING",
        "INTERPRETING_MISSION",
        "DISCOVERING_MODELS",
        "PLANNING",
        "EXECUTING",
        "GATING",
        "COMPARING",
        "REVIEWING",
        "VALIDATING",
        "CONVERGENCE_CHECK",
      ] as const) {
        engine.registerPhase(phase, stubDriverFor(phase));
      }
      engine.registerPhase("INTEGRATING", createIntegratingDriver(passDriverOptions(fixture)));
    });

    afterEach(() => {
      store.close();
    });

    it("check 1: single coding task integrate succeeds to REVIEWING", async () => {
      const passCommit = await commitOnBranch(fixture.repoDir, fixture.base, "winner-single", "pass");
      const { runId } = seedIntegrating(store, clock, fixture, {
        winnerCommit: passCommit,
        siblings: [],
      });
      await engine.tickRun(runId);
      expect(store.repos.runs.get(runId)?.phase).toBe("REVIEWING");
      expect(store.repos.tasks.listByRun(runId).every((task) => task.state === "INTEGRATED")).toBe(true);
    });

    it("check 2: two READY coding tasks — first integrate returns PLANNING without new task.created", async () => {
      const passCommit = await commitOnBranch(fixture.repoDir, fixture.base, "winner-two", "pass");
      const { runId, siblingIds } = seedIntegrating(store, clock, fixture, {
        winnerCommit: passCommit,
        siblings: [{ state: "READY" }],
      });
      const createdBefore = store.events.list(runId, { types: ["task.created"] }).length;
      await engine.tickRun(runId);
      expect(store.repos.runs.get(runId)?.phase).toBe("PLANNING");
      expect(store.events.list(runId, { types: ["task.created"] })).toHaveLength(createdBefore);
      expect(store.repos.tasks.get(siblingIds[0]!)?.state).toBe("READY");
    });

    it("check 7: successful integrate with only exhausted incompletes returns FAILED, not REVIEWING", async () => {
      const passCommit = await commitOnBranch(fixture.repoDir, fixture.base, "winner-blocked", "pass");
      const { runId, siblingIds } = seedIntegrating(store, clock, fixture, {
        winnerCommit: passCommit,
        siblings: [{ state: "BLOCKED" }],
      });
      await engine.tickRun(runId);
      expect(store.repos.runs.get(runId)?.phase).toBe("FAILED");
      expect(store.repos.runs.get(runId)?.phase).not.toBe("REVIEWING");
      expect(store.repos.tasks.get(siblingIds[0]!)?.state).toBe("BLOCKED");
      expect(newRejectedOrCancelled(store, runId)).toEqual([]);
    });

    it("check 8: pre-seeded REJECTED/CANCELLED siblings still REVIEWING and emit no new reject/cancel", async () => {
      const passCommit = await commitOnBranch(fixture.repoDir, fixture.base, "winner-terminals", "pass");
      const { runId } = seedIntegrating(store, clock, fixture, {
        winnerCommit: passCommit,
        siblings: [{ state: "REJECTED" }, { state: "CANCELLED" }],
      });
      await engine.tickRun(runId);
      expect(store.repos.runs.get(runId)?.phase).toBe("REVIEWING");
      expect(newRejectedOrCancelled(store, runId)).toEqual([]);
    });
  });

  describe("dependent PENDING then PLANNING continue", () => {
    it("check 3: dependent PENDING promotes on the next PLANNING tick with the same id", async () => {
      const fixture = await repositoryFixture();
      const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
      const clock = new FakeClock(NOW);
      const sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 60_000 });
      const provider = dropAllCouncil();
      const engine = new RunEngine({ store, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined }, false);
      for (const phase of [
        "CREATED",
        "DISCOVERING_PROJECT",
        "BASELINING",
        "INTERPRETING_MISSION",
        "DISCOVERING_MODELS",
        "EXECUTING",
        "GATING",
        "COMPARING",
        "REVIEWING",
        "VALIDATING",
        "CONVERGENCE_CHECK",
      ] as const) {
        engine.registerPhase(phase, stubDriverFor(phase));
      }
      engine.registerPhase("INTEGRATING", createIntegratingDriver(passDriverOptions(fixture)));
      engine.registerPhase("PLANNING", withPromotion(createPlanningDriver({ roles: councilRoles(provider) })));

      const passCommit = await commitOnBranch(fixture.repoDir, fixture.base, "winner-dep", "pass");
      const { runId, taskId, siblingIds } = seedIntegrating(store, clock, fixture, {
        winnerCommit: passCommit,
        siblings: [{ state: "PENDING", dependsOnWinner: true }],
        withInterpretation: true,
      });
      const createdBefore = store.events.list(runId, { types: ["task.created"] }).length;
      const dependentId = siblingIds[0]!;

      await engine.tickRun(runId);
      expect(store.repos.runs.get(runId)?.phase).toBe("PLANNING");
      expect(store.repos.tasks.get(dependentId)?.state).toBe("PENDING");
      expect(store.repos.tasks.get(dependentId)?.dependsOn).toEqual([taskId]);

      await engine.tickRun(runId);
      expect(store.repos.runs.get(runId)?.phase).toBe("EXECUTING");
      expect(store.repos.tasks.get(dependentId)?.id).toBe(dependentId);
      expect(store.repos.tasks.get(dependentId)?.state).toBe("READY");
      expect(store.events.list(runId, { types: ["task.created"] })).toHaveLength(createdBefore);
      expect(decomposeCalls(provider)).toBe(0);
      store.close();
    });
  });

  describe("CONVERGENCE_CHECK routing", () => {
    let store: Store;
    let clock: FakeClock;
    let engine: RunEngine;
    let fixture: { root: string; repoDir: string; base: string; integrated: string };

    beforeEach(() => {
      const root = mkdtempSync(join(tmpdir(), "polish-b-selfhost-3-conv-"));
      cleanup.push(root);
      fixture = { root, repoDir: join(root, "repo"), base: "a".repeat(40), integrated: "b".repeat(40) };
      mkdirSync(fixture.repoDir);
      writeFileSync(join(fixture.repoDir, "package.json"), JSON.stringify({ name: "b-selfhost-3" }));
      store = openStore({ artifactsDir: join(root, "artifacts") });
      clock = new FakeClock(NOW);
      const sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 60_000 });
      engine = new RunEngine({ store, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined }, false);
      for (const phase of [
        "CREATED",
        "DISCOVERING_PROJECT",
        "BASELINING",
        "INTERPRETING_MISSION",
        "DISCOVERING_MODELS",
        "PLANNING",
        "EXECUTING",
        "GATING",
        "COMPARING",
        "INTEGRATING",
        "REVIEWING",
        "VALIDATING",
      ] as const) {
        engine.registerPhase(phase, stubDriverFor(phase));
      }
      engine.registerPhase("CONVERGENCE_CHECK", createConvergenceDriver());
    });

    afterEach(() => {
      store.close();
    });

    it("check 5: valid_finding coding sibling routes CONVERGENCE to PLANNING, not DONE/FAILED", async () => {
      const { runId } = seedConvergence(store, clock, fixture, {
        siblings: [{ state: "READY", origin: "valid_finding" }],
      });
      await engine.tickRun(runId);
      expect(store.repos.runs.get(runId)?.phase).toBe("PLANNING");
      expect(store.repos.runs.get(runId)?.phase).not.toBe("DONE");
      expect(store.repos.runs.get(runId)?.phase).not.toBe("FAILED");
    });

    it("check 7: BLOCKED sibling routes CONVERGENCE to FAILED, not DONE", async () => {
      const { runId } = seedConvergence(store, clock, fixture, {
        siblings: [{ state: "BLOCKED" }],
      });
      await engine.tickRun(runId);
      expect(store.repos.runs.get(runId)?.phase).toBe("FAILED");
      expect(store.repos.runs.get(runId)?.phase).not.toBe("DONE");
      expect(newRejectedOrCancelled(store, runId)).toEqual([]);
    });

    it("check 6/8: all-terminal coding tasks including pre-seeded REJECTED/CANCELLED may DONE", async () => {
      const { runId } = seedConvergence(store, clock, fixture, {
        siblings: [{ state: "REJECTED" }, { state: "CANCELLED" }],
        cleanRounds: 3,
      });
      await engine.tickRun(runId);
      expect(store.repos.runs.get(runId)?.phase).toBe("DONE");
      expect(newRejectedOrCancelled(store, runId)).toEqual([]);
    });
  });

  describe("E2E two-task DONE", () => {
    it("check 9: two coding tasks reach DONE after INTEGRATING → PLANNING then the second integrate", async () => {
      const fixture = await repositoryFixture();
      const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
      const clock = new FakeClock(NOW);
      const sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 60_000 });
      const provider = dropAllCouncil();
      const options = passDriverOptions(fixture);
      const engine = new RunEngine({ store, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined }, false);
      for (const phase of [
        "CREATED",
        "DISCOVERING_PROJECT",
        "BASELINING",
        "INTERPRETING_MISSION",
        "DISCOVERING_MODELS",
        "REVIEWING",
        "VALIDATING",
      ] as const) {
        engine.registerPhase(phase, stubDriverFor(phase));
      }
      engine.registerPhase("PLANNING", withPromotion(createPlanningDriver({ roles: councilRoles(provider) })));
      engine.registerPhase("EXECUTING", createExecutingDriver(options));
      engine.registerPhase("GATING", createGatingDriver(options));
      engine.registerPhase("COMPARING", createComparingDriver());
      engine.registerPhase("INTEGRATING", createIntegratingDriver(options));
      engine.registerPhase("CONVERGENCE_CHECK", createConvergenceDriver());

      const { runId, taskA, taskB } = seedTwoReadyTasks(store, clock, fixture);
      const createdBefore = store.events.list(runId, { types: ["task.created"] }).length;

      await engine.tickRun(runId);
      expect(store.repos.runs.get(runId)?.phase).toBe("GATING");
      await engine.tickRun(runId);
      expect(store.repos.runs.get(runId)?.phase).toBe("COMPARING");
      await engine.tickRun(runId);
      expect(store.repos.runs.get(runId)?.phase).toBe("INTEGRATING");
      await engine.tickRun(runId);
      expect(store.repos.runs.get(runId)?.phase).toBe("PLANNING");
      expect(phaseHandoffs(store, runId)).toContain("INTEGRATING → PLANNING");
      const afterFirst = store.repos.tasks.listByRun(runId);
      expect(afterFirst.filter((task) => task.state === "INTEGRATED")).toHaveLength(1);
      expect(afterFirst.some((task) => task.id === taskB && task.state !== "INTEGRATED")).toBe(true);
      expect(store.events.list(runId, { types: ["task.created"] })).toHaveLength(createdBefore);

      await engine.tickRun(runId);
      expect(store.repos.runs.get(runId)?.phase).toBe("EXECUTING");
      expect(store.repos.tasks.get(taskB)?.id).toBe(taskB);
      await engine.tickRun(runId);
      expect(store.repos.runs.get(runId)?.phase).toBe("GATING");
      await engine.tickRun(runId);
      expect(store.repos.runs.get(runId)?.phase).toBe("COMPARING");
      await engine.tickRun(runId);
      expect(store.repos.runs.get(runId)?.phase).toBe("INTEGRATING");
      await engine.tickRun(runId);
      expect(store.repos.runs.get(runId)?.phase).toBe("REVIEWING");
      expect(store.repos.tasks.get(taskA)?.state).toBe("INTEGRATED");
      expect(store.repos.tasks.get(taskB)?.state).toBe("INTEGRATED");
      expect(store.events.list(runId, { types: ["task.created"] })).toHaveLength(createdBefore);
      expect(decomposeCalls(provider)).toBe(0);

      const hash = store.repos.runs.get(runId)!.currentCheckpointHash!;
      seedB6Proof(store, clock, runId, hash);
      await engine.tickRun(runId);
      expect(store.repos.runs.get(runId)?.phase).toBe("VALIDATING");
      await engine.tickRun(runId);
      expect(store.repos.runs.get(runId)?.phase).toBe("CONVERGENCE_CHECK");
      await engine.tickRun(runId);
      expect(store.repos.runs.get(runId)?.phase).toBe("DONE");
      store.close();
    });
  });
});

function newRejectedOrCancelled(store: Store, runId: string): string[] {
  return store.events.list(runId, { types: ["task.state_changed"] })
    .map((event) => (event.payload["task"] as Task).state)
    .filter((state) => state === "REJECTED" || state === "CANCELLED");
}

function phaseHandoffs(store: Store, runId: string): string[] {
  const phases = store.events.list(runId, { types: ["run.phase_changed"] }).map((event) => {
    const run = event.payload["run"] as { phase: string };
    return run.phase;
  });
  const handoffs: string[] = [];
  let previous = store.events.list(runId, { types: ["run.created"] })[0]
    ? ((store.events.list(runId, { types: ["run.created"] })[0]!.payload["run"] as { phase: string }).phase)
    : "CREATED";
  for (const phase of phases) {
    if (phase !== previous) handoffs.push(`${previous} → ${phase}`);
    previous = phase;
  }
  return handoffs;
}

function withPromotion(driver: PhaseDriver): PhaseDriver {
  return async (ctx) => {
    promoteEligible(ctx);
    const result = await driver(ctx);
    promoteEligible(ctx);
    return result;
  };
}

function promoteEligible(ctx: PhaseContext): void {
  const tasks = ctx.store.repos.tasks.listByRun(ctx.run.id);
  const events = [];
  for (const task of tasks) {
    if (task.state !== "PENDING") continue;
    if (task.dependsOn.some((dependencyId) => ctx.store.repos.tasks.get(dependencyId)?.state !== "INTEGRATED")) continue;
    events.push({
      id: id("evt", ctx.clock.now()),
      runId: ctx.run.id,
      ts: ctx.clock.now(),
      type: "task.state_changed" as const,
      payload: { task: { ...task, state: "READY" as const, updatedAt: ctx.clock.now() } },
      causedBy: [] as string[],
      actor: SYSTEM_ACTOR,
      artifacts: [],
    });
  }
  if (events.length > 0) ctx.store.events.append(events);
}

function passDriverOptions(fixture: Awaited<ReturnType<typeof repositoryFixture>>): CandidateDriverOptions {
  return {
    sandbox: fixture.sandbox,
    policy: fixture.policy,
    workerFactory: () => () =>
      new ScriptedCandidateWorker((_task, worktree) => {
        writeFileSync(join(worktree.path, "outcome.txt"), "pass");
        return { status: "completed" };
      }),
    resolveProfile: () => fixture.gates.profile,
    resolveGates: (ctx) => ({
      ...fixture.gates,
      baseline: { ...fixture.gates.baseline, runId: ctx.run.id },
    }),
    resolveRunHead: () => new GitBranchRunHead(fixture.repoDir, "run"),
  };
}

function interpretationFor(missionId: string, interpretationId: string, baselineId: string): MissionInterpretation {
  return {
    id: interpretationId,
    missionId,
    version: 1,
    supersedes: null,
    basedOn: { profileHash: SHA, baselineId },
    goals: ["Finish both coding tasks"],
    requirements: [
      { ref: "R1", statement: "Task A", acceptance: ["A works"] },
      { ref: "R2", statement: "Task B", acceptance: ["B works"] },
    ],
    constraints: [],
    nonGoals: [],
    definitionOfSuccess: ["Checks pass"],
    ambiguities: [],
    createdBy: { kind: "supervisor", role: "council" },
    createdAt: NOW,
  };
}

function dropAllCouncil(): ScriptedProvider {
  const provider = new ScriptedProvider("council", [
    { name: "planner", capabilities: FAKE_CAPABILITIES.strong },
    { name: "scope", capabilities: FAKE_CAPABILITIES.strong },
    { name: "judge", capabilities: FAKE_CAPABILITIES.strong },
  ]);
  provider.script("planner", [{
    kind: "reply",
    content: JSON.stringify({
      decision: "approve",
      rationale: "Two coding tasks.",
      concerns: [],
      proposal: {
        tasks: [
          { title: "Task A", requirementRef: "R1", acceptance: ["A works"], kind: "bugfix", dependsOn: [] },
          { title: "Task B", requirementRef: "R2", acceptance: ["B works"], kind: "bugfix", dependsOn: [] },
        ],
      },
    }),
  }]);
  provider.script("scope", [{
    kind: "reply",
    content: JSON.stringify({
      decision: "approve",
      rationale: "Everything is out of scope.",
      concerns: [],
      proposal: { dropRefs: ["R1", "R2"] },
    }),
  }]);
  provider.script("judge", [{
    kind: "reply",
    content: JSON.stringify({
      decision: "needs_human",
      rationale: "No executable plan remains.",
      concerns: ["Need a product decision."],
    }),
  }]);
  return provider;
}

function councilRoles(provider: ScriptedProvider) {
  return {
    planner: { client: provider, model: { provider: "council", model: "planner" } },
    scope_guardian: { client: provider, model: { provider: "council", model: "scope" } },
    judge: { client: provider, model: { provider: "council", model: "judge" } },
  };
}

function decomposeCalls(provider: ScriptedProvider): number {
  return provider.calls.filter((call) => call.metadata.purpose.startsWith("council_decompose_")).length;
}

function codingTask(
  interpretationId: string,
  requirementRef: string,
  draft: { id: string; runId: string; title: string; now: number; base: string; dependsOn?: string[] },
): Task {
  return createTaskFromRequirement(interpretationId, requirementRef, {
    id: draft.id,
    runId: draft.runId,
    title: draft.title,
    description: `WHAT: ${draft.title}`,
    kind: "bugfix",
    acceptance: ["Checks pass"],
    complexity: "trivial",
    baseCheckpointHash: draft.base,
    ...(draft.dependsOn === undefined ? {} : { dependsOn: draft.dependsOn }),
    now: draft.now,
  });
}

function seedIntegrating(
  store: Store,
  clock: FakeClock,
  fixture: Awaited<ReturnType<typeof repositoryFixture>>,
  options: {
    winnerCommit: string;
    siblings: { state: TaskState; dependsOnWinner?: boolean }[];
    withInterpretation?: boolean;
  },
): { runId: string; taskId: string; siblingIds: string[] } {
  const runId = id("run", clock.now());
  const missionId = id("msn", clock.now());
  const interpretationId = id("interp", clock.now());
  const now = clock.now();
  const winner = codingTask(interpretationId, "R1", {
    id: id("task", clock.now()),
    runId,
    title: "Task A",
    now,
    base: fixture.base,
  });
  const candidateId = id("cand", clock.now());
  const siblingIds: string[] = [];
  const siblings = options.siblings.map((spec, index) => {
    const task = {
      ...codingTask(interpretationId, `R${index + 2}`, {
        id: id("task", clock.now() + index + 1),
        runId,
        title: `Task ${index + 2}`,
        now,
        base: fixture.base,
        dependsOn: spec.dependsOnWinner === true ? [winner.id] : [],
      }),
      state: spec.state,
    };
    siblingIds.push(task.id);
    return task;
  });
  const baseline: BaselineSnapshot = { ...fixture.gates.baseline, id: id("base", clock.now()), runId };
  const events = [
    event(runId, clock, "run.created", {
      run: {
        id: runId,
        missionId,
        projectPath: fixture.repoDir,
        runBranch: "run",
        phase: "INTEGRATING",
        control: "RUNNING",
        currentCheckpointHash: fixture.base,
        baselineId: baseline.id,
        interpretationId: options.withInterpretation === true ? interpretationId : null,
        createdAt: now,
        updatedAt: now,
        terminalReason: null,
      },
    }),
    event(runId, clock, "baseline.snapshotted", { baseline }),
    event(runId, clock, "task.created", {
      task: { ...winner, state: "QUEUED_FOR_INTEGRATION", selectedCandidateId: candidateId },
    }),
    event(runId, clock, "candidate.created", {
      candidate: {
        id: candidateId,
        runId,
        taskId: winner.id,
        attempt: 1,
        model: { provider: "worker", model: "candidate-0" },
        baseCheckpointHash: fixture.base,
        branch: `polish/${runId}/winner`,
        worktreePath: null,
        headCommit: options.winnerCommit,
        state: "WINNER",
        gateReport: null,
        transcriptRef: null,
        diffRef: null,
        createdAt: now,
        updatedAt: now,
      },
    }),
    ...siblings.map((task) => event(runId, clock, "task.created", { task })),
  ];
  if (options.withInterpretation === true) {
    events.push(event(runId, clock, "mission.interpreted", {
      interpretation: interpretationFor(missionId, interpretationId, baseline.id),
    }));
  }
  store.events.append(events);
  return { runId, taskId: winner.id, siblingIds };
}

function seedTwoReadyTasks(
  store: Store,
  clock: FakeClock,
  fixture: Awaited<ReturnType<typeof repositoryFixture>>,
): { runId: string; taskA: string; taskB: string } {
  const runId = id("run", clock.now());
  const missionId = id("msn", clock.now());
  const interpretationId = id("interp", clock.now());
  const now = clock.now();
  const taskA = {
    ...codingTask(interpretationId, "R1", { id: id("task", clock.now()), runId, title: "Task A", now, base: fixture.base }),
    state: "READY" as const,
  };
  const taskB = {
    ...codingTask(interpretationId, "R2", { id: id("task", clock.now() + 1), runId, title: "Task B", now, base: fixture.base }),
    state: "READY" as const,
  };
  const baseline: BaselineSnapshot = { ...fixture.gates.baseline, id: id("base", clock.now()), runId };
  store.events.append([
    event(runId, clock, "run.created", {
      run: {
        id: runId,
        missionId,
        projectPath: fixture.repoDir,
        runBranch: "run",
        phase: "EXECUTING",
        control: "RUNNING",
        currentCheckpointHash: fixture.base,
        baselineId: baseline.id,
        interpretationId,
        createdAt: now,
        updatedAt: now,
        terminalReason: null,
      },
    }),
    event(runId, clock, "baseline.snapshotted", { baseline }),
    event(runId, clock, "mission.interpreted", { interpretation: interpretationFor(missionId, interpretationId, baseline.id) }),
    event(runId, clock, "task.created", { task: taskA }),
    event(runId, clock, "task.created", { task: taskB }),
  ]);
  return { runId, taskA: taskA.id, taskB: taskB.id };
}

function seedConvergence(
  store: Store,
  clock: FakeClock,
  fixture: { root: string; repoDir: string; base: string; integrated: string },
  options: {
    siblings: { state: TaskState; origin?: "mission" | "valid_finding" }[];
    cleanRounds?: number;
  },
): { runId: string } {
  const runId = id("run", clock.now());
  const missionId = id("msn", clock.now());
  const interpretationId = id("interp", clock.now());
  const now = clock.now();
  const primary = {
    ...codingTask(interpretationId, "R1", { id: id("task", clock.now()), runId, title: "Task A", now, base: fixture.base }),
    state: "INTEGRATED" as const,
  };
  const siblings = options.siblings.map((spec, index) => {
    const task = {
      ...codingTask(interpretationId, `R${index + 2}`, {
        id: id("task", clock.now() + index + 1),
        runId,
        title: `Task ${index + 2}`,
        now,
        base: fixture.base,
      }),
      state: spec.state,
    };
    if (spec.origin === "valid_finding") {
      return {
        ...task,
        origin: {
          kind: "valid_finding" as const,
          findingId: id("find", clock.now() + index),
          validationId: id("fval", clock.now() + index),
          verdict: "VALID" as const,
        },
      };
    }
    return task;
  });
  const baseline: BaselineSnapshot = {
    id: id("base", clock.now()),
    runId,
    commitHash: fixture.base,
    checks: [],
    configHashes: {},
    scriptsHash: "0".repeat(64),
    toolchain: {},
    createdAt: now,
  };
  const checkpoint: Checkpoint = {
    id: id("cp", clock.now()),
    runId,
    seq: 1,
    commitHash: fixture.integrated,
    parentId: null,
    source: "integration",
    taskId: primary.id,
    evidence: {
      gates: { test: "pass" },
      testsPassed: 1,
      testsFailed: 0,
      testsTotal: 1,
      openValidatedFindings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      diffLinesFromBaseline: 3,
    },
    createdAt: now,
  };
  store.events.append([
    event(runId, clock, "run.created", {
      run: {
        id: runId,
        missionId,
        projectPath: fixture.repoDir,
        runBranch: "run",
        phase: "CONVERGENCE_CHECK",
        control: "RUNNING",
        currentCheckpointHash: fixture.integrated,
        baselineId: baseline.id,
        interpretationId: null,
        createdAt: now,
        updatedAt: now,
        terminalReason: null,
      },
    }),
    event(runId, clock, "baseline.snapshotted", { baseline }),
    event(runId, clock, "task.created", { task: primary }),
    ...siblings.map((task) => event(runId, clock, "task.created", { task })),
    event(runId, clock, "checkpoint.created", { checkpoint }),
    event(runId, clock, "candidate.created", {
      candidate: {
        id: id("cand", clock.now()),
        runId,
        taskId: primary.id,
        attempt: 1,
        model: { provider: "p", model: "worker" },
        baseCheckpointHash: fixture.base,
        branch: "cand/1",
        worktreePath: join(fixture.root, "wt"),
        headCommit: fixture.integrated,
        state: "PASSED_GATES",
        gateReport: {
          gatedCommit: fixture.integrated,
          checks: [],
          injectedAcceptance: [],
          failures: [],
          passed: true,
          diffStat: { files: 1, insertions: 2, deletions: 0 },
          createdAt: now,
        },
        transcriptRef: null,
        diffRef: null,
        createdAt: now,
        updatedAt: now,
      },
    }),
  ]);
  seedB6Proof(store, clock, runId, fixture.integrated, options.cleanRounds ?? 3);
  return { runId };
}

function seedB6Proof(store: Store, clock: FakeClock, runId: string, checkpointHash: string, cleanRounds = 3): void {
  for (let roundIndex = 1; roundIndex <= cleanRounds; roundIndex += 1) {
    const proof = reviewRound(runId, checkpointHash, roundIndex);
    for (const [index, execution] of proof.entries()) {
      store.events.append([event(runId, clock, "review.finished", { execution }, clock.now() + 20 + roundIndex * 10 + index)]);
    }
    const cleanRound: CleanRound = {
      id: id("cr", clock.now() + roundIndex),
      runId,
      checkpointHash,
      roundIndex,
      reviewRoundIndex: roundIndex,
      axes: proof.map((execution) => execution.axis),
      ensemble: proof.map((execution) => execution.requestedModel),
      rawFindings: 0,
      validatedBlocking: 0,
      novel: true,
      createdAt: clock.now() + roundIndex,
    };
    store.events.append([event(runId, clock, "clean_round.recorded", { cleanRound }, clock.now() + 100 + roundIndex)]);
  }
}

function reviewRound(runId: string, checkpointHash: string, roundIndex: number): ReviewExecution[] {
  return (["correctness", "regression", "adversarial"] as const).map((axis, index) => ({
    id: id("rvex", NOW + roundIndex * 10 + index),
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

function event(
  runId: string,
  clock: FakeClock,
  type: string,
  payload: Record<string, unknown>,
  ts = clock.now(),
) {
  return {
    id: id("evt", ts),
    runId,
    ts,
    type: type as "run.created",
    payload,
    causedBy: [] as string[],
    actor: { kind: "system" as const },
    artifacts: [] as [],
  };
}

async function commitOnBranch(repoDir: string, base: string, branch: string, outcome: string): Promise<string> {
  const git = new Git(repoDir);
  await git.run(["checkout", "-q", "-b", branch, base]);
  writeFileSync(join(repoDir, "outcome.txt"), outcome);
  const commit = await git.commitAll(branch);
  if (commit === null) throw new Error("winner commit missing");
  await git.run(["checkout", "-q", "run"]);
  return commit;
}

async function repositoryFixture(): Promise<{
  root: string;
  repoDir: string;
  base: string;
  sandbox: WorktreeSandbox;
  policy: CommandPolicy;
  gates: CandidateGates;
}> {
  const root = mkdtempSync(join(tmpdir(), "polish-b-selfhost-3-"));
  cleanup.push(root);
  const repoDir = join(root, "repo");
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "polish-b-selfhost-3", scripts: {} }));
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
  const baselineCheck = {
    name: "gate",
    kind: "custom" as const,
    status: "pass" as const,
    exitCode: 0,
    durationMs: 1,
    summary: null,
    outputRef: null,
  };
  return {
    root,
    repoDir,
    base,
    sandbox: new WorktreeSandbox(repoDir, join(root, "worktrees"), defaultConfig().sandbox),
    policy,
    gates: {
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
    },
  };
}
