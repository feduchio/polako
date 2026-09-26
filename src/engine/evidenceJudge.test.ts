import { describe, expect, it } from "vitest";
import type { ProcessResult } from "../sandbox/process.js";
import { judgeReproduction } from "./evidenceJudge.js";

function result(overrides: Partial<ProcessResult>): ProcessResult {
  return {
    argv: ["npm", "run", "test"],
    cwd: "/tmp/checkout",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    truncated: false,
    timedOut: false,
    aborted: false,
    durationMs: 5,
    startedAt: 0,
    ...overrides,
  };
}

function specRun(passed: number, failures: { at: string; title: string; error: string }[]): string {
  const blocks = failures.map((failure) => `test at ${failure.at}\n✖ ${failure.title} (1ms)\n  ${failure.error}\n      at x (file:///tmp/checkout/${failure.at})\n`);
  return [
    ...failures.map((failure) => `✖ ${failure.title} (1ms)`),
    `ℹ tests ${String(passed + failures.length)}`,
    `ℹ pass ${String(passed)}`,
    `ℹ fail ${String(failures.length)}`,
    ...(failures.length === 0 ? [] : ["", "✖ failing tests:", "", ...blocks]),
  ].join("\n");
}

const ADDED = ["tests/claim.test.mjs"];
const passingControl = result({ stdout: specRun(1, []) });

describe("judgeReproduction, with a control run", () => {
  it("demonstrates when a test in the reproduction fails an assertion and the control passes", () => {
    const treatment = result({
      exitCode: 1,
      stdout: specRun(1, [{ at: "tests/claim.test.mjs:4:1", title: "add(1, 2) is 3", error: "AssertionError [ERR_ASSERTION]: -1 !== 3" }]),
    });
    expect(judgeReproduction({ framework: "node-test", treatment, control: passingControl, added: ADDED, scoped: false })).toMatchObject({
      outcome: "demonstrated",
      reason: null,
    });
  });

  it("does not refute when the command passes with the same tests it ran without the reproduction", () => {
    const treatment = result({ stdout: specRun(1, []) });
    expect(judgeReproduction({ framework: "node-test", treatment, control: passingControl, added: ADDED, scoped: false })).toMatchObject({
      outcome: "not_examined",
      reason: "reproduction_not_executed",
    });
  });

  it("refutes when the reproduction's tests ran and passed", () => {
    const treatment = result({ stdout: specRun(2, []) });
    expect(judgeReproduction({ framework: "node-test", treatment, control: passingControl, added: ADDED, scoped: false }).outcome).toBe("refuted");
  });

  it("attributes nothing when a test outside the reproduction fails", () => {
    const treatment = result({
      exitCode: 1,
      stdout: specRun(2, [{ at: "tests/layout.test.mjs:3:1", title: "tests/ holds only known files", error: "AssertionError [ERR_ASSERTION]: unexpected claim.test.mjs" }]),
    });
    expect(judgeReproduction({ framework: "node-test", treatment, control: passingControl, added: ADDED, scoped: false })).toMatchObject({
      outcome: "not_examined",
      reason: "failure_outside_reproduction",
    });
  });

  it("attributes nothing when the command already fails without the reproduction", () => {
    const control = result({ exitCode: 1, stdout: specRun(0, [{ at: "tests/add.test.mjs:2:1", title: "red", error: "AssertionError: red" }]) });
    const treatment = result({
      exitCode: 1,
      stdout: specRun(0, [{ at: "tests/claim.test.mjs:4:1", title: "claim", error: "AssertionError: x" }]),
    });
    expect(judgeReproduction({ framework: "node-test", treatment, control, added: ADDED, scoped: false })).toMatchObject({
      outcome: "not_examined",
      reason: "control_failed",
    });
  });
});

describe("judgeReproduction, one added file run alone", () => {
  it("keeps a real assertion failure whose message mentions ENOENT as demonstrated", () => {
    const treatment = result({
      argv: ["node", "--test", "tests/claim.test.mjs"],
      exitCode: 1,
      stdout: specRun(0, [{ at: "tests/claim.test.mjs:4:1", title: "reads config", error: "AssertionError [ERR_ASSERTION]: expected ENOENT to be handled, got a crash" }]),
    });
    expect(judgeReproduction({ framework: "node-test", treatment, control: null, added: ADDED, scoped: true }).outcome).toBe("demonstrated");
  });

  it("never demonstrates from a non-zero exit with no failing test in the report", () => {
    const treatment = result({ argv: ["node", "--test", "tests/claim.test.mjs"], exitCode: 1, stdout: "ℹ tests 1\nℹ pass 1\nℹ fail 0\n" });
    expect(judgeReproduction({ framework: "node-test", treatment, control: null, added: ADDED, scoped: true })).toMatchObject({
      outcome: "not_examined",
      reason: "unrecognised_runner",
    });
  });

  it("counts a missing binary and a timeout as not examined", () => {
    expect(judgeReproduction({ framework: "node-test", treatment: result({ exitCode: 127 }), control: null, added: ADDED, scoped: true }).reason).toBe("environment");
    expect(judgeReproduction({
      framework: "node-test",
      treatment: result({ exitCode: null, signal: "SIGTERM", timedOut: true }),
      control: null,
      added: ADDED,
      scoped: true,
    }).reason).toBe("timeout");
  });

  it("refutes only when some test ran", () => {
    const empty = result({ argv: ["node", "--test", "tests/claim.test.mjs"], stdout: "ℹ tests 0\nℹ pass 0\nℹ fail 0\n" });
    expect(judgeReproduction({ framework: "node-test", treatment: empty, control: null, added: ADDED, scoped: true }).reason).toBe("reproduction_not_executed");
  });
});
