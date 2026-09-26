import { afterEach, describe, expect, it } from "vitest";
import { Git } from "../sandbox/git.js";
import { destroyScenario, drive, scriptByPurpose, startScenario, workerTokens, type ScenarioEnv } from "./scenario.js";

/**
 * Council round 4, item 12: screen-audit-toolkit's shape offline. Its test script puts a flag
 * between `node` and `--test` and a glob after it, and its suite prints hundreds of passing lines.
 * The worker repeats what the live attempts did — writes Jest-style tests first — and has to end
 * with a node:test file, run one file while iterating and the whole suite once, under the budget.
 */
let env: ScenarioEnv | undefined;
afterEach(async () => {
  await destroyScenario(env);
  env = undefined;
});

const MODELS = ["wkr", "xrev", "yjdg", "zdef"];
const TEST_FILE = "src/__tests__/args.test.ts";
const JEST_STYLE = 'import { parseArgs } from "../args.ts";\ndescribe("parseArgs", () => { test("flags", () => { expect(parseArgs(["--a"])).toEqual({ a: true }); }); });\n';
const NODE_TEST = [
  'import assert from "node:assert/strict";',
  'import { describe, it } from "node:test";',
  'import { parseArgs } from "../args.ts";',
  'describe("parseArgs", () => {',
  '  it("reads a bare flag as true", () => { assert.deepEqual(parseArgs(["--verbose"]), { verbose: true }); });',
  '  it("reads --key=value", () => { assert.deepEqual(parseArgs(["--out=a.json"]), { out: "a.json" }); });',
  "});",
  "",
].join("\n");
const ONE_FILE = ["node", "--experimental-strip-types", "--test", TEST_FILE];

describe("SAT offline replay", () => {
  it("writes a node:test file after a refused Jest one, runs it alone, runs the suite once, and ends DONE under the budget", { timeout: 120_000 }, async () => {
    env = await startScenario("sat-shape", { models: MODELS });
    const scenario = env;
    scriptByPurpose(scenario.provider, MODELS, {
      agent: [{
        matches: () => true,
        calls: [
          { name: "write", arguments: { path: TEST_FILE, content: JEST_STYLE } },
          { name: "write", arguments: { path: TEST_FILE, content: NODE_TEST } },
          { name: "run_command", arguments: { argv: ONE_FILE } },
          { name: "run_command", arguments: { argv: ["npm", "run", "test"] } },
          { name: "finish", arguments: { summary: "added parseArgs tests" } },
        ],
      }],
      review: () => [],
      debate: () => "no debate",
    });
    const created = await scenario.service.handle("run", {
      project: scenario.repoDir,
      mission: `Add tests for parseArgs in ${TEST_FILE}: a bare flag is true and --key=value reads the value.`,
      runtime: "auto",
    });
    const { run } = await drive(scenario, (created as { id: string }).id, 200);

    expect(run.phase).toBe("DONE");
    expect(run.terminalReason?.code).toBe("converged");
    const written = await new Git(scenario.repoDir).out(["show", `${run.runBranch}:${TEST_FILE}`]);
    expect(written).toContain('from "node:test"');

    const toolResults = scenario.provider.calls
      .filter((call) => call.metadata.purpose === "agent_run")
      .flatMap((call) => call.messages.filter((message) => message.role === "tool").map((message) => message.content));
    expect(toolResults.some((content) => content.includes(`write refused: ${TEST_FILE} calls describe, test, expect without importing them`))).toBe(true);
    const oneFile = toolResults.find((content) => content.includes('"argv":["node","--experimental-strip-types","--test"'));
    expect(oneFile).toMatch(/"exitCode":0/);
    const suite = toolResults.find((content) => content.includes("[test report] tests 372"));
    expect(suite).toBeDefined();
    const suiteContent = (JSON.parse(suite ?? "{}") as { output?: { content?: string } }).output?.content ?? "";
    expect(suiteContent.split("\n").length).toBeLessThanOrEqual(40);

    expect(workerTokens(scenario, run.id)).toBeLessThan(96_000);
    const failed = scenario.service.store.repos.candidates.listByRun(run.id).filter((candidate) => candidate.error?.includes("BUDGET_EXCEEDED") === true);
    expect(failed).toEqual([]);
  });
});
