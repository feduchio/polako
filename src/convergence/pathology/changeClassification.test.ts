import { describe, expect, it } from "vitest";
import { isRunnableTestPath } from "./changeClassification.js";

describe("runnable regression test paths", () => {
  it("accepts conventional runner-discovered source files", () => {
    for (const path of [
      "test/foo.js",
      "tests/retry.test.ts",
      "src/retry.spec.tsx",
      "pkg/foo_test.go",
      "pkg/test_foo.py",
      "src/test/java/TestFoo.java",
      "src/test/java/FooTest.java",
      "tests/http.rs",
      "__tests__/retry.ts",
    ]) {
      expect(isRunnableTestPath(path), path).toBe(true);
    }
  });

  it("rejects support sources and non-executable test data", () => {
    for (const path of [
      "tests/a.fixture.ts",
      "tests/retry.helper.ts",
      "__tests__/fixtures/data.ts",
      "tests/common/mod.rs",
      "tests/data.ts",
      "tests/retry.snapshot.ts",
      "tests/cases.json",
      "src/retry.ts",
    ]) {
      expect(isRunnableTestPath(path), path).toBe(false);
    }
  });
});
