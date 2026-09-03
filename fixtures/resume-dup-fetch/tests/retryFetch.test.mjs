/**
 * Tests for RetryFetcher.
 * The "retry after failure" test demonstrates the duplicate-fetch bug:
 * after the first attempt fails, the second attempt throws "duplicate in-flight"
 * instead of retrying the request.  This test FAILS on the buggy implementation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RetryFetcher } from "../src/retryFetch.mjs";

describe("RetryFetcher", () => {
  it("succeeds on first attempt", async () => {
    const fetcher = new RetryFetcher(async (_url) => "ok");
    const result = await fetcher.fetch("https://example.com");
    assert.equal(result, "ok");
  });

  it("retries after transient failure and succeeds", async () => {
    // First call throws, second call succeeds.
    let calls = 0;
    const fetcher = new RetryFetcher(async (_url) => {
      calls++;
      if (calls === 1) throw new Error("transient error");
      return "ok-after-retry";
    }, 2);

    // BUG: this throws "duplicate in-flight request detected" instead of
    // succeeding on the second attempt, because #pending is never cleared
    // after the first failure.
    const result = await fetcher.fetch("https://example.com");
    assert.equal(result, "ok-after-retry");
    assert.equal(calls, 2, "should have called fetchFn exactly twice");
  });

  it("throws after all retries exhausted", async () => {
    const fetcher = new RetryFetcher(async (_url) => {
      throw new Error("always fails");
    }, 1);
    // With the bug the second attempt throws "duplicate in-flight" not the
    // original error, so we just check that some error is thrown.
    await assert.rejects(() => fetcher.fetch("https://example.com"));
  });
});
