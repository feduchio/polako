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

  /**
   * R4. D1 decomposed twice — `run_01m2gy5yg30631j247sn13` holds two `decompose APPROVED`
   * decisions and ten tasks with five distinct titles, the second set landing after the run had
   * already left for EXECUTING. The guard was a read, and `council.decompose` is an await.
   */
  describe("decomposition happens once", () => {
    const planningDriver = () => createPlanningDriver({ roles: councilRoles(provider) });

    it("creates one set of tasks when two drivers race on the same run", async () => {
      const { runId } = seedRun(store, clock);
      await engine.tickRun(runId);
      await engine.tickRun(runId);

      // Both start while the task list is empty, which is the window the claim closes.
      const run = store.repos.runs.get(runId)!;
      const ctx = { run, store, scheduler: sched, clock, config: defaultConfig() };
      const [first, second] = await Promise.all([planningDriver()(ctx), planningDriver()(ctx)]);

      const created = store.events.list(runId, { types: ["task.created"] });
      expect(created.length).toBeGreaterThanOrEqual(1);
      expect(store.repos.tasks.listByRun(runId)).toHaveLength(created.length);
      // One of the two produced the tasks; the other did not append a second set.
      expect([first.status, second.status]).toContain("complete");
      const decompositions = store.events
        .list(runId, { types: ["supervisor.decision"] })
        .filter((event) => event.payload["stage"] === "decompose" && event.payload["decision"] === "APPROVED");
      expect(decompositions.length).toBeLessThanOrEqual(1);
    });

    // One set of tasks, whichever driver produced it, and at most one discard. The earlier version
    // of this test seeded the tasks first, so the entry guard returned before either the decompose
    // or the post-await re-read ran, and it passed against the unfixed code.
    it("leaves one set of tasks behind, with distinct titles", async () => {
      const { runId } = seedRun(store, clock);
      await engine.tickRun(runId);
      await engine.tickRun(runId);
      const run = { ...store.repos.runs.get(runId)!, phase: "PLANNING" as const };


      await planningDriver()({ run, store, scheduler: sched, clock, config: defaultConfig() });
      const tasks = store.repos.tasks.listByRun(runId);
      const discarded = store.events.list(runId, { types: ["planning.decompose_discarded"] });
      // Exactly one set of tasks, whichever driver produced it.
      expect(new Set(tasks.map((task) => task.title)).size).toBe(tasks.length);
      expect(discarded.length).toBeLessThanOrEqual(1);
    });

    // A claim whose owner died is a claim nobody can release, and PLANNING would return `waiting`
    // forever with no event ever changing. So it is a lease.
    it("expires a claim whose owner never produced tasks", async () => {
      const { runId } = seedRun(store, clock);
      await engine.tickRun(runId);
      await engine.tickRun(runId);
      const interpretationId = store.repos.runs.get(runId)!.interpretationId!;
      store.events.append([{
        id: id("evt", clock.now()),
        runId,
        ts: clock.now(),
        type: "planning.decompose_claimed",
        payload: { interpretationId },
        causedBy: [],
        actor: { kind: "system" },
        artifacts: [],
      }]);

      const held = { ...store.repos.runs.get(runId)!, phase: "PLANNING" as const };
      const waiting = await planningDriver()({ run: held, store, scheduler: sched, clock, config: defaultConfig() });
      expect(waiting.status).toBe("waiting");

      await clock.advance(11 * 60_000);
      await planningDriver()({ run: held, store, scheduler: sched, clock, config: defaultConfig() });
      expect(store.repos.tasks.listByRun(runId).length).toBeGreaterThanOrEqual(1);
      const released = store.events.list(runId, { types: ["planning.decompose_released"] });
      expect(released.some((event) => String(event.payload["reason"]).includes("expired"))).toBe(true);
    });

    // A lock nobody can release is a run that waits forever: an answered NEEDS_HUMAN re-enters
    // PLANNING with the task list still empty.
    it("releases the claim when the decomposition produced no tasks", async () => {
      provider = scriptedCouncilProvider(false, { dropAll: true });
      engine.registerPhase("INTERPRETING_MISSION", createInterpretingMissionDriver({ roles: councilRoles(provider), resolveProfile: () => PROFILE }));
      engine.registerPhase("PLANNING", planningDriver());
      const { runId } = seedRun(store, clock);
      await engine.tickRun(runId);
      await engine.tickRun(runId);
      await engine.tickRun(runId);

      expect(store.repos.runs.get(runId)?.phase).toBe("NEEDS_HUMAN");
      const claims = store.events.list(runId, { types: ["planning.decompose_claimed"] });
      const releases = store.events.list(runId, { types: ["planning.decompose_released"] });
      expect(claims).toHaveLength(1);
      expect(releases).toHaveLength(1);
      expect(releases[0]?.payload["reason"]).toContain("human");
    });
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
    const reports = store.events.list(runId, { types: ["report.generated"] });
    expect(reports).toHaveLength(1);
    expect(store.artifacts.getText(reports[0]!.artifacts[0]!.sha256)).toContain("Which API should remain compatible?");
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
    const reports = store.events.list(runId, { types: ["report.generated"] });
    expect(reports.length).toBeGreaterThanOrEqual(1);
    expect(store.artifacts.getText(reports.at(-1)!.artifacts[0]!.sha256)).toContain("ACTION REQUIRED:");
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
