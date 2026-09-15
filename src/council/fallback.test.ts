import { describe, expect, it } from "vitest";
import { ProviderError } from "../broker/types.js";
import type { CompletionRequest, CompletionResponse } from "../broker/types.js";
import { SupervisorCouncil } from "./council.js";
import { createResilientCouncilClient } from "./fallback.js";
import { isOperationalFailure, isCouncilFallbackWorthy } from "./operational.js";
import type { CouncilCompletionClient, CouncilEventSink } from "./types.js";
import type { BaselineSnapshot } from "../domain/checks.js";
import { createMission } from "../domain/mission.js";
import type { NewEvent } from "../domain/event.js";
import type { ProjectProfile } from "../project/profile.js";
import { PolishError } from "../shared/errors.js";
import { systemClock } from "../shared/clock.js";

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

describe("council operational fallback", () => {
  // R1 AC4. A spent account allowance is not a reason to try the account's next model, and is not
  // a reason to skip a different provider: this is the shape that completed the judge role in
  // `run_01m2h3hpe2f6f4ra1ywcg7`, which 429'd on OpenRouter and answered on Gemini.
  it("skips the rest of a provider's chain on an account-scoped 429, but not another provider", async () => {
    const calls: string[] = [];
    const inner: CouncilCompletionClient = {
      complete(request) {
        calls.push(`${request.model.provider}:${request.model.model}`);
        if (request.model.provider === "openrouter") {
          throw new ProviderError("openrouter", "rate_limit", "429", { status: 429, limitScope: "account" });
        }
        return Promise.resolve(reply(APPROVE));
      },
    };
    const client = createResilientCouncilClient({
      inner,
      models: [
        { provider: "openrouter", model: "first" },
        { provider: "openrouter", model: "second" },
        { provider: "gemini", model: "flash" },
      ],
      role: "judge",
      clock: systemClock,
      retry: { maxAttemptsPerModel: 1, baseBackoffMs: 0, maxBackoffMs: 0 },
    });

    await client.complete(requestFor("first"));
    expect(calls).toEqual(["openrouter:first", "gemini:flash"]);
  });

  it("still walks the whole chain when the limit belongs to the model", async () => {
    const calls: string[] = [];
    const inner: CouncilCompletionClient = {
      complete(request) {
        calls.push(`${request.model.provider}:${request.model.model}`);
        if (request.model.provider === "openrouter") {
          throw new ProviderError("openrouter", "rate_limit", "429", { status: 429, limitScope: "model" });
        }
        return Promise.resolve(reply(APPROVE));
      },
    };
    const client = createResilientCouncilClient({
      inner,
      models: [
        { provider: "openrouter", model: "first" },
        { provider: "openrouter", model: "second" },
        { provider: "gemini", model: "flash" },
      ],
      role: "judge",
      clock: systemClock,
      retry: { maxAttemptsPerModel: 1, baseBackoffMs: 0, maxBackoffMs: 0 },
    });

    await client.complete(requestFor("first"));
    expect(calls).toEqual(["openrouter:first", "openrouter:second", "gemini:flash"]);
  });

  it("falls back after a preferred judge 429 and completes interpretation", async () => {
    const calls: string[] = [];
    const events: NewEvent[] = [];
    const sink: CouncilEventSink = {
      append(batch) {
        events.push(...batch);
        return batch.map((event, index) => ({ ...event, seq: events.length - batch.length + index, schemaVersion: 1 }));
      },
    };
    const inner: CouncilCompletionClient = {
      async complete(request) {
        calls.push(`${request.model.provider}:${request.model.model}`);
        if (request.model.model === "glm") {
          throw new ProviderError("openrouter", "rate_limit", "429", { status: 429 });
        }
        return reply(APPROVE);
      },
    };
    const judge = createResilientCouncilClient({
      inner,
      models: [
        { provider: "openrouter", model: "glm" },
        { provider: "gemini", model: "flash" },
      ],
      role: "judge",
      clock: systemClock,
      retry: { maxAttemptsPerModel: 1, baseBackoffMs: 0, maxBackoffMs: 0 },
      eventSink: sink,
    });
    const council = new SupervisorCouncil({
      roles: {
        planner: { client: inner, model: { provider: "scripted", model: "planner" } },
        scope_guardian: { client: inner, model: { provider: "scripted", model: "scope" } },
        judge: { client: judge, model: { provider: "openrouter", model: "glm" } },
      },
      now: () => 10,
    });
    const result = await council.intake(MISSION, PROFILE, BASELINE);
    expect(result.status).toBe("READY");
    expect(calls).toContain("openrouter:glm");
    expect(calls).toContain("gemini:flash");
    expect(events.some((event) => event.type === "model.fallback_selected")).toBe(true);
  });

  it("does not fall back after a successful semantic judge response", async () => {
    const calls: string[] = [];
    const inner: CouncilCompletionClient = {
      async complete(request) {
        calls.push(request.model.model);
        return reply(APPROVE);
      },
    };
    const judge = createResilientCouncilClient({
      inner,
      models: [
        { provider: "openrouter", model: "glm" },
        { provider: "gemini", model: "flash" },
      ],
      role: "judge",
      clock: systemClock,
      retry: { maxAttemptsPerModel: 1, baseBackoffMs: 0, maxBackoffMs: 0 },
    });
    await judge.complete(requestFor("glm"));
    expect(calls).toEqual(["glm"]);
  });

  it("throws PROVIDERS_UNAVAILABLE when every authorised judge model fails operationally", async () => {
    const inner: CouncilCompletionClient = {
      async complete() {
        throw new ProviderError("openrouter", "rate_limit", "429", { status: 429 });
      },
    };
    const judge = createResilientCouncilClient({
      inner,
      models: [
        { provider: "openrouter", model: "glm" },
        { provider: "gemini", model: "flash" },
      ],
      role: "judge",
      clock: systemClock,
      retry: { maxAttemptsPerModel: 1, baseBackoffMs: 0, maxBackoffMs: 0 },
    });
    await expect(judge.complete(requestFor("glm"))).rejects.toMatchObject({ code: "PROVIDERS_UNAVAILABLE" });
  });

  it("keeps a successful sibling role in history when another role fails", async () => {
    const seen: string[] = [];
    const planner: CouncilCompletionClient = {
      async complete() {
        seen.push("planner");
        return reply(APPROVE);
      },
    };
    const scope: CouncilCompletionClient = {
      async complete() {
        seen.push("scope");
        return reply(APPROVE);
      },
    };
    const judge: CouncilCompletionClient = {
      async complete() {
        seen.push("judge");
        throw new ProviderError("openrouter", "rate_limit", "429", { status: 429 });
      },
    };
    const council = new SupervisorCouncil({
      roles: {
        planner: { client: planner, model: { provider: "scripted", model: "planner" } },
        scope_guardian: { client: scope, model: { provider: "scripted", model: "scope" } },
        judge: { client: judge, model: { provider: "openrouter", model: "glm" } },
      },
      now: () => 10,
    });
    await expect(council.intake(MISSION, PROFILE, BASELINE)).rejects.toBeInstanceOf(PolishError);
    expect(seen.sort()).toEqual(["judge", "planner", "scope"]);
  });

  it("treats output-contract failure as fallback-worthy, not semantic", () => {
    expect(isCouncilFallbackWorthy(new PolishError("OUTPUT_CONTRACT", "schema"))).toBe(true);
    expect(isOperationalFailure(new PolishError("OUTPUT_CONTRACT", "schema"))).toBe(false);
  });

  it("treats bad_request as semantic, not fallback-worthy", () => {
    expect(isOperationalFailure(new ProviderError("p", "bad_request", "nope"))).toBe(false);
    expect(isOperationalFailure(new ProviderError("p", "rate_limit", "429"))).toBe(true);
  });
});

function requestFor(model: string): CompletionRequest {
  return {
    model: { provider: "openrouter", model },
    messages: [{ role: "user", content: "x" }],
    metadata: { runId: "run_0000000000000000000000", purpose: "council_intake_judge", role: "judge" },
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
