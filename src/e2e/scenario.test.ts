import { afterEach, describe, expect, it } from "vitest";
import { ProviderError } from "../broker/types.js";
import { reply } from "../providers/scripted.js";
import { Git } from "../sandbox/git.js";
import {
  FIXED_ADD,
  accountLimit,
  destroyScenario,
  drive,
  emptyReview,
  fixtureTestFails,
  loadTranscript,
  scriptPipeline,
  startScenario,
  toolSteps,
  workerTokens,
  type ScenarioEnv,
} from "./scenario.js";

let env: ScenarioEnv | undefined;

afterEach(async () => {
  await destroyScenario(env);
  env = undefined;
});

describe("run scenarios", () => {
  it("fixes deps-ts, and the worker worktree can run the test", async () => {
    env = await startScenario("deps-ts");
    expect(fixtureTestFails(env.repoDir)).toBe(true);
    scriptPipeline(env.provider, [
      ...toolSteps([
        { name: "write", arguments: { path: "src/add.mjs", content: FIXED_ADD } },
        { name: "finish", arguments: { summary: "add sums through pad" } },
      ]),
    ], emptyReview());
    const runId = await begin(env, "Make add return the sum of its arguments. Read src/add.mjs and src/label.mjs.");
    const { run, ticks } = await drive(env, runId, 80);
    expect(ticks).toBeLessThan(80);
    expect(run.phase).toBe("DONE");
    expect(run.terminalReason === null || run.terminalReason.code === "converged").toBe(true);
    expect(workerTokens(env, runId)).toBeLessThan(96_000);
    const mechanisms = env.service.store.events.list(runId, { types: ["run.mechanisms"] })[0]?.payload["mechanisms"];
    expect(mechanisms).toContainEqual({ name: "review_quorum", on: true, reason: "families: wkr,xrev" });
    const reviewed = env.service.store.repos.reviewExecutions.listByRun(runId).filter((execution) => execution.completed);
    expect(reviewed.length).toBeGreaterThan(0);
    expect(reviewed.every((execution) => execution.requestedModel.model === "xrev")).toBe(true);
    const review = env.provider.calls.find((call) => call.metadata.purpose.startsWith("review_") && call.metadata.runId === runId);
    const user = review?.messages.find((message) => message.role === "user")?.content ?? "";
    expect(user.startsWith("TRUSTED CONTEXT")).toBe(true);
    expect(user).toContain("The exported add function agrees with its test");
    const tree = await new Git(env.repoDir).out(["ls-tree", "-r", "--name-only", run.runBranch]);
    expect(tree.split("\n")).toContain("src/add.mjs");
    expect(tree).not.toMatch(/^node_modules\//m);
  });

  it("ends DONE with no_change_required when the engine's gates prove nothing needed changing", async () => {
    env = await startScenario("nothing-to-do");
    scriptPipeline(env.provider, toolSteps([
      { name: "run_command", arguments: { argv: ["npm", "run", "test"] } },
      { name: "finish", arguments: { summary: "the test already passes", noChange: { reason: "add already sums; npm test passes" } } },
    ]), emptyReview());
    const runId = await begin(env, "Leave the code unchanged. The tests already pass.");
    const { run, ticks } = await drive(env, runId, 80);
    expect(ticks).toBeLessThan(80);
    expect(run.phase).toBe("DONE");
    expect(run.terminalReason?.code).toBe("no_change_required");
    expect(run.currentCheckpointHash).toBe(env.service.store.repos.baselines.listByRun(runId)[0]?.commitHash);
    expect(env.service.store.repos.tasks.listByRun(runId).map((task) => task.state)).toEqual(["SATISFIED"]);
    const candidate = env.service.store.repos.candidates.listByRun(runId)[0];
    expect(candidate?.gateReport?.passed).toBe(true);
    expect(candidate?.error).toMatch(/^no_change_verified: /);
    expect(workerTokens(env, runId)).toBeLessThan(96_000);
  });

  it("does not call a no-change finish DONE when the unchanged code fails its checks", async () => {
    env = await startScenario("deps-ts");
    scriptPipeline(env.provider, toolSteps([
      { name: "run_command", arguments: { argv: ["npm", "ci"] } },
      { name: "finish", arguments: { summary: "looks fine", noChange: { reason: "add is correct" } } },
    ]), emptyReview());
    const runId = await begin(env, "Make add return the sum of its arguments.");
    const { run, ticks } = await drive(env, runId, 80);
    expect(ticks).toBeLessThan(80);
    expect(run.phase).not.toBe("DONE");
    expect(run.terminalReason).not.toBeNull();
    expect(env.service.store.repos.tasks.listByRun(runId).some((task) => task.state === "SATISFIED")).toBe(false);
    const refused = env.service.store.repos.candidates.listByRun(runId)[0];
    expect(refused?.gateReport?.failures[0]?.detail).toMatch(/claimed no change was needed, and checks do not pass on the unchanged base/);
  });

  it("stalls a replayed empty search before the budget is spent", async () => {
    env = await startScenario("deps-ts");
    scriptPipeline(env.provider, toolSteps(loadTranscript("hfb2-repeat.json")), emptyReview());
    const runId = await begin(env, "Find commit duration handling.");
    const { run, ticks } = await drive(env, runId, 80);
    expect(ticks).toBeLessThan(80);
    expect(run.phase).toBe("FAILED");
    expect(run.terminalReason?.code).toBe("no_candidate_finished");
    const errors = env.service.store.repos.candidates.listByRun(runId).map((candidate) => candidate.error);
    expect(errors).toContain("STALLED");
    expect(workerTokens(env, runId)).toBeLessThan(96_000);
  });

  it("keeps a replayed recursive listing under the token cap", async () => {
    env = await startScenario("deps-ts");
    scriptPipeline(env.provider, toolSteps(loadTranscript("jc02-list.json")), emptyReview());
    const runId = await begin(env, "List the repository.");
    const { ticks } = await drive(env, runId, 80);
    expect(ticks).toBeLessThan(80);
    expect(workerTokens(env, runId)).toBeLessThan(96_000);
    const listed = env.provider.calls
      .filter((call) => call.metadata.purpose === "agent_run")
      .flatMap((call) => call.messages)
      .map((message) => message.content)
      .join("\n");
    expect(listed).not.toContain("node_modules/");
    expect(env.service.store.events.list(runId, { types: ["run.mechanisms"] }).length).toBeGreaterThan(0);
  });

  it("ends a reviewer that only returns account 429 instead of spinning", async () => {
    env = await startScenario("deps-ts");
    scriptPipeline(
      env.provider,
      toolSteps([
        { name: "write", arguments: { path: "src/add.mjs", content: FIXED_ADD } },
        { name: "finish", arguments: { summary: "add sums" } },
      ]),
      accountLimit(new ProviderError("scripted", "rate_limit", "429", { status: 429, limitScope: "account" }), 30),
    );
    const runId = await begin(env, "Make add return the sum.");
    const { run, ticks } = await drive(env, runId, 80);
    expect(ticks).toBeLessThan(80);
    expect(run.phase === "FAILED" || run.phase === "NEEDS_HUMAN").toBe(true);
    expect(run.terminalReason).not.toBeNull();
    expect(run.terminalReason?.code).not.toBe("repeated_failure");
  });

  it("accepts a finding whose evidence arrived as an object", async () => {
    env = await startScenario("deps-ts");
    scriptPipeline(
      env.provider,
      toolSteps([
        { name: "write", arguments: { path: "src/add.mjs", content: FIXED_ADD } },
        { name: "finish", arguments: { summary: "add sums" } },
      ]),
      [{
        kind: "fn",
        fn: () => reply(JSON.stringify({
          findings: [{
            criterion: "correctness",
            severity: "high",
            blocking: true,
            claim: "add used to subtract",
            evidence: { path: "src/add.mjs", line: 4 },
            reproduction: ["node --test tests/add.test.mjs"],
          }],
        }), 20, 10),
      }, ...emptyReview(6)],
    );
    const runId = await begin(env, "Make add return the sum.");
    const { ticks } = await drive(env, runId, 80);
    expect(ticks).toBeLessThan(80);
    expect(env.service.store.repos.findings.listByRun(runId).length).toBeGreaterThan(0);
  });

  it("records that the progress tracker is off when only one family exists", async () => {
    env = await startScenario("nothing-to-do", { models: ["wkr"], progressEnabled: true });
    scriptPipeline(env.provider, [], []);
    const runId = await begin(env, "Leave the code unchanged.");
    let seen = false;
    for (let ticks = 0; ticks < 40; ticks += 1) {
      if (env.service.store.events.list(runId, { types: ["run.mechanisms"] }).length > 0) {
        seen = true;
        break;
      }
      await env.service.engine.tickRun(runId);
    }
    expect(seen).toBe(true);
    const mechanisms = env.service.store.events.list(runId, { types: ["run.mechanisms"] })[0]?.payload["mechanisms"];
    expect(mechanisms).toContainEqual({ name: "progress_tracker", on: false, reason: "insufficient_families: 1" });
    expect(mechanisms).toContainEqual({ name: "debate_diversity", on: false, reason: "insufficient_families: 1 of 3 (wkr)" });
    expect(env.service.store.events.list(runId, { types: ["worker.started"] })).toHaveLength(0);
  });

  it("does not let the author's family review its own fix", async () => {
    env = await startScenario("deps-ts", { models: ["wkr"] });
    scriptPipeline(env.provider, toolSteps([
      { name: "write", arguments: { path: "src/add.mjs", content: FIXED_ADD } },
      { name: "finish", arguments: { summary: "add sums through pad" } },
    ]), emptyReview(), "wkr");
    const runId = await begin(env, "Make add return the sum of its arguments.");
    const { run, ticks } = await drive(env, runId, 80);
    expect(ticks).toBeLessThan(80);
    expect(run.phase).toBe("NEEDS_HUMAN");
    expect(run.terminalReason?.code).toBe("review_unverifiable");
    expect(run.terminalReason?.summary).toContain("insufficient_families: 0 of 1");
    expect(run.terminalReason?.summary).toContain("author families excluded: wkr");
    expect(env.service.store.repos.reviewExecutions.listByRun(runId).filter((execution) => execution.completed)).toHaveLength(0);
  });
});

async function begin(env: ScenarioEnv, mission: string): Promise<string> {
  const created = await env.service.handle("run", { project: env.repoDir, mission, runtime: "auto" });
  return (created as { id: string }).id;
}
