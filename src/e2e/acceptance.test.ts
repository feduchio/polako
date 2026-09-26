import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Run } from "../domain/run.js";
import { reply } from "../providers/scripted.js";
import { Git } from "../sandbox/git.js";
import { destroyScenario, drive, scriptByPurpose, startScenario, type Responders, type ScenarioEnv } from "./scenario.js";

/**
 * Whole runs on paired fixtures, asserting the verdict a run ends with rather than the activity it
 * shows. `disputed-finding` runs every test file (`node --test`); `named-runner` runs only
 * `tests/add.test.mjs`; `layout-guard` has a test that fails when any file is added under `tests/`.
 * A case marked `it.fails` states the honest outcome and fails on today's code; the change that
 * makes it pass turns it into `it`.
 */

let env: ScenarioEnv | undefined;

afterEach(async () => {
  await destroyScenario(env);
  env = undefined;
});

const MODELS = ["wkr", "xrev", "yjdg", "zdef"];
const MISSION = "Make add return the sum of its arguments.";
const CLAIM = "add(1, 2) returns -1 instead of 3";
const SUM = "export function add(a, b) {\n  return a + b;\n}\n";
const PASSES_ONLY_ITS_TEST = "export function add(a, b) {\n  return a === 2 && b === 3 ? 5 : a - b;\n}\n";

const GOOD_REPRO = [
  'import assert from "node:assert/strict";',
  'import test from "node:test";',
  'import { add } from "../src/add.mjs";',
  'test("add(1, 2) is 3", () => { assert.equal(add(1, 2), 3); });',
  "",
].join("\n");
const JEST_REPRO = [
  'import { add } from "../src/add.mjs";',
  'test("add(1, 2) is 3", () => { expect(add(1, 2)).toBe(3); });',
  "",
].join("\n");
const NEG_TEST = [
  'import assert from "node:assert/strict";',
  'import test from "node:test";',
  'import { add } from "../src/add.mjs";',
  'test("add(-1, 1) is 0", () => { assert.equal(add(-1, 1), 0); });',
  "",
].join("\n");
const KILLED_REPRO = [
  'import test from "node:test";',
  'test("heavy", () => { process.kill(process.pid, "SIGKILL"); });',
  "",
].join("\n");

const TRUE_OR_FALSE_CLAIM = {
  criterion: "correctness",
  severity: "high",
  blocking: true,
  claim: CLAIM,
  evidence: [{ path: "src/add.mjs", line: 2 }],
  reproduction: ["call add(1, 2) and compare the result with 3"],
};

interface Plan {
  /** What the first worker writes: `SUM` leaves correct code, `PASSES_ONLY_ITS_TEST` a planted defect. */
  firstFix: string;
  reproContent?: string;
  /** Findings the first review round raises; later rounds raise none. */
  findings?: Record<string, unknown>[];
  judge?: string;
}

function responders(plan: Plan): Responders {
  let raised = false;
  const findings = plan.findings ?? [TRUE_OR_FALSE_CLAIM];
  const claims = findings.map((finding) => String(finding.claim));
  return {
    agent: [
      {
        matches: (text) => text.includes("REPRODUCTION FILE") || text.includes("Fix: "),
        calls: [
          { name: "write", arguments: { path: "src/add.mjs", content: SUM } },
          { name: "finish", arguments: { summary: "add sums" } },
        ],
      },
      {
        matches: (text) => claims.some((claim) => text.includes(claim)),
        calls: [
          { name: "write", arguments: { path: "tests/claim.test.mjs", content: plan.reproContent ?? GOOD_REPRO } },
          { name: "finish", arguments: { summary: "reproduction for the claim", reproduction: { argv: ["npm", "run", "test"] } } },
        ],
      },
      {
        matches: () => true,
        calls: [
          { name: "write", arguments: { path: "src/add.mjs", content: plan.firstFix } },
          { name: "finish", arguments: { summary: "add fixed" } },
        ],
      },
    ],
    review: () => {
      if (raised) return [];
      raised = true;
      return findings;
    },
    debate: (role) => {
      if (role === "judge") return plan.judge ?? "Probably valid, though I would want to see it run.";
      return `${role}: the evidence is a line reference; nothing was executed.`;
    },
  };
}

