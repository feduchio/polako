import { describe, expect, it } from "vitest";
import { id } from "../shared/ids.js";
import type { Checkpoint } from "../domain/checkpoint.js";
import { ProtocolRegistry, defaultProtocolsRoot } from "../protocols/loader.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { REVIEWER_FALSIFIABILITY_AUDIT } from "./reviewerProtocol.js";
import { diffTouchesTests, runAxisReview } from "./swarm.js";

const PROTOCOLS = ProtocolRegistry.load(defaultProtocolsRoot());
const CHECKPOINT: Checkpoint = {
  id: id("cp", 1), runId: id("run", 1), seq: 1, commitHash: "c".repeat(40), parentId: null, source: "integration", taskId: null,
  evidence: { gates: {}, testsPassed: 0, testsFailed: 0, testsTotal: 0, openValidatedFindings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, diffLinesFromBaseline: 1 },
  createdAt: 1,
};
const diffOf = (...paths: string[]): string => paths.map((path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`).join("");

async function review(content: string, opts: { audit: boolean; diff: string; isolation?: boolean }) {
  const provider = new ScriptedProvider("reviews", [{ name: "reviewer", capabilities: FAKE_CAPABILITIES.strong }]);
  provider.script("reviewer", [{ kind: "reply", content }]);
  const result = await runAxisReview({
    checkpoint: CHECKPOINT,
    axis: "correctness",
    artifact: { commitHash: CHECKPOINT.commitHash, diffBase: "b".repeat(40), diff: opts.diff, checkpoint: CHECKPOINT },
    provider: { provider, model: { provider: "reviews", model: "reviewer" } },
    protocols: PROTOCOLS,
    ...(opts.audit ? { falsifiabilityAudit: true } : {}),
    ...(opts.isolation === true ? { isolation: { temperature: 0.7 } } : {}),
  });
  return { result, call: provider.calls[0]! };
}

const entry = (test: string, wouldFailIfBroken: boolean, because = "reason", path = "src/a.test.ts") => ({ path, test, wouldFailIfBroken, because });

describe("per-test falsifiability audit", () => {
  it("is asked for, in the prompt and in the response schema, only when switched on", async () => {
    const on = await review('{"findings":[],"testAudit":[]}', { audit: true, diff: diffOf("src/a.ts") });
    const system = String(on.call.messages[0]?.content);
    expect(system).toContain(REVIEWER_FALSIFIABILITY_AUDIT);
    expect(system).toContain("would fail if the feature were broken");
    expect(system).toContain("try/catch");
    expect(system).toContain("bounds/validity check was removed");
    expect(on.call.responseSchema?.name).toBe("review_findings_with_test_audit");

    const off = await review('{"findings":[]}', { audit: false, diff: diffOf("src/a.ts") });
    expect(String(off.call.messages[0]?.content)).not.toContain("MANDATORY TEST AUDIT");
    expect(off.call.responseSchema?.name).toBe("review_findings");
    expect(off.result.testAudit).toBeUndefined();
  });

  it("composes with the isolated adversarial prompt", async () => {
    const { call } = await review('{"findings":[],"testAudit":[]}', { audit: true, diff: diffOf("src/a.ts"), isolation: true });
    const system = String(call.messages[0]?.content);
    expect(system).toContain("You did not write this change");
    expect(system).toContain("MANDATORY TEST AUDIT");
  });

  it("turns every `no` into a blocking falsifiability finding and keeps the whole audit", async () => {
    const content = JSON.stringify({
      findings: [],
      testAudit: [entry("swallows the error", false, "the throw is caught and the test passes"), entry("checks the total", true), entry("sprite checker bounds", false, "bounds check removed", "tools/check-sprites.mjs")],
    });
    const { result } = await review(content, { audit: true, diff: diffOf("src/a.test.ts", "tools/check-sprites.mjs") });
    expect(result.testAudit).toHaveLength(3);
    expect(result.findings.map((finding) => [finding.criterion, finding.blocking, finding.severity])).toEqual([
      ["falsifiability", true, "high"],
      ["falsifiability", true, "high"],
    ]);
    expect(result.findings[0]?.claim).toBe("swallows the error would not fail if the feature were broken: the throw is caught and the test passes");
    expect(result.findings[0]?.evidence[0]?.path).toBe("src/a.test.ts");
    expect(result.findings[1]?.evidence[0]?.path).toBe("tools/check-sprites.mjs");
    expect(result.findings[0]?.suggestedCheck).toContain("it must fail");
  });

  it("does not double-report a test the reviewer already reported as a falsifiability finding", async () => {
    const content = JSON.stringify({
      findings: [{ criterion: "falsifiability", severity: "high", blocking: true, claim: "the test cannot fail", evidence: [{ path: "src/a.test.ts", line: null, endLine: null, quote: null }], reproduction: [], suggestedCheck: null }],
      testAudit: [entry("t", false)],
    });
    const { result } = await review(content, { audit: true, diff: diffOf("src/a.test.ts") });
    expect(result.findings).toHaveLength(1);
  });

  it("is mandatory: a diff that changes tests with no audit is not a review", async () => {
    await expect(review('{"findings":[],"testAudit":[]}', { audit: true, diff: diffOf("src/a.test.ts") })).rejects.toThrow(/no test audit for a diff that changes tests/);
    await expect(review('{"findings":[]}', { audit: true, diff: diffOf("tools/check-sprites.mjs") })).rejects.toThrow(/no test audit/);
    // a diff that touches no test or check needs none
    await expect(review('{"findings":[],"testAudit":[]}', { audit: true, diff: diffOf("src/a.ts") })).resolves.toBeDefined();
  });

  it("all yes: nothing is added", async () => {
    const { result } = await review(JSON.stringify({ findings: [], testAudit: [entry("a", true), entry("b", true)] }), { audit: true, diff: diffOf("src/a.test.ts") });
    expect(result.findings).toEqual([]);
    expect(result.testAudit).toHaveLength(2);
  });
});

describe("diffTouchesTests", () => {
  it.each([
    [["src/a.test.ts"], true],
    [["src/a.spec.mjs"], true],
    [["domain/__tests__/x.ts"], true],
    [["test/helper.ts"], true],
    [["tools/check-sprites.mjs"], true],
    [["tools/sprite-check.mjs"], true],
    [["src/a.ts", "README.md"], false],
    [["src/contest.ts", "src/latest.ts"], false],
  ])("%j -> %s", (paths, expected) => {
    expect(diffTouchesTests(diffOf(...paths))).toBe(expected);
  });
});
