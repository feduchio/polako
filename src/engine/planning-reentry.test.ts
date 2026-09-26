import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselineSnapshot } from "../domain/checks.js";
import { defaultConfig } from "../domain/config.js";
import { findingFingerprint, type Finding } from "../domain/finding.js";
import type { MissionInterpretation } from "../domain/mission.js";
import { reviewAxesForRound, type ReviewExecution } from "../domain/review.js";
import {
  createInvestigationTask,
  createTaskFromRequirement,
  type TaskState,
} from "../domain/task.js";
import { FAKE_CAPABILITIES, ScriptedProvider, reply } from "../providers/scripted.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { Scheduler } from "../scheduler/index.js";
import { CommandPolicy } from "../sandbox/allowlist.js";
import { Git } from "../sandbox/git.js";
import { WorktreeSandbox } from "../sandbox/worktree.js";
import { stubDriverFor } from "./stubs.js";
import { RunEngine } from "./engine.js";
import { createPlanningDriver } from "./councilDrivers.js";
import {
  createExecutingDriver,
  createGatingDriver,
  createIntegratingDriver,
  type CandidateDriverOptions,
} from "./candidateDrivers.js";
import { ScriptedCandidateWorker, type CandidateGates } from "./candidates.js";
import { createValidatingDriver } from "./reviewDrivers.js";
import { ScriptedFindingEvidenceWorker } from "../findings/index.js";
import { inspectManifestHashes } from "../project/discovery.js";
import type { ProjectProfile } from "../project/profile.js";
import { GitBranchRunHead } from "./integration.js";
import { SYSTEM_ACTOR } from "../domain/common.js";

const NOW = 1_700_000_000_000;
const HASH = "a".repeat(40);
const SHA = "b".repeat(64);

