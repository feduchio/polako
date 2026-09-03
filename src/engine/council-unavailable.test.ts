import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderError, type CompletionResponse } from "../broker/types.js";
import { defaultConfig } from "../domain/config.js";
import type { BaselineSnapshot } from "../domain/checks.js";
import { createMission } from "../domain/mission.js";
import type { ProjectProfile } from "../project/profile.js";
import type { CouncilCompletionClient } from "../council/types.js";
import { createResilientCouncilClient } from "../council/fallback.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { Scheduler } from "../scheduler/index.js";
import { stubDriverFor } from "./stubs.js";
import { RunEngine } from "./engine.js";
import { createInterpretingMissionDriver } from "./councilDrivers.js";

const NOW = 1_700_000_000_000;
const APPROVE = JSON.stringify({
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

describe("council availability control", () => {
  let dir: string;
  let store: Store;
  let clock: FakeClock;
  let engine: RunEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polish-council-unavail-"));
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

  it("pauses a run when all judge fallbacks are operationally unavailable", async () => {
    const failing: CouncilCompletionClient = {
      complete: async () => {
        throw new ProviderError("openrouter", "rate_limit", "429", { status: 429 });
      },
    };
    const ok = succeedingClient();
    engine.registerPhase(
      "INTERPRETING_MISSION",
      createInterpretingMissionDriver({
        roles: {
          planner: { client: ok, model: { provider: "scripted", model: "planner" } },
          scope_guardian: { client: ok, model: { provider: "scripted", model: "scope" } },
          judge: {
            client: createResilientCouncilClient({
              inner: failing,
              models: [
                { provider: "openrouter", model: "glm" },
                { provider: "gemini", model: "flash" },
              ],
              role: "judge",
              clock,
              retry: { maxAttemptsPerModel: 1, baseBackoffMs: 0, maxBackoffMs: 0 },
              eventSink: { append: (events) => store.events.append([...events]) },
            }),
            model: { provider: "openrouter", model: "glm" },
          },
        },
        resolveProfile: () => PROFILE,
      }),
    );
    const { runId } = seedRun(store, clock);
    await engine.tickRun(runId);
    const run = store.repos.runs.get(runId)!;
    expect(run.control).toBe("PAUSED");
    expect(run.phase).toBe("INTERPRETING_MISSION");
    expect(store.events.list(runId, { types: ["council.unavailable"] }).length).toBeGreaterThanOrEqual(1);
  });

  it("completes interpretation after the preferred judge 429 and a fallback success", async () => {
    const calls: string[] = [];
    const inner: CouncilCompletionClient = {
      async complete(request) {
        calls.push(request.model.model);
        if (request.model.model === "glm") throw new ProviderError("openrouter", "rate_limit", "429", { status: 429 });
        return reply(APPROVE);
      },
    };
    engine.registerPhase(
      "INTERPRETING_MISSION",
      createInterpretingMissionDriver({
        roles: {
          planner: { client: inner, model: { provider: "scripted", model: "planner" } },
          scope_guardian: { client: inner, model: { provider: "scripted", model: "scope" } },
          judge: {
            client: createResilientCouncilClient({
              inner,
              models: [
                { provider: "openrouter", model: "glm" },
                { provider: "gemini", model: "flash" },
              ],
              role: "judge",
              clock,
              retry: { maxAttemptsPerModel: 1, baseBackoffMs: 0, maxBackoffMs: 0 },
              eventSink: { append: (events) => store.events.append([...events]) },
            }),
            model: { provider: "openrouter", model: "glm" },
          },
        },
        resolveProfile: () => PROFILE,
      }),
    );
    const { runId } = seedRun(store, clock);
    await engine.tickRun(runId);
    const run = store.repos.runs.get(runId)!;
    expect(run.control).toBe("RUNNING");
    expect(run.phase).toBe("DISCOVERING_MODELS");
    expect(calls).toContain("glm");
    expect(calls).toContain("flash");
    expect(store.events.list(runId, { types: ["model.fallback_selected"] }).length).toBeGreaterThanOrEqual(1);
  });
});

function succeedingClient(): CouncilCompletionClient {
  return {
    complete: async () => reply(APPROVE),
  };
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

