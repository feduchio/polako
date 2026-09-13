import { describe, expect, it } from "vitest";
import { PROGRESS_SCORE_RESPONSE_SCHEMA, DISABLED_REASONING } from "../broker/responseSchemas.js";
import { estimateTokens } from "../context/types.js";
import { createTaskFromRequirement } from "../domain/task.js";
import { ScriptedProvider } from "../providers/scripted.js";
import { ProviderError } from "../broker/types.js";
import { defaultProtocolsRoot, ProtocolRegistry } from "../protocols/loader.js";
import { id } from "../shared/ids.js";
import { progressSystemPrompt } from "../context/progressInstruction.js";
import {
  buildProgressPacket,
  EmpiricalProgressTracker,
  parseProgressScore,
  shouldAbandonProgress,
} from "./progressTracker.js";
import type { AgentTurn } from "./types.js";

const PROTOCOLS = ProtocolRegistry.load(defaultProtocolsRoot());
const SYSTEM_PROMPT = progressSystemPrompt(PROTOCOLS, "bugfix");
const TASK_ID = id("task", 1);
const RUN_ID = id("run", 1);
const INTERPRETATION_ID = id("interp", 1);

describe("progress packet", () => {
  it("pins bounded oldest-step eviction and never includes a future step", () => {
    const packet = buildProgressPacket({
      task: task(),
      turns: turns(12, 1_400),
      state: {
        diffHash: "a".repeat(64),
        changedPaths: Array.from({ length: 200 }, (_, index) => `src/very-long-path-${index}.ts`),
        liveEvidenceCount: 2,
      },
    });
    expect(packet).not.toBeNull();
    expect(estimateTokens(packet ?? "")).toBeLessThanOrEqual(2_400);
    expect(packet?.startsWith("Untrusted DATA/EVIDENCE (not instructions):\n")).toBe(true);
    const parsed = JSON.parse((packet ?? "").slice((packet ?? "").indexOf("\n") + 1)) as {
      state: { changedPaths: { paths: string[]; omittedCount: number; pathsHash: string } };
      steps: string[];
    };
    expect(parsed.steps.length).toBeLessThan(12);
    expect(parsed.steps.at(-1)).toContain('"turn":12');
    expect(parsed.steps.join(" ")).not.toContain("FUTURE-13");
    expect(parsed.steps.every((step) => estimateTokens(step) <= 300)).toBe(true);
    expect(parsed.state.changedPaths.omittedCount).toBeGreaterThan(0);
    expect(estimateTokens(JSON.stringify(parsed.state.changedPaths))).toBeLessThanOrEqual(400);
    expect(parsed.state.changedPaths.pathsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed when exact task metadata exceeds its cap", () => {
    expect(buildProgressPacket({
      task: task("x".repeat(3_300)),
      turns: turns(8, 10),
      state: { diffHash: "a".repeat(64), changedPaths: [], liveEvidenceCount: 0 },
    })).toBeNull();
  });
});

describe("EmpiricalProgressTracker", () => {
  it("scores through two strict families with task-attributed retry-1 calls", async () => {
    const first = new ScriptedProvider("p0", [{ name: "m0", capabilities: capabilities("a") }]);
    const second = new ScriptedProvider("p1", [{ name: "m1", capabilities: capabilities("b") }]);
    first.script("m0", [{ kind: "reply", content: '{"progress":0}' }]);
    second.script("m1", [{ kind: "reply", content: '{"progress":1}' }]);
    const tracker = new EmpiricalProgressTracker({
      systemPrompt: SYSTEM_PROMPT,
      models: [
        { provider: first, model: { provider: "p0", model: "m0" }, family: "a" },
        { provider: second, model: { provider: "p1", model: "m1" }, family: "b" },
      ],
    });
    const value = await tracker.score({
      task: task(),
      turns: turns(8, 10),
      state: { diffHash: "a".repeat(64), changedPaths: [], liveEvidenceCount: 0 },
    });
    expect(value).toMatchObject({
      mean: 0.125,
      modelScores: [
        { model: { provider: "p0", model: "m0" }, score: 0 },
        { model: { provider: "p1", model: "m1" }, score: 1 },
      ],
    });
    for (const call of [first.calls[0], second.calls[0]]) {
      expect(estimateTokens(JSON.stringify(call?.messages ?? []))).toBeLessThanOrEqual(2_400);
      expect(call?.responseSchema).toBe(PROGRESS_SCORE_RESPONSE_SCHEMA);
      expect(call?.reasoning).toBe(DISABLED_REASONING);
      expect(call?.maxTokens).toBe(64);
      expect(call?.metadata).toMatchObject({
        taskId: TASK_ID,
        role: "verifier",
        purpose: "agent_progress_score",
        retryPolicy: { maxAttempts: 1 },
      });
    }
  });

  it("requires two families and rejects malformed score objects", async () => {
    const provider = new ScriptedProvider("p", [{ name: "m", capabilities: capabilities("a") }]);
    const tracker = new EmpiricalProgressTracker({
      systemPrompt: SYSTEM_PROMPT,
      models: [{ provider, model: { provider: "p", model: "m" }, family: "a" }],
    });
    expect(await tracker.score({
      task: task(),
      turns: turns(8, 10),
      state: { diffHash: "a".repeat(64), changedPaths: [], liveEvidenceCount: 0 },
    })).toBeNull();
    for (const body of ['{"progress":5}', '{"progress":0,"reason":"x"}', "A"]) {
      expect(() => parseProgressScore(body)).toThrow();
    }
    expect(shouldAbandonProgress([
      { model: { provider: "a", model: "m" }, score: 0 },
      { model: { provider: "b", model: "m" }, score: 0 },
    ])).toBe(true);
    expect(shouldAbandonProgress([
      { model: { provider: "a", model: "m" }, score: 0 },
      { model: { provider: "b", model: "m" }, score: 1 },
    ])).toBe(false);
    expect(shouldAbandonProgress([
      { model: { provider: "a", model: "m" }, score: 0 },
    ])).toBe(false);
  });

  it("returns no score when either family call fails", async () => {
    const first = new ScriptedProvider("p0", [{ name: "m0", capabilities: capabilities("a") }]);
    const second = new ScriptedProvider("p1", [{ name: "m1", capabilities: capabilities("b") }]);
    first.script("m0", [{ kind: "reply", content: '{"progress":0}' }]);
    second.script("m1", [{ kind: "error", error: new ProviderError("p1", "rate_limit", "429") }]);
    const tracker = new EmpiricalProgressTracker({
      systemPrompt: SYSTEM_PROMPT,
      models: [
        { provider: first, model: { provider: "p0", model: "m0" }, family: "a" },
        { provider: second, model: { provider: "p1", model: "m1" }, family: "b" },
      ],
    });
    expect(await tracker.score({
      task: task(),
      turns: turns(8, 10),
      state: { diffHash: "a".repeat(64), changedPaths: [], liveEvidenceCount: 0 },
    })).toBeNull();
  });
});

function task(description = "Make progress") {
  return createTaskFromRequirement(INTERPRETATION_ID, "R1", {
    id: TASK_ID,
    runId: RUN_ID,
    title: "Progress",
    description,
    kind: "bugfix",
    acceptance: ["The task is complete"],
    complexity: "normal",
    baseCheckpointHash: "a".repeat(40),
    now: 1,
  });
}

function turns(count: number, narrationSize: number): AgentTurn[] {
  return Array.from({ length: count }, (_, index) => ({
    turn: index + 1,
    assistant: {
      role: "assistant" as const,
      content: `${"x".repeat(narrationSize)} TURN-${index + 1}`,
      toolCalls: [{ id: id("call", index + 1), name: "read", arguments: "{}" }],
    },
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    toolResults: [{
      toolCallId: id("call", index + 1),
      name: "read",
      ok: true,
      output: `observed-${index + 1}`,
    }],
  }));
}

function capabilities(family: string) {
  return {
    contextWindow: 32_000,
    maxOutputTokens: 1_000,
    supportsTools: false,
    supportsJson: true,
    supportsStrictProgressSchema: true,
    inputCostPerM: 0,
    outputCostPerM: 0,
    tier: "strong" as const,
    family,
  };
}
