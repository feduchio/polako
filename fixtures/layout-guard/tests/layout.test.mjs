import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test from "node:test";

test("tests/ holds only the registered suites", () => {
  assert.deepEqual(readdirSync(new URL(".", import.meta.url)).sort(), ["add.test.mjs", "layout.test.mjs"]);
});
