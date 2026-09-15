import { describe, expect, it } from "vitest";
import { PolishError } from "../shared/errors.js";
import { BudgetTracker, isBudgetError, type BudgetLimits } from "./quota.js";

const SHARED: BudgetLimits = { maxRunUsd: null, maxRunTokens: 100, maxTaskTokens: null };

function spend(tracker: BudgetTracker, runId: string, tokens: number, costUsd: number | null = null, taskId?: string): void {
  tracker.record(runId, { inputTokens: tokens, outputTokens: 0, costUsd }, taskId);
}

/** Mirrors production: a run's limits reach the tracker only through the lazy resolver. */
function trackerWith(overrides: Record<string, BudgetLimits>): BudgetTracker {
  return new BudgetTracker(SHARED, (runId) => overrides[runId] ?? null);
}

function budgetErrorOf(fn: () => void): PolishError {
  try {
    fn();
  } catch (error) {
    if (error instanceof PolishError && isBudgetError(error)) return error;
    throw error;
  }
  throw new Error("expected a budget error");
}

/**
 * R0a. The reservation, which is what makes `maxRunUsd` a bound rather than an admission
 * threshold. Before it, every call in flight was admitted against the same recorded spend.
 */
describe("BudgetTracker admission reserves what a call may cost", () => {
  const usdOnly: BudgetLimits = { maxRunUsd: 0.5, maxRunTokens: null, maxTaskTokens: null };

  it("refuses the second of two concurrent calls that cannot both fit", () => {
    const tracker = new BudgetTracker(usdOnly);
    const first = tracker.admit("run_a", 0.49);
    // Nothing is recorded yet: this is the exact window in which ten $0.49 calls all passed.
    expect(tracker.snapshot("run_a").runUsd).toBe(0);
    expect(budgetErrorOf(() => { tracker.admit("run_a", 0.49); }).details["spent"]).toBe(0.49);
    first();
    expect(() => tracker.admit("run_a", 0.49)).not.toThrow();
  });

  it("admits four calls of a quarter of the limit and refuses the fifth", () => {
    // 0.125 is exact in binary: the limit is reached, not approached, so the boundary is the
    // boundary and not a rounding artefact.
    const tracker = new BudgetTracker(usdOnly);
    for (let i = 0; i < 4; i++) tracker.admit("run_a", 0.125);
    expect(budgetErrorOf(() => { tracker.admit("run_a", 0.125); }).details["budget"]).toBe("run_usd");
  });

  it("refuses a single call that alone cannot fit the budget, and says so differently", () => {
    const tracker = new BudgetTracker(usdOnly);
    const insufficient = budgetErrorOf(() => { tracker.admit("run_a", 0.51); });
    expect(insufficient.details["spent"]).toBe(0);
    expect(insufficient.details["estimate"]).toBe(0.51);
    // "Exhausted" at a spend of $0 sends an operator looking for spend that never happened.
    expect(insufficient.message).toBe("run USD budget cannot cover the next call");
    tracker.record("run_a", { inputTokens: 1, outputTokens: 1, costUsd: 0.5 });
    expect(budgetErrorOf(() => { tracker.admit("run_a", 0); }).message).toBe("run USD budget exhausted");
  });

  it("fits holds that add up to the limit in decimal but not in binary", () => {
    // 0.1 + 0.2 is 0.30000000000000004. A $0.10 and a $0.20 call fit a $0.30 budget, and an
    // operator who is told otherwise has no way to see why.
    const tracker = new BudgetTracker({ maxRunUsd: 0.3, maxRunTokens: null, maxTaskTokens: null });
    tracker.admit("run_a", 0.1);
    expect(() => tracker.admit("run_a", 0.2)).not.toThrow();
    expect(budgetErrorOf(() => { tracker.admit("run_a", 0.000001); }).details["budget"]).toBe("run_usd");
  });

  // One case per boundary the two rules have to agree on. A slack, of either kind, failed at least
  // one of these: relative slack admitted $1 at a limit of $1e9, absolute slack refused a
  // decimal-exact total at $25.6M, and both let a call be admitted and then instantly called
  // exhausted.
  it.each([
    ["decimal total equal to the limit", 0.3, [0.1], 0.2, true],
    ["a hair over the limit", 0.5, [], 0.5000000005, false],
    ["large limit, large overspend", 1_000_000_000, [999_999_999], 2, false],
    ["large limit, exact remainder", 1_000_000_000, [999_999_999], 1, true],
    ["limit of zero admits nothing", 0, [], 0, false],
  ] as const)("budget boundary: %s", (_label, maxRunUsd, holds, incoming, admitted) => {
    const tracker = new BudgetTracker({ maxRunUsd, maxRunTokens: null, maxTaskTokens: null });
    for (const hold of holds) tracker.admit("run_a", hold);
    if (admitted) {
      // Reaching the limit exactly is allowed, and the next call is then correctly refused as
      // exhausted. What the two rules must never do is admit a total above the limit and call the
      // same total exhausted — which is what "a hair over the limit" covers.
      expect(() => tracker.admit("run_a", incoming)).not.toThrow();
    } else {
      expect(isBudgetError(budgetErrorOf(() => { tracker.admit("run_a", incoming); }))).toBe(true);
    }
  });

  it("does not let a stale release delete a live hold's accounting", () => {
    const tracker = new BudgetTracker(usdOnly);
    const stale = tracker.admit("run_a", 0.4);
    stale();
    const live = tracker.admit("run_a", 0.4);
    stale();
    // The stale release must not remove the entry the live hold is counted in.
    expect(budgetErrorOf(() => { tracker.admit("run_a", 0.4); }).details["spent"]).toBe(0.4);
    live();
    expect(() => tracker.admit("run_a", 0.4)).not.toThrow();
  });

  it("returns the whole reservation on release, with no floating-point residue", () => {
    const tracker = new BudgetTracker({ maxRunUsd: 1, maxRunTokens: null, maxTaskTokens: null });
    // 0.18 + 0.21 + 0.41 subtracted back one at a time leaves 1.665e-16 behind, and a run that
    // has released everything is then refused forever.
    const releases = [0.18, 0.21, 0.41].map((usd) => tracker.admit("run_a", usd));
    for (const release of releases) release();
    expect(() => tracker.admit("run_a", 1)).not.toThrow();
  });

  it("releases a reservation once, whether the call succeeded or failed", () => {
    const tracker = new BudgetTracker(usdOnly);
    const release = tracker.admit("run_a", 0.4);
    release();
    release();
    // A double release must not create room that was never there.
    tracker.record("run_a", { inputTokens: 1, outputTokens: 1, costUsd: 0.4 });
    expect(budgetErrorOf(() => { tracker.admit("run_a", 0.2); }).details["spent"]).toBe(0.4);
  });

  it("charges the recorded cost, not the reservation, once the call returns", () => {
    const tracker = new BudgetTracker(usdOnly);
    const release = tracker.admit("run_a", 0.49);
    tracker.record("run_a", { inputTokens: 10, outputTokens: 2, costUsd: 0.01 });
    release();
    expect(tracker.snapshot("run_a").runUsd).toBe(0.01);
    expect(() => tracker.admit("run_a", 0.4)).not.toThrow();
  });

  it("reserves nothing when the estimate is unusable, and still admits", () => {
    const tracker = new BudgetTracker(usdOnly);
    for (const estimate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      tracker.admit("run_a", estimate);
    }
    expect(() => tracker.admit("run_a", 0.49)).not.toThrow();
  });

  it("keeps a run under a token-only limit unaffected", () => {
    const tracker = new BudgetTracker(SHARED);
    for (let i = 0; i < 20; i++) tracker.admit("run_a", 9_999);
    expect(() => { tracker.assertWithin("run_a"); }).not.toThrow();
  });
});

