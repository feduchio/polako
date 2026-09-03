import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompletionResponse } from "../broker/types.js";
import type { NewEvent } from "../domain/event.js";
import { defaultConfig } from "../domain/config.js";
import type { BaselineSnapshot } from "../domain/checks.js";
import { createMission } from "../domain/mission.js";
import type { ProjectProfile } from "../project/profile.js";
import type { CouncilCompletionClient } from "../council/types.js";
import { createResilientCouncilClient } from "../council/fallback.js";
import { createStructuredCouncilClient } from "../council/structuredOutput.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { Scheduler } from "../scheduler/index.js";
import { stubDriverFor } from "./stubs.js";
import { RunEngine } from "./engine.js";
import { createInterpretingMissionDriver } from "./councilDrivers.js";

const NOW = 1_700_000_000_000;
const SMOKE = JSON.stringify({
  decision: "approve",
  rationale: "The mission is well-defined and bounded.",
  concerns: [],
  proposal: {
    goals: ["Fix retry handling"],
    requirements: ["Do not add new dependencies to package.json."],
    acceptanceCriteria: ["npm run test passes with exit code 0."],
  },
});
const VALID = JSON.stringify({
  decision: "approve",
  rationale: "ok",
  concerns: [],
  proposal: {
    goals: ["Fix login"],
    requirements: [{ ref: "R1", statement: "Fix login timeout", acceptance: ["Login works"] }],
    constraints: [],
    nonGoals: [],
    definitionOfSuccess: ["Checks pass"],
    ambiguities: [],
  },
});

describe("planner intake schema through INTERPRETING_MISSION", () => {
  let dir: string;
  let store: Store;
  let clock: FakeClock;
  let engine: RunEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polish-planner-schema-"));
    store = openStore({ artifactsDir: join(dir, "artifacts") });
    clock = new FakeClock(NOW);
    const sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 60_000 });
    engine = new RunEngine({ store, clock, scheduler: sched, config: defaultConfig(), assertProjectClean: () => undefined }, false);
    for (const phase of [
      "CREATED",
      "DISCOVERING_PROJECT",
      "BASELINING",
      "DISCOVERING_MODELS",
      "PLANNING",
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
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("A: repair succeeds and the run leaves INTERPRETING_MISSION", async () => {
    let plannerCalls = 0;
    const inner: CouncilCompletionClient = {
      async complete(request) {
        if (request.metadata.role !== "planner") return reply(VALID);
        plannerCalls += 1;
        return reply(plannerCalls === 1 ? SMOKE : VALID);
      },
    };
    const sink = { append: (events: readonly NewEvent[]) => store.events.append([...events]) };
    engine.registerPhase(
      "INTERPRETING_MISSION",
      createInterpretingMissionDriver({
        roles: {
          planner: {
            client: createStructuredCouncilClient({ inner, role: "planner", clock, eventSink: sink }),
            model: { provider: "gemini", model: "flash" },
          },
          scope_guardian: { client: inner, model: { provider: "scripted", model: "scope" } },
          judge: { client: inner, model: { provider: "scripted", model: "judge" } },
        },
        resolveProfile: () => PROFILE,
      }),
    );
    const { runId } = seedRun(store, clock);
    await engine.tickRun(runId);
    const run = store.repos.runs.get(runId)!;
    expect(run.phase).toBe("DISCOVERING_MODELS");
    expect(run.interpretationId).not.toBeNull();
    expect(store.events.list(runId, { types: ["mission.interpreted"] })).toHaveLength(1);
    expect(store.events.list(runId, { types: ["model.output_invalid"] }).length).toBeGreaterThanOrEqual(1);
    expect(store.events.list(runId, { types: ["model.output_repair_attempted"] }).length).toBeGreaterThanOrEqual(1);
  });

  it("C: all planner models invalid pauses as output-contract, not NEEDS_HUMAN", async () => {
    const inner: CouncilCompletionClient = {
      async complete() {
        return reply(SMOKE);
      },
    };
    const sink = { append: (events: readonly NewEvent[]) => store.events.append([...events]) };
    engine.registerPhase(
      "INTERPRETING_MISSION",
      createInterpretingMissionDriver({
        roles: {
          planner: {
            client: createResilientCouncilClient({
              inner: createStructuredCouncilClient({ inner, role: "planner", clock, eventSink: sink }),
              models: [
                { provider: "openrouter", model: "glm" },
                { provider: "gemini", model: "flash" },
              ],
              role: "planner",
              clock,
              retry: { maxAttemptsPerModel: 1, baseBackoffMs: 0, maxBackoffMs: 0 },
              eventSink: sink,
            }),
            model: { provider: "openrouter", model: "glm" },
          },
          scope_guardian: { client: succeedingClient(), model: { provider: "scripted", model: "scope" } },
          judge: { client: succeedingClient(), model: { provider: "scripted", model: "judge" } },
        },
        resolveProfile: () => PROFILE,
      }),
    );
    const { runId } = seedRun(store, clock);
    await engine.tickRun(runId);
    const run = store.repos.runs.get(runId)!;
    expect(run.phase).toBe("INTERPRETING_MISSION");
    expect(run.control).toBe("PAUSED");
    expect(run.interpretationId).toBeNull();
    const unavailable = store.events.list(runId, { types: ["council.unavailable"] });
    expect(unavailable.length).toBeGreaterThanOrEqual(1);
    expect(unavailable[0]?.payload["kind"]).toBe("output_contract");
  });
});

function succeedingClient(): CouncilCompletionClient {
  return { complete: async () => reply(VALID) };
}

function reply(content: string): CompletionResponse {
  return {
    message: { role: "assistant", content },
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    finishReason: "stop",
    latencyMs: 1,
  };
}

function seedRun(store: Store, clock: FakeClock): { runId: string } {
  const missionId = id("msn", clock.now());
  const runId = id("run", clock.now());
  const mission = createMission({
    id: missionId,
    projectPath: "/repo",
    text: "Fix the login timeout bug",
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
  store.events.append([
    {
      id: id("evt", clock.now()),
      runId,
      ts: clock.now(),
      type: "run.created",
      payload: {
        run: {
          id: runId,
          missionId,
          projectPath: "/repo",
          runBranch: `polish/${runId}`,
          phase: "INTERPRETING_MISSION",
          control: "RUNNING",
          currentCheckpointHash: baseline.commitHash,
          baselineId: baseline.id,
          interpretationId: null,
          createdAt: clock.now(),
          updatedAt: clock.now(),
          terminalReason: null,
        },
      },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
    {
      id: id("evt", clock.now()),
      runId,
      ts: clock.now(),
      type: "mission.recorded",
      payload: { mission },
      causedBy: [],
      actor: { kind: "user" },
      artifacts: [],
    },
    {
      id: id("evt", clock.now()),
      runId,
      ts: clock.now(),
      type: "baseline.snapshotted",
      payload: { baseline },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    },
  ]);
  return { runId };
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
