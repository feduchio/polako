import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../domain/config.js";
import { createMission } from "../domain/mission.js";
import type { BaselineSnapshot } from "../domain/checks.js";
import type { ProjectProfile } from "../project/profile.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { Scheduler } from "../scheduler/index.js";
import { stubDriverFor } from "./stubs.js";
import { RunEngine } from "./engine.js";
import {
  createDiscoveringModelsDriver,
  createInterpretingMissionDriver,
  createPlanningDriver,
} from "./councilDrivers.js";

const NOW = 1_700_000_000_000;

describe("council phase drivers", () => {
  let dir: string;
  let store: Store;
  let clock: FakeClock;
  let sched: Scheduler;
  let engine: RunEngine;
  let provider: ScriptedProvider;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polish-council-drivers-"));
    store = openStore({ artifactsDir: join(dir, "artifacts") });
    clock = new FakeClock(NOW);
    sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 60_000 });
    provider = scriptedCouncilProvider();
    engine = new RunEngine({ store, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined }, false);
    for (const phase of [
      "CREATED",
      "DISCOVERING_PROJECT",
      "BASELINING",
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
    engine.registerPhase("INTERPRETING_MISSION", createInterpretingMissionDriver({ roles: councilRoles(provider), resolveProfile: () => PROFILE }));
    engine.registerPhase("DISCOVERING_MODELS", createDiscoveringModelsDriver([]));
    engine.registerPhase("PLANNING", createPlanningDriver({ roles: councilRoles(provider) }));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("INTERPRETING_MISSION persists interpretation and sets run.interpretationId", async () => {
    const { runId, missionId } = seedRun(store, clock);
    await engine.tickRun(runId);
    const run = store.repos.runs.get(runId)!;
    expect(run.phase).toBe("DISCOVERING_MODELS");
    expect(run.interpretationId).not.toBeNull();
    const interpretation = store.repos.interpretations.get(run.interpretationId!)!;
    expect(interpretation.missionId).toBe(missionId);
    expect(interpretation.requirements.length).toBeGreaterThanOrEqual(1);
    expect(store.events.list(runId, { types: ["mission.interpreted"] })).toHaveLength(1);
    expect(store.events.list(runId, { types: ["supervisor.decision"] }).length).toBeGreaterThanOrEqual(1);
  });

  it("PLANNING persists task.created events and advances to EXECUTING", async () => {
    const { runId } = seedRun(store, clock);
    await engine.tickRun(runId);
    await engine.tickRun(runId);
    await engine.tickRun(runId);
    const run = store.repos.runs.get(runId)!;
    expect(run.phase).toBe("EXECUTING");
    const tasks = store.repos.tasks.listByRun(runId);
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks.every((task) => task.origin.kind === "mission_requirement")).toBe(true);
    expect(store.events.list(runId, { types: ["task.created"] }).length).toBe(tasks.length);
  });

  it("blocking ambiguity routes to NEEDS_HUMAN with zero coding tasks", async () => {
    provider = scriptedCouncilProvider(true);
    engine.registerPhase(
      "INTERPRETING_MISSION",
      createInterpretingMissionDriver({ roles: councilRoles(provider), resolveProfile: () => PROFILE }),
    );
    const { runId } = seedRun(store, clock);
    await engine.tickRun(runId);
    const run = store.repos.runs.get(runId)!;
    expect(run.phase).toBe("NEEDS_HUMAN");
    expect(store.repos.tasks.listByRun(runId)).toHaveLength(0);
  });

  it("PLANNING routes to NEEDS_HUMAN when the council drops every coding task", async () => {
    provider = scriptedCouncilProvider(false, { dropAll: true });
    engine.registerPhase("INTERPRETING_MISSION", createInterpretingMissionDriver({ roles: councilRoles(provider), resolveProfile: () => PROFILE }));
    engine.registerPhase("DISCOVERING_MODELS", createDiscoveringModelsDriver([]));
    engine.registerPhase("PLANNING", createPlanningDriver({ roles: councilRoles(provider) }));
    const { runId } = seedRun(store, clock);
    await engine.tickRun(runId);
    await engine.tickRun(runId);
    await engine.tickRun(runId);
    const run = store.repos.runs.get(runId)!;
    expect(run.phase).toBe("NEEDS_HUMAN");
    expect(store.repos.tasks.listByRun(runId)).toHaveLength(0);
  });
});

function seedRun(store: Store, clock: FakeClock): { runId: string; missionId: string } {
  const missionId = id("msn", clock.now());
  const runId = id("run", clock.now());
  const mission = createMission({
    id: missionId,
    projectPath: "/repo",
    text: "Fix the login timeout bug",
    userConstraints: ["Do not edit the plan"],
    createdAt: clock.now(),
  });
  const baseline: BaselineSnapshot = {
    id: id("base", clock.now()),
    runId,
    commitHash: "abcdef1",
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
    phase: "INTERPRETING_MISSION" as const,
    control: "RUNNING" as const,
    currentCheckpointHash: baseline.commitHash,
    baselineId: baseline.id,
    interpretationId: null,
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
      type: "mission.recorded",
      payload: { mission },
      causedBy: [],
      actor: { kind: "user" },
      artifacts: [],
    },
    {
      id: id("evt", clock.now() + 2),
      runId,
      ts: clock.now() + 2,
      type: "baseline.snapshotted",
      payload: { baseline },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
  ]);
  return { runId, missionId };
}

function councilRoles(provider: ScriptedProvider) {
  return {
    planner: { client: provider, model: { provider: "council", model: "planner" } },
    scope_guardian: { client: provider, model: { provider: "council", model: "scope" } },
    judge: { client: provider, model: { provider: "council", model: "judge" } },
  };
}

function scriptedCouncilProvider(blocking = false, opts: { dropAll?: boolean } = {}): ScriptedProvider {
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
        rationale: "Requirements are concrete.",
        concerns: [],
        proposal: {
          goals: ["Fix the login bug"],
          requirements: [{ ref: "R1", statement: "Fix login timeout", acceptance: ["Login succeeds within 2s"] }],
          constraints: ["Do not edit the plan"],
          nonGoals: [],
          definitionOfSuccess: ["Checks pass"],
          ambiguities: blocking
            ? [{ question: "Which API should remain compatible?", options: ["Public API", "Internal API"], blocking: true }]
            : [],
        },
      }),
    },
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
    opinion(blocking ? "needs_human" : "approve", "Scope is bounded.", blocking ? ["Compatibility is unclear."] : []),
    {
      kind: "reply" as const,
      content: JSON.stringify({
        decision: "approve",
        rationale: opts.dropAll === true ? "Everything is out of scope." : "Dependencies do not widen scope.",
        concerns: [],
        proposal: { dropRefs: opts.dropAll === true ? ["R1"] : [] },
      }),
    },
  ]);
  provider.script("judge", [opinion("approve", "Acceptance is testable.", []), opinion("approve", "The plan is executable.", [])]);
  return provider;
}

function opinion(decision: "approve" | "needs_human", rationale: string, concerns: string[]) {
  return { kind: "reply" as const, content: JSON.stringify({ decision, rationale, concerns }) };
}

const PROFILE: ProjectProfile = {
  projectPath: "/repo",
  alias: null,
  packageManager: "pnpm",
  framework: "vitest",
  checks: [{ name: "test", kind: "test", command: ["pnpm", "test"], mandatory: true }],
  manifestHashes: {},
  scriptsHash: "a".repeat(64),
  discoveredAt: NOW,
};