/**
 * B-selfhost-8: a run's own limits. The tracker already partitioned spend by run; these
 * cover the limits, which were shared by every run.
 */
describe("BudgetTracker per-run limits", () => {
  it("enforces the shared limits for a run with none of its own", () => {
    const tracker = new BudgetTracker(SHARED);
    spend(tracker, "run_a", 99);
    expect(() => { tracker.assertWithin("run_a"); }).not.toThrow();
    spend(tracker, "run_a", 1);
    expect(budgetErrorOf(() => { tracker.assertWithin("run_a"); }).details["limit"]).toBe(100);
  });

  it("enforces a registered run's own limit instead of the shared one", () => {
    const tracker = trackerWith({ run_a: { maxRunUsd: null, maxRunTokens: 10, maxTaskTokens: null } });
    spend(tracker, "run_a", 10);
    expect(budgetErrorOf(() => { tracker.assertWithin("run_a"); }).details["limit"]).toBe(10);
  });

  it("leaves every other run on the shared limit", () => {
    const tracker = trackerWith({ run_a: { maxRunUsd: null, maxRunTokens: 10, maxTaskTokens: null } });
    spend(tracker, "run_b", 50);
    expect(() => { tracker.assertWithin("run_b"); }).not.toThrow();
    spend(tracker, "run_b", 50);
    expect(budgetErrorOf(() => { tracker.assertWithin("run_b"); }).details["limit"]).toBe(100);
  });

  it("lets a run raise the shared limit, not only lower it", () => {
    const tracker = trackerWith({ run_a: { maxRunUsd: null, maxRunTokens: 1000, maxTaskTokens: null } });
    spend(tracker, "run_a", 150);
    expect(() => { tracker.assertWithin("run_a"); }).not.toThrow();
    spend(tracker, "run_a", 850);
    expect(budgetErrorOf(() => { tracker.assertWithin("run_a"); }).details["limit"]).toBe(1000);
  });

  it("resolves limits lazily for runs it never registered, and asks once", () => {
    const asked: string[] = [];
    const tracker = new BudgetTracker(SHARED, (runId) => {
      asked.push(runId);
      return runId === "run_a" ? { maxRunUsd: null, maxRunTokens: 10, maxTaskTokens: null } : null;
    });
    spend(tracker, "run_a", 10);
    expect(budgetErrorOf(() => { tracker.assertWithin("run_a"); }).details["limit"]).toBe(10);
    expect(budgetErrorOf(() => { tracker.assertWithin("run_a"); }).details["limit"]).toBe(10);
    expect(asked).toEqual(["run_a"]);
  });

  it("does not cache the absence of a run limit", () => {
    let limits: BudgetLimits | null = null;
    const tracker = new BudgetTracker(SHARED, () => limits);
    spend(tracker, "run_a", 50);
    expect(() => { tracker.assertWithin("run_a"); }).not.toThrow();
    limits = { maxRunUsd: null, maxRunTokens: 10, maxTaskTokens: null };
    expect(budgetErrorOf(() => { tracker.assertWithin("run_a"); }).details["limit"]).toBe(10);
  });

  it("falls back to the shared limits when the resolver has nothing for a run", () => {
    const tracker = new BudgetTracker(SHARED, () => null);
    spend(tracker, "run_b", 100);
    expect(budgetErrorOf(() => { tracker.assertWithin("run_b"); }).details["limit"]).toBe(100);
  });

  it("keeps per-task and USD dimensions independent of the run token override", () => {
    const tracker = trackerWith({ run_a: { maxRunUsd: 1, maxRunTokens: 1000, maxTaskTokens: 5 } });
    spend(tracker, "run_a", 6, 0.1, "task_1");
    expect(budgetErrorOf(() => { tracker.assertWithin("run_a", "task_1"); }).details["budget"]).toBe("task_tokens");
    spend(tracker, "run_a", 0, 0.9);
    expect(budgetErrorOf(() => { tracker.assertWithin("run_a"); }).details["budget"]).toBe("run_usd");
  });

  it("does not let a resolved run limit disturb the shared defaults", () => {
    const tracker = new BudgetTracker(SHARED, () => ({ maxRunUsd: null, maxRunTokens: 1, maxTaskTokens: null }));
    spend(tracker, "run_a", 1);
    expect(budgetErrorOf(() => { tracker.assertWithin("run_a"); }).details["limit"]).toBe(1);
    expect(SHARED).toEqual({ maxRunUsd: null, maxRunTokens: 100, maxTaskTokens: null });
  });
});
