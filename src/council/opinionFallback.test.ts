import { describe, expect, it } from "vitest";
import type { CompletionRequest, CompletionResponse } from "../broker/types.js";
import { createResilientCouncilClient } from "./fallback.js";
import { Judge, createRoleContractClient } from "./roles.js";
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
      inner: createRoleContractClient(broker, "judge"),
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
    const client = createRoleContractClient({ complete: () => Promise.resolve(reply(ACTION_PLAN)) }, "judge");

    await expect(client.complete(request())).rejects.toMatchObject({ code: "OUTPUT_CONTRACT" });
  });

  // run_01m3dm6eaz7evkv4wp3t16: the decompose planner's single task carried no requirementRef and
  // the council threw INVARIANT_VIOLATION after the chain had already returned.
  it("rejects decompose tasks that do not name the requirement they deliver, and accepts ones that do", async () => {
    const decompose = (task: Record<string, unknown>) =>
      JSON.stringify({ decision: "approve", rationale: "ok", concerns: [], proposal: { tasks: [task] } });
    const task = { title: "Add args tests", acceptance: ["tests exist"], dependsOn: [] };
    const planner = (content: string) => createRoleContractClient({ complete: () => Promise.resolve(reply(content)) }, "planner");

    await expect(planner(decompose(task)).complete(request("council_decompose_planner"))).rejects.toMatchObject({
      code: "OUTPUT_CONTRACT",
      details: { issues: [{ path: "$.proposal.tasks[0].requirementRef" }] },
    });
    await expect(planner(decompose({ ...task, requirementRef: "R1" })).complete(request("council_decompose_planner"))).resolves.toBeDefined();
    await expect(planner(decompose(task)).complete(request("council_split_planner"))).resolves.toBeDefined();
  });
});

function request(purpose = "council_intake_judge"): CompletionRequest {
  return {
    model: { provider: "openrouter", model: "first" },
    messages: [{ role: "user", content: "x" }],
    metadata: { runId: "run_0000000000000000000000", purpose, role: "judge" },
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
