import { describe, expect, it } from "vitest";
import type { BaselineSnapshot, CheckResult } from "../domain/checks.js";
import { silencingFromSkippedBaselineFailures } from "./checkRunner.js";

describe("silencingFromSkippedBaselineFailures", () => {
  it("reports a baseline failure that passed because it was skipped", () => {
    const findings = silencingFromSkippedBaselineFailures(
      baseline(0),
      [check(2)],
      [JSON.stringify(["test", "src/add.test.ts"])],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("skip_only");
    expect(findings[0]?.detail).toContain("0 → 2");
  });

  it("stays quiet when the skip count did not rise", () => {
    const findings = silencingFromSkippedBaselineFailures(
      baseline(2),
      [check(2)],
      [JSON.stringify(["test", "src/add.test.ts"])],
    );
    expect(findings).toEqual([]);
  });
});

function baseline(skipped: number): BaselineSnapshot {
  return {
    id: "base_01",
    runId: "run_01",
    commitHash: "a".repeat(40),
    checks: [check(skipped)],
    configHashes: {},
    scriptsHash: "0".repeat(64),
    toolchain: {},
    createdAt: 1,
  };
}

function check(skipped: number): CheckResult {
  return {
    name: "test",
    kind: "test",
    status: "fail",
    exitCode: 1,
    durationMs: 1,
    summary: { passed: 0, failed: 1, skipped, total: 1, failingTests: ["src/add.test.ts"] },
    outputRef: null,
  };
}
