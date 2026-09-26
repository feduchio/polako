import { describe, expect, it } from "vitest";
import { testApiDenial } from "./testApiGuard.js";

const JEST_STYLE = 'import { add } from "../src/add.mjs";\ndescribe("add", () => { test("sums", () => { expect(add(1, 2)).toBe(3); }); });\n';
const NODE_TEST = 'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("sums", () => { assert.equal(1 + 2, 3); });\n';
const NAMED = 'const { describe, it } = require("node:test");\ndescribe("x", () => { it("y", () => {}); });\n';

describe("testApiDenial", () => {
  it("refuses a Jest-style test file in a node:test project, naming the missing bindings", () => {
    const denial = testApiDenial("node-test", "tests/neg.test.mjs", JEST_STYLE);
    expect(denial).toMatch(/calls describe, test, expect without importing them/);
    expect(denial).toMatch(/there is no expect/);
  });

  it("refuses an import of vitest or jest in a node:test project", () => {
    expect(testApiDenial("node-test", "src/__tests__/a.test.ts", 'import { test, expect } from "vitest";\n')).toMatch(/imports vitest or jest/);
  });

  it("admits node:test files, non-test files and other frameworks", () => {
    expect(testApiDenial("node-test", "tests/neg.test.mjs", NODE_TEST)).toBeNull();
    expect(testApiDenial("node-test", "tests/named.test.cjs", NAMED)).toBeNull();
    expect(testApiDenial("node-test", "src/add.mjs", JEST_STYLE)).toBeNull();
    expect(testApiDenial("vitest", "tests/a.test.ts", JEST_STYLE)).toBeNull();
    expect(testApiDenial(undefined, "tests/a.test.ts", JEST_STYLE)).toBeNull();
  });
});