interface Outcome {
  run: Run;
  statuses: string[];
  fixTasks: number;
  investigations: number;
  /** `outcome` or `outcome:reason` of each investigation that reached the judge. */
  judged: string[];
  /** Dispositions the last clean round recorded for its checkpoint. */
  lastCleanRound: Record<string, unknown> | undefined;
  add: string;
}

async function runCase(fixture: string, plan: Plan): Promise<Outcome> {
  env = await startScenario(fixture, { models: MODELS, investigationRounds: 1 });
  scriptByPurpose(env.provider, MODELS, responders(plan));
  const created = await env.service.handle("run", { project: env.repoDir, mission: MISSION, runtime: "auto" });
  const runId = (created as { id: string }).id;
  const { run } = await drive(env, runId, 200);
  const store = env.service.store;
  return {
    run,
    statuses: store.repos.findings.listByRun(runId).map((finding) => finding.status),
    fixTasks: store.repos.tasks.listByRun(runId).filter((task) => task.origin.kind === "valid_finding").length,
    investigations: store.events.list(runId, { types: ["investigation.completed"] }).length,
    judged: store.events.list(runId, { types: ["investigation.completed"] })
      .filter((event) => typeof event.payload["outcome"] === "string")
      .map((event) => [event.payload["outcome"], event.payload["reason"]].filter((part) => typeof part === "string").join(":")),
    lastCleanRound: (store.events.list(runId, { types: ["clean_round.recorded"] }).at(-1)?.payload["cleanRound"] as { dispositions?: Record<string, unknown> } | undefined)?.dispositions,
    add: await runBranchFile(env, run, "src/add.mjs"),
  };
}

async function runBranchFile(scenario: ScenarioEnv, run: Run, path: string): Promise<string> {
  try {
    return (await new Git(scenario.repoDir).out(["show", `${run.runBranch}:${path}`])).trim();
  } catch {
    return "(absent)";
  }
}

