import assert from "node:assert/strict";
import test from "node:test";
import { add } from "../src/add.mjs";

test("add already sums", () => {
  assert.equal(add(1, 1), 2);
});