describe("planning re-entry", () => {
  let dir: string;
  let store: Store;
  let clock: FakeClock;
  let sched: Scheduler;
  let engine: RunEngine;
  let provider: ScriptedProvider;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polish-planning-reentry-"));
    store = openStore({ artifactsDir: join(dir, "artifacts") });
    clock = new FakeClock(NOW);
    sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 60_000 });
    provider = scriptedCouncilProvider({ dropAll: true });
    engine = new RunEngine({ store, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined }, false);
    for (const phase of [
      "CREATED",
      "DISCOVERING_PROJECT",
      "BASELINING",
      "INTERPRETING_MISSION",
      "DISCOVERING_MODELS",
      "EXECUTING",
      "GATING",
      "COMPARING",
      "INTEGRATING",
      "REVIEWING",
      "VALIDATING",
      "CONVERGENCE_CHECK",
    ] as const) {
      engine.registerPhase(phase, stubDriverFor(phase));
    }
    engine.registerPhase("PLANNING", createPlanningDriver({ roles: councilRoles(provider) }));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("first plan decomposes once, creates the DAG, and advances to EXECUTING", async () => {
    provider = scriptedCouncilProvider();
    engine.registerPhase("INTERPRETING_MISSION", stubDriverFor("INTERPRETING_MISSION"));
    engine.registerPhase("DISCOVERING_MODELS", stubDriverFor("DISCOVERING_MODELS"));
    engine.registerPhase("PLANNING", createPlanningDriver({ roles: councilRoles(provider) }));
    const { runId } = seedPlannedRun(store, clock, { phase: "PLANNING", tasks: [] });
    await engine.tickRun(runId);
    const tasks = store.repos.tasks.listByRun(runId);
    expect(decomposeCalls(provider)).toBe(3);
    expect(store.events.list(runId, { types: ["task.created"] })).toHaveLength(tasks.length);
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(store.repos.runs.get(runId)?.phase).toBe("EXECUTING");
  });

  it("a split request becomes council-planned subtasks that keep the parent's origin and every acceptance criterion", async () => {
    provider = splitCouncilProvider("approve");
    engine.registerPhase("PLANNING", createPlanningDriver({ roles: councilRoles(provider) }));
    const { runId, taskId } = seedPlannedRun(store, clock, { phase: "PLANNING", tasks: [{ state: "NEEDS_SPLIT", attempts: 1 }] });
    seedSplitCandidate(store, clock, runId, taskId);
    await engine.tickRun(runId);

    expect(decomposeCalls(provider)).toBe(0);
    expect(provider.calls.filter((call) => call.metadata.purpose.startsWith("council_split_"))).toHaveLength(3);
    const plannerPayload = provider.calls.find((call) => call.metadata.purpose === "council_split_planner")?.messages.at(-1)?.content ?? "";
    expect(plannerPayload).toContain("parser and printer are separate");
    const parent = store.repos.tasks.get(taskId)!;
    expect(parent.state).toBe("SPLIT");
    const parts = store.repos.tasks.listByRun(runId).filter((task) => task.splitFrom === taskId);
    expect(parts.map((part) => part.title)).toEqual(["Parser", "Printer"]);
    for (const part of parts) {
      expect(part.origin).toEqual(parent.origin);
      expect(part.kind).toBe(parent.kind);
      expect(part.state).toBe("PENDING");
    }
    expect(parts[0]!.acceptance).toEqual(["parser tests pass"]);
    expect(parts[1]!.acceptance).toEqual(["printer tests pass", "Login works"]);
    expect(parts[1]!.dependsOn).toEqual([parts[0]!.id]);
    expect(store.repos.runs.get(runId)?.phase).toBe("EXECUTING");
  });

  it("a split the council refuses is retried whole, with no new tasks", async () => {
    provider = splitCouncilProvider("needs_human");
    engine.registerPhase("PLANNING", createPlanningDriver({ roles: councilRoles(provider) }));
    const { runId, taskId } = seedPlannedRun(store, clock, { phase: "PLANNING", tasks: [{ state: "NEEDS_SPLIT", attempts: 1 }] });
    seedSplitCandidate(store, clock, runId, taskId);
    await engine.tickRun(runId);
    expect(store.repos.tasks.get(taskId)?.state).toBe("READY");
    expect(store.repos.tasks.listByRun(runId)).toHaveLength(1);
    expect(store.repos.runs.get(runId)?.phase).toBe("EXECUTING");
  });

  it("re-entry with nothing to split never resolves council roles", async () => {
    engine.registerPhase("PLANNING", createPlanningDriver({
      roles: () => {
        throw new Error("council roles must not be resolved without a split request");
      },
    }));
    const { runId, taskId } = seedPlannedRun(store, clock, { phase: "PLANNING", tasks: [{ state: "READY" }] });
    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("EXECUTING");
    expect(store.repos.tasks.get(taskId)?.state).toBe("READY");
  });

  it("a NEEDS_SPLIT task with no split request for its attempt is retried whole without asking the council", async () => {
    provider = splitCouncilProvider("approve");
    engine.registerPhase("PLANNING", createPlanningDriver({ roles: councilRoles(provider) }));
    const { runId, taskId } = seedPlannedRun(store, clock, { phase: "PLANNING", tasks: [{ state: "NEEDS_SPLIT", attempts: 1 }] });
    await engine.tickRun(runId);
    expect(provider.calls).toHaveLength(0);
    expect(store.repos.tasks.get(taskId)?.state).toBe("READY");
    expect(store.repos.tasks.listByRun(runId)).toHaveLength(1);
  });

  it("a split finished by another driver while the council deliberated is not applied twice", async () => {
    const { runId, taskId } = seedPlannedRun(store, clock, { phase: "PLANNING", tasks: [{ state: "NEEDS_SPLIT", attempts: 1 }] });
    seedSplitCandidate(store, clock, runId, taskId);
    provider = splitCouncilProvider("approve", () => {
      forceTaskState(store, clock, taskId, "SPLIT", 1);
    });
    engine.registerPhase("PLANNING", createPlanningDriver({ roles: councilRoles(provider) }));
    await engine.tickRun(runId);
    expect(provider.calls.filter((call) => call.metadata.purpose.startsWith("council_split_"))).toHaveLength(3);
    expect(store.repos.tasks.get(taskId)?.state).toBe("SPLIT");
    expect(store.repos.tasks.listByRun(runId).filter((task) => task.splitFrom === taskId)).toEqual([]);
    const transitions = store.events
      .list(runId, { types: ["task.state_changed"] })
      .filter((event) => (event.payload["task"] as { id: string }).id === taskId);
    expect(transitions).toHaveLength(1);
  });

  it("GATING retry re-enters PLANNING without decompose or a new task.created", async () => {
    engine.registerPhase("GATING", createGatingDriver(unusedCandidateOptions()));
    const { runId, taskId } = seedPlannedRun(store, clock, {
      phase: "GATING",
      tasks: [{ state: "GATED", attempts: 1 }],
    });
    const createdBefore = store.events.list(runId, { types: ["task.created"] }).length;
    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("PLANNING");
    expect(store.repos.tasks.get(taskId)?.state).toBe("READY");
    await engine.tickRun(runId);
    expect(decomposeCalls(provider)).toBe(0);
    expect(store.events.list(runId, { types: ["task.created"] })).toHaveLength(createdBefore);
    expect(store.repos.tasks.listByRun(runId)).toHaveLength(1);
    expect(store.repos.tasks.get(taskId)?.id).toBe(taskId);
    expect(store.repos.tasks.get(taskId)?.state).toBe("READY");
    expect(store.repos.runs.get(runId)?.phase).toBe("EXECUTING");
  });

  it("repeated GATING→PLANNING bounces do not multiply the DAG", async () => {
    engine.registerPhase("GATING", createGatingDriver(unusedCandidateOptions()));
    const { runId, taskId } = seedPlannedRun(store, clock, {
      phase: "GATING",
      tasks: [{ state: "GATED", attempts: 1 }],
    });
    const createdBefore = store.events.list(runId, { types: ["task.created"] }).length;
    for (let bounce = 0; bounce < 3; bounce++) {
      forcePhase(store, clock, runId, "GATING");
      forceTaskState(store, clock, taskId, "GATED", 1 + bounce);
      await engine.tickRun(runId);
      expect(store.repos.runs.get(runId)?.phase).toBe("PLANNING");
      await engine.tickRun(runId);
      expect(decomposeCalls(provider)).toBe(0);
      expect(store.repos.runs.get(runId)?.phase).toBe("EXECUTING");
    }
    expect(store.events.list(runId, { types: ["task.created"] })).toHaveLength(createdBefore);
    expect(store.repos.tasks.listByRun(runId).map((task) => task.id)).toEqual([taskId]);
  });

  it("PLANNING re-entry restores INTEGRATION_FAILED to READY on the same task id", async () => {
    const { runId, taskId } = seedPlannedRun(store, clock, {
      phase: "PLANNING",
      tasks: [{ state: "INTEGRATION_FAILED", attempts: 1 }],
    });
    const createdBefore = store.events.list(runId, { types: ["task.created"] }).length;
    await engine.tickRun(runId);
    expect(decomposeCalls(provider)).toBe(0);
    expect(store.events.list(runId, { types: ["task.created"] })).toHaveLength(createdBefore);
    expect(store.repos.tasks.get(taskId)?.state).toBe("READY");
    expect(store.repos.runs.get(runId)?.phase).toBe("EXECUTING");
  });

  it("VALIDATING finding work is not re-created on PLANNING re-entry", async () => {
    engine.registerPhase(
      "VALIDATING",
      createValidatingDriver({
        resolveWorker: () =>
          new ScriptedFindingEvidenceWorker(() => ({
            method: "failing_test",
            verdict: "VALID",
            rationale: "reproduced",
            evidenceRefs: [{ sha256: SHA, kind: "test_output", bytes: 12 }],
          })),
      }),
    );
    const { runId } = seedValidatingThenPlanning(store, clock);
    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("PLANNING");
    const createdAfterValidate = store.events.list(runId, { types: ["task.created"] });
    expect(createdAfterValidate).toHaveLength(1);
    expect(store.repos.tasks.listByRun(runId)[0]?.origin.kind).toBe("valid_finding");
    const pending = store.repos.tasks.listByRun(runId).filter((task) => task.state === "PENDING");
    for (const task of pending) {
      store.events.append([{
        id: id("evt", clock.now()),
        runId,
        ts: clock.now(),
        type: "task.state_changed",
        payload: { task: { ...task, state: "READY", updatedAt: clock.now() } },
        causedBy: [],
        actor: SYSTEM_ACTOR,
        artifacts: [],
      }]);
    }
    await engine.tickRun(runId);
    expect(decomposeCalls(provider)).toBe(0);
    expect(store.events.list(runId, { types: ["task.created"] })).toHaveLength(1);
    const task = store.repos.tasks.listByRun(runId)[0]!;
    expect(task.state === "READY" || task.state === "PENDING").toBe(true);
    expect(store.repos.runs.get(runId)?.phase).toBe("EXECUTING");
  });

  it("two consecutive PLANNING ticks on an existing DAG never decompose or append task.created", async () => {
    const { runId, taskId } = seedPlannedRun(store, clock, {
      phase: "PLANNING",
      tasks: [{ state: "READY", attempts: 1 }],
    });
    const createdBefore = store.events.list(runId, { types: ["task.created"] }).length;
    await engine.tickRun(runId);
    forcePhase(store, clock, runId, "PLANNING");
    await engine.tickRun(runId);
    expect(decomposeCalls(provider)).toBe(0);
    expect(store.events.list(runId, { types: ["task.created"] })).toHaveLength(createdBefore);
    expect(store.repos.tasks.get(taskId)?.id).toBe(taskId);
  });

  it("a live investigation re-enters EXECUTING, where the engine runs it", async () => {
    const { runId } = seedInvestigationOnly(store, clock);
    const createdBefore = store.events.list(runId, { types: ["task.created"] }).length;
    await engine.tickRun(runId);
    expect(decomposeCalls(provider)).toBe(0);
    expect(store.events.list(runId, { types: ["task.created"] })).toHaveLength(createdBefore);
    const run = store.repos.runs.get(runId)!;
    expect(run.phase).toBe("EXECUTING");
    expect(run.terminalReason).toBeNull();
  });

  it("an investigation that used up its attempts escalates to NEEDS_HUMAN", async () => {
    const { runId } = seedInvestigationOnly(store, clock);
    const task = store.repos.tasks.listByRun(runId)[0]!;
    forceTaskState(store, clock, task.id, "BLOCKED", defaultConfig().retry.maxAttempts);
    await engine.tickRun(runId);
    const run = store.repos.runs.get(runId)!;
    expect(run.phase).toBe("NEEDS_HUMAN");
    expect(run.terminalReason?.summary).toMatch(/No reproduction the engine could run settled 1 uncertain finding/);
    expect(store.events.list(runId, { types: ["report.generated"] }).length).toBeGreaterThanOrEqual(1);
  });

  it("a settled investigation hands the review round it came from to VALIDATING instead of opening a new round", async () => {
    const { runId } = seedInvestigationOnly(store, clock);
    const task = store.repos.tasks.listByRun(runId)[0]!;
    forceTaskState(store, clock, task.id, "SATISFIED", 1);
    seedCompletedReviewRound(store, clock, runId, 1);
    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("VALIDATING");
  });

  it("a review round already recorded clean does not hold the run in VALIDATING", async () => {
    const { runId } = seedInvestigationOnly(store, clock);
    const task = store.repos.tasks.listByRun(runId)[0]!;
    forceTaskState(store, clock, task.id, "SATISFIED", 1);
    const executions = seedCompletedReviewRound(store, clock, runId, 1);
    store.events.append([event(runId, clock, "clean_round.recorded", {
      cleanRound: {
        id: id("cr", clock.now()),
        runId,
        checkpointHash: HASH,
        roundIndex: 1,
        reviewRoundIndex: 1,
        axes: executions.map((execution) => execution.axis),
        ensemble: executions.map((execution) => execution.requestedModel),
        rawFindings: 0,
        validatedBlocking: 0,
        novel: true,
        createdAt: clock.now(),
      },
    })]);
    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("REVIEWING");
  });

  it("exhausted BLOCKED coding work fails without a replacement task", async () => {
    const { runId, taskId } = seedPlannedRun(store, clock, {
      phase: "PLANNING",
      tasks: [{ state: "BLOCKED", attempts: defaultConfig().retry.maxAttempts }],
    });
    const createdBefore = store.events.list(runId, { types: ["task.created"] }).length;
    await engine.tickRun(runId);
    expect(decomposeCalls(provider)).toBe(0);
    expect(store.events.list(runId, { types: ["task.created"] })).toHaveLength(createdBefore);
    expect(store.repos.tasks.get(taskId)?.state).toBe("BLOCKED");
    expect(store.repos.runs.get(runId)?.phase).toBe("FAILED");
  });

  it("exhausted INTEGRATION_FAILED coding work does not go REVIEWING or EXECUTING", async () => {
    const { runId, taskId } = seedPlannedRun(store, clock, {
      phase: "PLANNING",
      tasks: [{ state: "INTEGRATION_FAILED", attempts: defaultConfig().retry.maxAttempts }],
    });
    await engine.tickRun(runId);
    expect(decomposeCalls(provider)).toBe(0);
    expect(store.repos.tasks.get(taskId)?.id).toBe(taskId);
    expect(["FAILED", "NEEDS_HUMAN"]).toContain(store.repos.runs.get(runId)?.phase);
    expect(store.repos.runs.get(runId)?.phase).not.toBe("REVIEWING");
    expect(store.repos.runs.get(runId)?.phase).not.toBe("EXECUTING");
    expect(store.repos.runs.get(runId)?.phase).not.toBe("DONE");
  });

  it("re-entry ignores a drop-all council and does not emit second-plan NEEDS_HUMAN", async () => {
    const { runId, taskId } = seedPlannedRun(store, clock, {
      phase: "PLANNING",
      tasks: [{ state: "READY", attempts: 1 }],
    });
    await engine.tickRun(runId);
    expect(decomposeCalls(provider)).toBe(0);
    expect(store.repos.runs.get(runId)?.phase).toBe("EXECUTING");
    expect(store.repos.runs.get(runId)?.terminalReason).toBeNull();
    expect(store.repos.tasks.get(taskId)?.state).toBe("READY");
    expect(store.events.list(runId, { types: ["report.generated"] })).toHaveLength(0);
  });

  it("only INTEGRATED coding tasks on re-entry advance to REVIEWING", async () => {
    const { runId } = seedPlannedRun(store, clock, {
      phase: "PLANNING",
      tasks: [{ state: "INTEGRATED", attempts: 1 }],
    });
    await engine.tickRun(runId);
    expect(decomposeCalls(provider)).toBe(0);
    expect(store.repos.runs.get(runId)?.phase).toBe("REVIEWING");
  });
});