describe("acceptance: a defect is demonstrated only by an execution that shows it", () => {
  it("correct code and silent reviewers end DONE with no finding", async () => {
    const outcome = await runCase("disputed-finding", { firstFix: SUM, findings: [] });
    expect(outcome.run.phase).toBe("DONE");
    expect(outcome.statuses).toEqual([]);
    expect(outcome.add).toBe(SUM.trim());
  });

  it("a planted defect whose reproduction runs and fails becomes a fix, and the run ends with correct code", async () => {
    const outcome = await runCase("disputed-finding", { firstFix: PASSES_ONLY_ITS_TEST });
    expect(outcome.statuses).toContain("VALID");
    expect(outcome.judged).toEqual(["demonstrated"]);
    expect(outcome.run.phase).toBe("DONE");
    expect(outcome.add).toBe(SUM.trim());
  });

  it("a false finding whose reproduction runs and passes is refuted without a fix task", async () => {
    const outcome = await runCase("disputed-finding", { firstFix: SUM });
    expect(outcome.statuses).toEqual(["REJECTED"]);
    expect(outcome.judged).toEqual(["refuted"]);
    expect(outcome.fixTasks).toBe(0);
    expect(outcome.run.phase).toBe("DONE");
    expect(outcome.run.terminalReason).toMatchObject({ code: "converged", summary: expect.stringMatching(/1 finding: 0 demonstrated, 1 refuted/) });
    expect(outcome.lastCleanRound).toMatchObject({ total: 1, refuted: 1, demonstrated: 0 });
  });

  it("a reproduction the test script never runs does not refute a planted defect", async () => {
    const outcome = await runCase("named-runner", { firstFix: PASSES_ONLY_ITS_TEST });
    expect(outcome.investigations).toBeGreaterThan(0);
    expect(outcome.statuses).not.toContain("REJECTED");
    expect(outcome.run.phase === "DONE" && outcome.run.terminalReason?.code === "converged" && outcome.add.includes("a - b")).toBe(false);
    expect(outcome.judged).toEqual(["demonstrated"]);
    expect(outcome.add).toBe(SUM.trim());
  });

  it("a Jest-style reproduction under node:test proves nothing against correct code: the write is refused before it runs", async () => {
    const outcome = await runCase("disputed-finding", { firstFix: SUM, reproContent: JEST_REPRO });
    expect(outcome.investigations).toBeGreaterThan(0);
    expect(outcome.judged).not.toContain("demonstrated");
    const refusals = env!.provider.calls
      .filter((call) => call.messages.some((message) => message.role === "tool" && message.content.includes("write refused: tests/claim.test.mjs calls test, expect without importing them")));
    expect(refusals.length).toBeGreaterThan(0);
    expect(outcome.statuses).not.toContain("VALID");
    expect(outcome.fixTasks).toBe(0);
  });

  it("a reproduction killed by a signal proves nothing against correct code", async () => {
    const outcome = await runCase("disputed-finding", { firstFix: SUM, reproContent: KILLED_REPRO });
    expect(outcome.investigations).toBeGreaterThan(0);
    expect(outcome.judged).toEqual(["not_examined:killed"]);
    expect(outcome.run.phase).toBe("DONE");
    expect(outcome.run.terminalReason?.code).toBe("converged_with_unexamined");
    expect(outcome.run.terminalReason?.summary).toMatch(/\(killed\).*1 not examined \(killed 1\)/);
    expect(outcome.statuses).not.toContain("VALID");
    expect(outcome.fixTasks).toBe(0);
  });

  it("a reproduction that needs a module the project lacks is not examined, and says what is missing", async () => {
    const outcome = await runCase("disputed-finding", {
      firstFix: SUM,
      reproContent: 'import test from "node:test";\nimport { sum } from "../src/sum.mjs";\ntest("sum", () => { sum(1, 2); });\n',
    });
    expect(outcome.judged).toEqual(["not_examined:environment"]);
    expect(outcome.run.terminalReason?.code).toBe("converged_with_unexamined");
    expect(outcome.statuses).not.toContain("VALID");
    expect(outcome.fixTasks).toBe(0);
  });

  it("an unrelated test failing next to a passing reproduction proves nothing", async () => {
    const outcome = await runCase("layout-guard", { firstFix: SUM });
    expect(outcome.investigations).toBeGreaterThan(0);
    expect(outcome.judged).toEqual(["refuted"]);
    expect(outcome.statuses).not.toContain("VALID");
    expect(outcome.fixTasks).toBe(0);
  });
});

describe("acceptance: a model's words neither run code nor decide a blocking finding", () => {
  it("a reviewer's reproduction text is never executed", async () => {
    const marker = join(tmpdir(), `polish-acceptance-marker-${String(process.pid)}`);
    rmSync(marker, { force: true });
    const code = `require("fs").writeFileSync(${JSON.stringify(marker)},"x");process.exit(1)`;
    try {
      const outcome = await runCase("disputed-finding", {
        firstFix: SUM,
        findings: [{
          criterion: "correctness",
          severity: "high",
          blocking: true,
          claim: "the add test misses a regression",
          evidence: [{ path: "src/add.mjs", line: 2 }],
          reproduction: [`npm exec --yes -- node -e ${code}`],
        }],
      });
      expect(existsSync(marker)).toBe(false);
      expect(outcome.fixTasks).toBe(0);
    } finally {
      rmSync(marker, { force: true });
    }
  });

  it("a judge's VALID on a finding whose named script is missing does not create a fix task", async () => {
    const outcome = await runCase("disputed-finding", {
      firstFix: SUM,
      findings: [{
        criterion: "correctness",
        severity: "high",
        blocking: true,
        claim: "add has no regression test for negative numbers",
        evidence: [{ path: "src/add.mjs", line: 2 }],
        reproduction: ["npm run test:negative"],
      }],
      judge: JSON.stringify({ verdict: "VALID", rationale: "The reviewer's claim matches the cited code." }),
    });
    expect(outcome.fixTasks).toBe(0);
    expect(outcome.add).toBe(SUM.trim());
  });

  it("a judge's REJECTED does not close a blocking finding that nothing executed", async () => {
    const outcome = await runCase("disputed-finding", {
      firstFix: SUM,
      judge: JSON.stringify({ verdict: "REJECTED", rationale: "No mission requirement asks for this." }),
    });
    expect(outcome.investigations).toBeGreaterThan(0);
  });
});

