import assert from "node:assert/strict";
import { RetryFetcher } from "../src/retryFetch.mjs";

let calls = 0;
const fetcher = new RetryFetcher(async () => {
  calls += 1;
  if (calls === 1) throw new Error("transient");
  return "ok";
}, 2);

assert.equal(await fetcher.fetch("/runtime-check"), "ok");
assert.equal(calls, 2);