describe("INTEGRATING retry then PLANNING re-entry", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("schedules the same task id in EXECUTING after an integration retry", async () => {
    const fixture = await repositoryFixture(cleanup);
    const store = openStore({ artifactsDir: join(fixture.root, "artifacts") });
    const clock = new FakeClock(NOW);
    const sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 60_000 });
    const provider = scriptedCouncilProvider({ dropAll: true });
    const options = buildDriverOptions(fixture);
    const engine = new RunEngine({ store, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined }, false);
    for (const phase of [
      "CREATED",
      "DISCOVERING_PROJECT",
      "BASELINING",
      "INTERPRETING_MISSION",
      "DISCOVERING_MODELS",
      "REVIEWING",
      "VALIDATING",
      "CONVERGENCE_CHECK",
      "GATING",
      "COMPARING",
    ] as const) {
      engine.registerPhase(phase, stubDriverFor(phase));
    }
    engine.registerPhase("PLANNING", createPlanningDriver({ roles: councilRoles(provider) }));
    engine.registerPhase("EXECUTING", createExecutingDriver(options));
    engine.registerPhase("INTEGRATING", createIntegratingDriver(options));

    const failCommit = await commitOnBranch(fixture.repoDir, fixture.base, "winner-fail", "fail");
    const { runId, taskId } = seedIntegratingWithInterpretation(store, clock, fixture, failCommit);
    const createdBefore = store.events.list(runId, { types: ["task.created"] }).length;
    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("PLANNING");
    expect(store.repos.tasks.get(taskId)?.state).toBe("READY");
    await engine.tickRun(runId);
    expect(decomposeCalls(provider)).toBe(0);
    expect(store.events.list(runId, { types: ["task.created"] })).toHaveLength(createdBefore);
    expect(store.repos.runs.get(runId)?.phase).toBe("EXECUTING");
    await engine.tickRun(runId);
    expect(store.repos.runs.get(runId)?.phase).toBe("GATING");
    const candidates = store.repos.candidates.listByTask(taskId);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((candidate) => candidate.taskId === taskId)).toBe(true);
    store.close();
  });
});