describe("acceptance: a no-change DONE shows the task's acceptance holds", () => {
  it("a mission to add a test file does not end no_change_required without the file: the claim is refused and the file gets written", async () => {
    env = await startScenario("nothing-to-do", { models: MODELS });
    const requirement = {
      ref: "R1",
      statement: "A new test file tests/neg.test.mjs checks that add(-1, 1) is 0",
      acceptance: ["tests/neg.test.mjs exists and asserts add(-1, 1) === 0", "npm run test passes"],
      blocking: true,
    };
    scriptByPurpose(env.provider, MODELS, {
      ...responders({ firstFix: SUM }),
      agent: [{
        matches: () => true,
        calls: [
          { name: "run_command", arguments: { argv: ["npm", "run", "test"] } },
          { name: "finish", arguments: { summary: "negatives already work", noChange: { reason: "add already handles negative numbers; npm run test passes" } } },
          { name: "write", arguments: { path: "tests/neg.test.mjs", content: NEG_TEST } },
          { name: "run_command", arguments: { argv: ["npm", "run", "test"] } },
          { name: "finish", arguments: { summary: "added tests/neg.test.mjs" } },
        ],
      }],
      review: () => [],
    });
    const original = env.provider.complete.bind(env.provider);
    env.provider.complete = async (request) => {
      const purpose = request.metadata.purpose;
      if (purpose === "council_intake_planner") {
        return reply(JSON.stringify({
          decision: "approve",
          rationale: "checkable",
          concerns: [],
          proposal: {
            goals: ["Cover negative numbers with a test"],
            requirements: [requirement],
            constraints: [],
            nonGoals: [],
            definitionOfSuccess: ["tests/neg.test.mjs exists and passes"],
            ambiguities: [],
          },
        }), 10, 5);
      }
      if (purpose === "council_decompose_planner") {
        return reply(JSON.stringify({
          decision: "approve",
          rationale: "One task.",
          concerns: [],
          proposal: [{
            title: "Add tests/neg.test.mjs",
            description: "WHAT: create tests/neg.test.mjs asserting add(-1, 1) === 0\nWHY: R1\nCONSTRAINTS: do not change src/add.mjs\nEVIDENCE: tests/add.test.mjs",
            kind: "test",
            requirementRef: "R1",
            acceptance: requirement.acceptance,
            complexity: "trivial",
            dependsOn: [],
          }],
        }), 10, 5);
      }
      return original(request);
    };
    const created = await env.service.handle("run", {
      project: env.repoDir,
      mission: "Add a new test file tests/neg.test.mjs that checks add(-1, 1) is 0.",
      runtime: "auto",
    });
    const { run } = await drive(env, (created as { id: string }).id, 120);
    const noChangeDone = run.phase === "DONE" && run.terminalReason?.code === "no_change_required";
    expect(noChangeDone && (await runBranchFile(env, run, "tests/neg.test.mjs")) === "(absent)").toBe(false);
    expect(run.phase).toBe("DONE");
    expect(run.terminalReason?.code).toBe("converged");
    expect(await runBranchFile(env, run, "tests/neg.test.mjs")).toBe(NEG_TEST.trim());
  });
});
