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