function decomposeCalls(provider: ScriptedProvider): number {
  return provider.calls.filter((call) => call.metadata.purpose.startsWith("council_decompose_")).length;
}

function councilRoles(provider: ScriptedProvider) {
  return {
    planner: { client: provider, model: { provider: "council", model: "planner" } },
    scope_guardian: { client: provider, model: { provider: "council", model: "scope" } },
    judge: { client: provider, model: { provider: "council", model: "judge" } },
  };
}

function scriptedCouncilProvider(opts: { dropAll?: boolean } = {}): ScriptedProvider {
  const provider = new ScriptedProvider("council", [
    { name: "planner", capabilities: FAKE_CAPABILITIES.strong },
    { name: "scope", capabilities: FAKE_CAPABILITIES.strong },
    { name: "judge", capabilities: FAKE_CAPABILITIES.strong },
  ]);
  provider.script("planner", [
    {
      kind: "reply",
      content: JSON.stringify({
        decision: "approve",
        rationale: "One coding task.",
        concerns: [],
        proposal: {
          tasks: [{ title: "Fix login", requirementRef: "R1", acceptance: ["Login works"], kind: "bugfix", dependsOn: [] }],
        },
      }),
    },
  ]);
  provider.script("scope", [
    {
      kind: "reply",
      content: JSON.stringify({
        decision: "approve",
        rationale: opts.dropAll === true ? "Everything is out of scope." : "Dependencies do not widen scope.",
        concerns: [],
        proposal: { dropRefs: opts.dropAll === true ? ["R1"] : [] },
      }),
    },
  ]);
  provider.script("judge", [
    {
      kind: "reply",
      content: JSON.stringify({
        decision: opts.dropAll === true ? "needs_human" : "approve",
        rationale: opts.dropAll === true ? "No executable plan remains." : "The plan is executable.",
        concerns: opts.dropAll === true ? ["Need a product decision."] : [],
      }),
    },
  ]);
  return provider;
}

