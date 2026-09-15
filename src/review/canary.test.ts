import { describe, expect, it } from "vitest";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { ProtocolRegistry, defaultProtocolsRoot } from "../protocols/loader.js";
import { PolishError } from "../shared/errors.js";
import { ProviderError } from "../broker/types.js";
import { CANARY_DEFECT, runReviewerCanary } from "./canary.js";

const protocols = ProtocolRegistry.load(defaultProtocolsRoot());
const RUN = "run_0000000000000000000000";

function reviewerReturning(content: string | Error): { provider: ScriptedProvider; model: { provider: string; model: string } } {
  const provider = new ScriptedProvider("p", [{ name: "m", capabilities: FAKE_CAPABILITIES.strong }]);
  provider.script("m", [
    content instanceof Error
      ? { kind: "error", error: content as ProviderError }
      : { kind: "reply", content },
  ]);
  return { provider, model: { provider: "p", model: "m" } };
}

function finding(path: string, line: number): string {
  return JSON.stringify([{
    criterion: "correctness",
    severity: "high",
    blocking: false,
    claim: "reads one past the end",
    evidence: [{ path, line }],
    reproduction: ["call evictStale([], 0)"],
  }]);
}

describe("reviewer canary", () => {
  it("verifies only a finding that points at the planted defect", async () => {
    for (const [path, line, verified] of [
      // The loop header whose bound is wrong, and the dereference that goes out of bounds: a
      // correct reviewer may cite either.
      [CANARY_DEFECT.path, 8, true],
      [CANARY_DEFECT.path, 9, true],
      // The declaration above and the closing brace below are not the defect. A reviewer that
      // complains about them has not found it.
      [CANARY_DEFECT.path, 7, false],
      [CANARY_DEFECT.path, 10, false],
      ["src/other.ts", 8, false],
      // Diff-flavoured and relative spellings of the same file.
      ["a/src/cache.ts", 8, true],
      ["b/src/cache.ts", 9, true],
      ["./src/cache.ts", 8, true],
      ["src/cache.ts.bak", 8, false],
    ] as const) {
      const result = await runReviewerCanary({
        provider: reviewerReturning(finding(path, line)),
        protocols,
        runId: RUN,
        now: 1,
      });
      expect({ path, line, verified: result.verified }).toEqual({ path, line, verified });
    }
  });

  it("sends the planted defect, so a canary that stopped sending it would fail", async () => {
    const reviewer = reviewerReturning(JSON.stringify({ findings: [] }));
    await runReviewerCanary({ provider: reviewer, protocols, runId: RUN, now: 1 });
    const sent = JSON.stringify(reviewer.provider.calls[0]?.messages);
    expect(sent).toContain("evictStale");
    expect(sent).toContain("i <= entries.length");
  });

  it("records a provider failure as unverified rather than throwing", async () => {
    const result = await runReviewerCanary({
      provider: reviewerReturning(new ProviderError("p", "server", "boom")),
      protocols,
      runId: RUN,
      now: 1,
    });
    expect(result).toMatchObject({ verified: false, findings: 0, located: 0 });
    expect(result.error).toContain("boom");
  });

  // Neither is a statement about the reviewer, and the verdict cache never retries a recorded one.
  it.each([
    ["budget", new PolishError("CONFLICT", "run USD budget exhausted", { budget: "run_usd" })],
    ["cancellation", new PolishError("CANCELLED", "model call cancelled")],
  ])("lets a %s error out instead of recording a verdict", async (_label, error) => {
    const provider = new ScriptedProvider("p", [{ name: "m", capabilities: FAKE_CAPABILITIES.strong }]);
    provider.script("m", [{ kind: "fn", fn: () => { throw error; } }]);
    await expect(
      runReviewerCanary({ provider: { provider, model: { provider: "p", model: "m" } }, protocols, runId: RUN, now: 1 }),
    ).rejects.toBe(error);
  });
});
