import { describe, expect, it } from "vitest";
import type { CompletionRequest, CompletionResponse } from "../broker/types.js";
import { createResilientCouncilClient } from "./fallback.js";
import { Judge, createOpinionCheckingClient } from "./roles.js";
import type { CouncilCompletionClient } from "./types.js";
import { systemClock } from "../shared/clock.js";

const OPINION = JSON.stringify({ decision: "approve", rationale: "bounded", concerns: [], proposal: {} });

// run_01m3dm5jg4wfhtw70rgmqa: the intake judge answered with a worker's action plan, the opinion
// was only parsed after the chain had returned, and the run paused with a second model unasked.
const ACTION_PLAN = JSON.stringify({
  title: "Inspect repo and failing test",
  steps: [{ type: "read_file", path: "src/add.mjs", reason: "Read add source" }],
});

describe("council opinion contract inside the model chain", () => {
  it("falls back to the next model when one answers with something other than an opinion", async () => {
    const calls: string[] = [];
    const broker: CouncilCompletionClient = {
      complete(request) {
        calls.push(request.model.model);
        return Promise.resolve(reply(request.model.model === "first" ? ACTION_PLAN : OPINION));
      },
    };
    const models = [
      { provider: "openrouter", model: "first" },
      { provider: "gemini", model: "second" },
    ];
    const client = createResilientCouncilClient({
      inner: createOpinionCheckingClient(broker, "judge"),
      models,
      role: "judge",
      clock: systemClock,
      retry: { maxAttemptsPerModel: 1, baseBackoffMs: 0, maxBackoffMs: 0 },
    });
    const judge = new Judge({ client, model: models[0]!, models });

    const result = await judge.analyze({ runId: "run_0000000000000000000000", purpose: "council_intake_judge", payload: {} });

    expect(calls).toEqual(["first", "second"]);
    expect(result.opinion.decision).toBe("approve");
  });

  it("is OUTPUT_CONTRACT when every model answers with something other than an opinion", async () => {
    const client = createOpinionCheckingClient({ complete: () => Promise.resolve(reply(ACTION_PLAN)) }, "judge");

    await expect(client.complete(request())).rejects.toMatchObject({ code: "OUTPUT_CONTRACT" });
  });
});

function request(): CompletionRequest {
  return {
    model: { provider: "openrouter", model: "first" },
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