function splitCouncilProvider(judge: "approve" | "needs_human", onJudge?: () => void): ScriptedProvider {
  const provider = new ScriptedProvider("council", [
    { name: "planner", capabilities: FAKE_CAPABILITIES.strong },
    { name: "scope", capabilities: FAKE_CAPABILITIES.strong },
    { name: "judge", capabilities: FAKE_CAPABILITIES.strong },
  ]);
  provider.script("planner", [{
    kind: "reply",
    content: JSON.stringify({
      decision: "approve",
      rationale: "Two parts.",
      concerns: [],
      proposal: {
        tasks: [
          { title: "Parser", acceptance: ["parser tests pass"], files: ["src/parse.ts"], dependsOn: [] },
          { title: "Printer", acceptance: ["printer tests pass"], files: ["src/print.ts"], dependsOn: [0] },
        ],
      },
    }),
  }]);
  provider.script("scope", [{ kind: "reply", content: JSON.stringify({ decision: "approve", rationale: "In scope.", concerns: [] }) }]);
  const verdict = JSON.stringify({
    decision: judge,
    rationale: judge === "approve" ? "Covers the task." : "The parts drop the login behaviour.",
    concerns: judge === "approve" ? [] : ["The parts drop the login behaviour."],
  });
  provider.script("judge", [onJudge === undefined
    ? { kind: "reply", content: verdict }
    : {
        kind: "fn",
        fn: () => {
          onJudge();
          return reply(verdict, 1, 1);
        },
      }]);
  return provider;
}

