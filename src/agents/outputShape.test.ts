import { describe, expect, it } from "vitest";
import { shapeCommandOutput } from "./outputShape.js";

/** The shape of screen-audit-toolkit's `npm run test` with one Jest-style file among 370 passing tests. */
function satLikeRun(): string {
  const lines = ["> screen-audit-toolkit@0.4.0 test", '> node --import tsx --test "src/**/*.test.ts"', ""];
  for (let suite = 0; suite < 37; suite += 1) {
    lines.push(`▶ suite ${String(suite)}`);
    for (let test = 0; test < 10; test += 1) lines.push(`  ✔ case ${String(suite)}.${String(test)} (0.1ms)`);
    lines.push(`✔ suite ${String(suite)} (1.2ms)`);
    if (suite === 20) lines.push("✖ src/__tests__/args.test.ts (30.1ms)");
  }
  lines.push(
    "ℹ tests 371", "ℹ suites 37", "ℹ pass 370", "ℹ fail 1", "ℹ cancelled 0", "ℹ skipped 0", "ℹ todo 0", "ℹ duration_ms 1402.5", "",
    "✖ failing tests:", "", "test at src/__tests__/args.test.ts:1:1", "✖ src/__tests__/args.test.ts (30.1ms)", "  'test failed'",
    "[stderr]", "file:///tmp/sat/src/__tests__/args.test.ts:3", 'test("parses", () => {', "^", "",
    "ReferenceError: test is not defined", "    at file:///tmp/sat/src/__tests__/args.test.ts:3:1", "", "Node.js v24.20.0",
  );
  return lines.join("\n");
}

describe("shapeCommandOutput", () => {
  it("leads a test run with its report and folds the passing lines, keeping the failure verbatim", () => {
    const raw = satLikeRun();
    expect(raw.split("\n").length).toBeGreaterThan(450);
    const shaped = shapeCommandOutput(raw, "node-test");
    const lines = shaped.text.split("\n");
    expect(lines.length).toBeLessThanOrEqual(40);
    expect(lines[0]).toBe("[test report] tests 371, passed 370, failed 1, skipped 0");
    expect(lines[1]).toBe("[failing] src/__tests__/args.test.ts (reference_error): ReferenceError: test is not defined");
    expect(shaped.text).toContain("ℹ fail 1");
    expect(shaped.text).toContain("ReferenceError: test is not defined");
    expect(shaped.text).toContain("✖ src/__tests__/args.test.ts (30.1ms)");
    expect(shaped.folded).toMatch(/^\d+ passing-test lines folded$/);
  });

  it("keeps the head and the tail of long output it does not recognise", () => {
    const raw = Array.from({ length: 500 }, (_, i) => `line ${String(i)}`).join("\n");
    const shaped = shapeCommandOutput(raw, "unknown");
    expect(shaped.text).toContain("line 0");
    expect(shaped.text).toContain("line 499");
    expect(shaped.text).toContain("… 380 lines omitted …");
    expect(shaped.text).not.toContain("line 250");
    expect(shaped.folded).toBe("380 middle lines omitted");
  });

  it("leaves short output alone", () => {
    expect(shapeCommandOutput("ok\n", "node-test")).toEqual({ text: "ok\n", folded: null });
  });
});
