import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CompletionRequest, CompletionResponse } from "../broker/types.js";
import type { NewEvent } from "../domain/event.js";
import { createMission } from "../domain/mission.js";
import type { BaselineSnapshot } from "../domain/checks.js";
import type { ProjectProfile } from "../project/profile.js";
import { FakeClock } from "../shared/clock.js";
import { SupervisorCouncil } from "./council.js";
import { createResilientCouncilClient } from "./fallback.js";
import { PLANNER_INTAKE_SCHEMA, validatePlannerIntakeProposal } from "./interpretationSchema.js";
import { createStructuredCouncilClient } from "./structuredOutput.js";
import type { CouncilCompletionClient, CouncilEventSink } from "./types.js";

const NOW = 1_700_000_000_000;
const SMOKE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/council/gemini-planner-smoke-intake.json"), "utf8"),
) as { proposal: unknown; decision: string };

const VALID = JSON.stringify({
  decision: "approve",
  rationale: "Requirements are concrete.",
  concerns: [],
  proposal: {
    goals: ["Fix login"],
    requirements: [{ ref: "R1", statement: "Fix login timeout", acceptance: ["Login succeeds within 2s"] }],
    constraints: [],
    nonGoals: [],
    definitionOfSuccess: ["Checks pass"],
    ambiguities: [],
  },
});

describe("planner intake schema contract", () => {
  it("E: captured smoke shape fails RequirementSchema on $.requirements[0]", () => {
    const result = validatePlannerIntakeProposal(SMOKE.proposal);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toMatch(/^\$\.requirements\[0\]/);
    expect(result.issues[0]?.message).toMatch(/object/i);
    expect(PLANNER_INTAKE_SCHEMA.name).toBe("MissionInterpretation.requirements");
  });

  it("A: malformed planner JSON is repaired once and creates a MissionInterpretation", async () => {
    const events: NewEvent[] = [];
    let plannerCalls = 0;
    const inner = countingClient((request) => {
      if (request.metadata.role !== "planner") return VALID;
      plannerCalls += 1;
      return plannerCalls === 1 ? JSON.stringify(envelope(SMOKE)) : VALID;
    });
    const planner = createStructuredCouncilClient({
      inner,
      role: "planner",
      clock: new FakeClock(NOW),
      eventSink: sink(events),
    });
    const council = new SupervisorCouncil({
      roles: {
        planner: { client: planner, model: { provider: "gemini", model: "flash" } },
        scope_guardian: { client: inner, model: { provider: "scripted", model: "scope" } },
        judge: { client: inner, model: { provider: "scripted", model: "judge" } },
      },
      now: () => NOW,
    });
    const result = await council.intake(MISSION, PROFILE, BASELINE);
    expect(result.status).toBe("READY");
    if (result.status !== "READY") return;
    expect(result.interpretation.requirements[0]?.ref).toBe("R1");
    expect(plannerCalls).toBe(2);
    expect(events.some((event) => event.type === "model.output_invalid")).toBe(true);
    expect(events.some((event) => event.type === "model.output_repair_attempted")).toBe(true);
    expect(events.find((event) => event.type === "model.output_invalid")?.payload["summary"]).toMatch(/requirements/);
  });

  it("B: primary planner schema-invalid then fallback planner valid proceeds", async () => {
    const events: NewEvent[] = [];
    const calls: string[] = [];
    const inner = countingClient((request) => {
      if (request.metadata.role !== "planner") return VALID;
      calls.push(request.model.model);
      if (request.model.model === "glm") return JSON.stringify(envelope(SMOKE));
      return VALID;
    });
    const planner = createResilientCouncilClient({
      inner: createStructuredCouncilClient({
        inner,
        role: "planner",
        clock: new FakeClock(NOW),
        eventSink: sink(events),
      }),
      models: [
        { provider: "openrouter", model: "glm" },
        { provider: "openrouter", model: "minimax-m3" },
      ],
      role: "planner",
      clock: new FakeClock(NOW),
      retry: { maxAttemptsPerModel: 1, baseBackoffMs: 0, maxBackoffMs: 0 },
      eventSink: sink(events),
    });
    const council = new SupervisorCouncil({
      roles: {
        planner: { client: planner, model: { provider: "openrouter", model: "glm" } },
        scope_guardian: { client: inner, model: { provider: "scripted", model: "scope" } },
        judge: { client: inner, model: { provider: "scripted", model: "judge" } },
      },
      now: () => NOW,
    });
    const result = await council.intake(MISSION, PROFILE, BASELINE);
    expect(result.status).toBe("READY");
    expect(calls.filter((model) => model === "glm").length).toBeGreaterThanOrEqual(2);
    expect(calls).toContain("minimax-m3");
    expect(events.some((event) => event.type === "model.fallback_selected")).toBe(true);
    expect(events.some((event) => event.type === "model.output_repair_attempted")).toBe(true);
  });

  it("C: every planner model schema-invalid throws OUTPUT_CONTRACT, not NEEDS_HUMAN", async () => {
    const inner = countingClient(() => JSON.stringify(envelope(SMOKE)));
    const planner = createResilientCouncilClient({
      inner: createStructuredCouncilClient({
        inner,
        role: "planner",
        clock: new FakeClock(NOW),
      }),
      models: [
        { provider: "openrouter", model: "glm" },
        { provider: "gemini", model: "flash" },
      ],
      role: "planner",
      clock: new FakeClock(NOW),
      retry: { maxAttemptsPerModel: 1, baseBackoffMs: 0, maxBackoffMs: 0 },
    });
    const council = new SupervisorCouncil({
      roles: {
        planner: { client: planner, model: { provider: "openrouter", model: "glm" } },
        scope_guardian: { client: countingClient(() => VALID), model: { provider: "scripted", model: "scope" } },
        judge: { client: countingClient(() => VALID), model: { provider: "scripted", model: "judge" } },
      },
      now: () => NOW,
    });
    await expect(council.intake(MISSION, PROFILE, BASELINE)).rejects.toMatchObject({ code: "OUTPUT_CONTRACT" });
  });
});

function envelope(smoke: { proposal: unknown; decision: string }): Record<string, unknown> {
  return {
    decision: smoke.decision,
    rationale: "The mission is well-defined and bounded.",
    concerns: [],
    proposal: smoke.proposal,
  };
}

function countingClient(content: (request: CompletionRequest) => string): CouncilCompletionClient {
  return {
    async complete(request) {
      return reply(content(request));
    },
  };
}

function sink(events: NewEvent[]): CouncilEventSink {
  return {
    append(batch) {
      events.push(...batch);
      return batch.map((event, index) => ({ ...event, seq: events.length - batch.length + index, schemaVersion: 1 as const }));
    },
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

const MISSION = createMission({
  id: "msn_0000000000000000000000",
  projectPath: "/repo",
  text: "Fix the login timeout bug",
  createdAt: 1,
});

const PROFILE: ProjectProfile = {
  projectPath: "/repo",
  alias: null,
  packageManager: "pnpm",
  framework: "vitest",
  checks: [{ name: "test", kind: "test", command: ["pnpm", "test"], mandatory: true }],
  manifestHashes: {},
  scriptsHash: "a".repeat(64),
  discoveredAt: 1,
};

const BASELINE: BaselineSnapshot = {
  id: "base_0000000000000000000000",
  runId: "run_0000000000000000000000",
  commitHash: "abcdef1",
  checks: [],
  configHashes: {},
  scriptsHash: "a".repeat(64),
  toolchain: {},
  createdAt: 1,
};