function seedSplitCandidate(store: Store, clock: FakeClock, runId: string, taskId: string): void {
  const candidate = {
    id: id("cand", clock.now()),
    runId,
    taskId,
    attempt: 1,
    model: { provider: "scripted", model: "worker" },
    baseCheckpointHash: HASH,
    branch: "polish/test/split",
    worktreePath: null,
    headCommit: null,
    state: "NEEDS_SPLIT",
    gateReport: null,
    error: "needs_split: parser and printer are separate",
    transcriptRef: null,
    diffRef: null,
    splitRequest: {
      reason: "parser and printer are separate",
      parts: [
        { title: "Parser", acceptance: ["parser tests pass"], files: ["src/parse.ts"] },
        { title: "Printer", acceptance: ["printer tests pass"], files: ["src/print.ts"] },
      ],
    },
    createdAt: clock.now(),
    updatedAt: clock.now(),
  };
  store.events.append([event(runId, clock, "candidate.created", { candidate })]);
}

function unusedCandidateOptions(): CandidateDriverOptions {
  return {
    sandbox: {
      create: async () => {
        throw new Error("gating retry test must not create a worktree");
      },
      list: async () => [],
    } as unknown as CandidateDriverOptions["sandbox"],
    policy: CommandPolicy.forProject([], null),
    workerFactory: () => () => {
      throw new Error("gating retry test must not start a worker");
    },
  };
}

function interpretationFor(missionId: string, interpretationId: string, baselineId: string): MissionInterpretation {
  return {
    id: interpretationId,
    missionId,
    version: 1,
    supersedes: null,
    basedOn: { profileHash: SHA, baselineId },
    goals: ["Fix the login bug"],
    requirements: [{ ref: "R1", statement: "Fix login timeout", acceptance: ["Login succeeds within 2s"] }],
    constraints: [],
    nonGoals: [],
    definitionOfSuccess: ["Checks pass"],
    ambiguities: [],
    createdBy: { kind: "supervisor", role: "council" },
    createdAt: NOW,
  };
}

function seedPlannedRun(
  store: Store,
  clock: FakeClock,
  opts: {
    phase: "PLANNING" | "GATING" | "INTEGRATING" | "EXECUTING";
    tasks: { state: TaskState; attempts?: number }[];
  },
): { runId: string; taskId: string; interpretationId: string } {
  const runId = id("run", clock.now());
  const missionId = id("msn", clock.now());
  const interpretationId = id("interp", clock.now());
  const baselineId = id("base", clock.now());
  const interpretation = interpretationFor(missionId, interpretationId, baselineId);
  const baseline: BaselineSnapshot = {
    id: baselineId,
    runId,
    commitHash: HASH,
    checks: [],
    configHashes: {},
    scriptsHash: "a".repeat(64),
    toolchain: {},
    createdAt: clock.now(),
  };
  const run = {
    id: runId,
    missionId,
    projectPath: "/repo",
    runBranch: `polish/${runId}`,
    phase: opts.phase,
    control: "RUNNING" as const,
    currentCheckpointHash: HASH,
    baselineId,
    interpretationId,
    createdAt: clock.now(),
    updatedAt: clock.now(),
    terminalReason: null,
  };
  const events = [
    event(runId, clock, "run.created", { run }),
    event(runId, clock, "baseline.snapshotted", { baseline }),
    event(runId, clock, "mission.interpreted", { interpretation }),
  ];
  let taskId = id("task", clock.now());
  for (const spec of opts.tasks) {
    const task = {
      ...createTaskFromRequirement(interpretationId, "R1", {
        id: id("task", clock.now()),
        runId,
        title: "Fix login",
        description: "WHAT: fix login",
        kind: "bugfix",
        acceptance: ["Login works"],
        complexity: "normal",
        baseCheckpointHash: HASH,
        now: clock.now(),
      }),
      state: spec.state,
      attempts: spec.attempts ?? 0,
    };
    taskId = task.id;
    events.push(event(runId, clock, "task.created", { task }));
  }
  store.events.append(events);
  return { runId, taskId, interpretationId };
}

function seedInvestigationOnly(store: Store, clock: FakeClock): { runId: string } {
  const runId = id("run", clock.now());
  const missionId = id("msn", clock.now());
  const interpretationId = id("interp", clock.now());
  const baselineId = id("base", clock.now());
  const finding = uncertainFinding(runId);
  const task = createInvestigationTask(finding, 2, {
    id: id("task", clock.now()),
    runId,
    title: "Investigate logout token",
    description: "WHAT: gather evidence",
    acceptance: ["Evidence recorded"],
    complexity: "normal",
    baseCheckpointHash: HASH,
    now: clock.now(),
  });
  store.events.append([
    event(runId, clock, "run.created", {
      run: {
        id: runId,
        missionId,
        projectPath: "/repo",
        runBranch: `polish/${runId}`,
        phase: "PLANNING",
        control: "RUNNING",
        currentCheckpointHash: HASH,
        baselineId,
        interpretationId,
        createdAt: clock.now(),
        updatedAt: clock.now(),
        terminalReason: null,
      },
    }),
    event(runId, clock, "baseline.snapshotted", {
      baseline: {
        id: baselineId,
        runId,
        commitHash: HASH,
        checks: [],
        configHashes: {},
        scriptsHash: "a".repeat(64),
        toolchain: {},
        createdAt: clock.now(),
      },
    }),
    event(runId, clock, "mission.interpreted", { interpretation: interpretationFor(missionId, interpretationId, baselineId) }),
    event(runId, clock, "finding.raised", { finding }),
    event(runId, clock, "task.created", { task }),
  ]);
  return { runId };
}

function seedCompletedReviewRound(store: Store, clock: FakeClock, runId: string, roundIndex: number): ReviewExecution[] {
  const executions = reviewAxesForRound(defaultConfig().review.reviewersPerRound).map((axis, index): ReviewExecution => ({
    id: id("rvex", clock.now()),
    runId,
    checkpointHash: HASH,
    roundIndex,
    axis,
    requestedModel: { provider: "scripted", model: `reviewer-${String(index)}` },
    completed: true,
    findings: [],
    startedAt: clock.now() + index,
    finishedAt: clock.now() + index,
  }));
  store.events.append(executions.map((execution) => event(runId, clock, "review.finished", { execution })));
  return executions;
}

function seedValidatingThenPlanning(store: Store, clock: FakeClock): { runId: string } {
  const runId = id("run", clock.now());
  const missionId = id("msn", clock.now());
  const interpretationId = id("interp", clock.now());
  const baselineId = id("base", clock.now());
  const finding = blockingFinding(runId);
  store.events.append([
    event(runId, clock, "run.created", {
      run: {
        id: runId,
        missionId,
        projectPath: "/repo",
        runBranch: `polish/${runId}`,
        phase: "VALIDATING",
        control: "RUNNING",
        currentCheckpointHash: HASH,
        baselineId,
        interpretationId,
        createdAt: clock.now(),
        updatedAt: clock.now(),
        terminalReason: null,
      },
    }),
    event(runId, clock, "baseline.snapshotted", {
      baseline: {
        id: baselineId,
        runId,
        commitHash: HASH,
        checks: [],
        configHashes: {},
        scriptsHash: "0".repeat(64),
        toolchain: {},
        createdAt: clock.now(),
      },
    }),
    event(runId, clock, "checkpoint.created", {
      checkpoint: {
        id: id("cp", clock.now()),
        runId,
        seq: 1,
        commitHash: HASH,
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
      },
    }),
    event(runId, clock, "mission.interpreted", { interpretation: interpretationFor(missionId, interpretationId, baselineId) }),
    event(runId, clock, "finding.raised", { finding }),
  ]);
  return { runId };
}

function blockingFinding(runId: string): Finding {
  const raw = {
    criterion: "auth.persistence",
    severity: "high" as const,
    blocking: true,
    claim: "logout leaves refresh token behind",
    evidence: [{ path: "src/auth/store.ts", line: 81 }],
    reproduction: ["pnpm test auth"],
    suggestedCheck: "regression test proves logout clears the token",
  };
  return {
    id: id("find", NOW),
    runId,
    checkpointHash: HASH,
    axis: "correctness",
    reportedBy: { kind: "reviewer" },
    status: "RAW",
    duplicateOf: null,
    fingerprint: findingFingerprint(raw),
    investigationRounds: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...raw,
  };
}

function uncertainFinding(runId: string): Finding {
  return { ...blockingFinding(runId), status: "UNCERTAIN" };
}

function event(runId: string, clock: FakeClock, type: string, payload: Record<string, unknown>) {
  return {
    id: id("evt", clock.now()),
    runId,
    ts: clock.now(),
    type,
    payload,
    causedBy: [] as string[],
    actor: { kind: "system" as const },
    artifacts: [] as [],
  };
}

function forcePhase(store: Store, clock: FakeClock, runId: string, phase: "PLANNING" | "GATING"): void {
  const run = store.repos.runs.get(runId);
  if (run === null) throw new Error("run missing");
  store.events.append([event(runId, clock, "run.phase_changed", { run: { ...run, phase, updatedAt: clock.now() } })]);
}

function forceTaskState(store: Store, clock: FakeClock, taskId: string, state: TaskState, attempts: number): void {
  const task = store.repos.tasks.get(taskId);
  if (task === null) throw new Error("task missing");
  store.events.append([event(task.runId, clock, "task.state_changed", { task: { ...task, state, attempts, updatedAt: clock.now() } })]);
}

async function repositoryFixture(cleanup: string[]): Promise<{
  root: string;
  repoDir: string;
  base: string;
  sandbox: WorktreeSandbox;
  policy: CommandPolicy;
  gates: CandidateGates;
}> {
  const root = mkdtempSync(join(tmpdir(), "polish-reentry-int-"));
  cleanup.push(root);
  const repoDir = join(root, "repo");
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "polish-reentry-fixture", scripts: {} }));
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
    discoveredAt: NOW,
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
        id: id("base", NOW),
        runId: id("run", NOW),
        commitHash: base,
        checks: [baselineCheck],
        configHashes: hashes.manifestHashes,
        scriptsHash: hashes.scriptsHash,
        toolchain: {},
        createdAt: NOW,
      },
      acceptanceArtifacts: [],
      materializeAcceptance: () => undefined,
      verifyAcceptance: () => [],
    },
  };
}

function buildDriverOptions(fixture: Awaited<ReturnType<typeof repositoryFixture>>): CandidateDriverOptions {
  let sequence = 0;
  return {
    sandbox: fixture.sandbox,
    policy: fixture.policy,
    workerFactory: () => (_index) => {
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

function seedIntegratingWithInterpretation(
  store: Store,
  clock: FakeClock,
  fixture: Awaited<ReturnType<typeof repositoryFixture>>,
  winnerCommit: string,
): { runId: string; taskId: string } {
  const runId = id("run", clock.now());
  const missionId = id("msn", clock.now());
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
  const candidateId = id("cand", clock.now());
  const now = clock.now();
  const baseline: BaselineSnapshot = { ...fixture.gates.baseline, id: id("base", clock.now()), runId };
  store.events.append([
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
        interpretationId,
        createdAt: now,
        updatedAt: now,
        terminalReason: null,
      },
    }),
    event(runId, clock, "baseline.snapshotted", { baseline }),
    event(runId, clock, "mission.interpreted", { interpretation: interpretationFor(missionId, interpretationId, baseline.id) }),
    event(runId, clock, "task.created", { task: { ...task, state: "SELECTED", selectedCandidateId: candidateId } }),
    event(runId, clock, "candidate.created", {
      candidate: {
        id: candidateId,
        runId,
        taskId: task.id,
        attempt: 1,
        model: { provider: "worker", model: "candidate-0" },
        baseCheckpointHash: fixture.base,
        branch: `polish/${runId}/winner`,
        worktreePath: null,
        headCommit: winnerCommit,
        state: "WINNER",
        gateReport: null,
        transcriptRef: null,
        diffRef: null,
        createdAt: now,
        updatedAt: now,
      },
    }),
  ]);
  return { runId, taskId: task.id };
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
