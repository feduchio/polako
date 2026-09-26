import { testFileOperandDenial } from "../sandbox/allowlist.js";

const TEST_GLOBALS = ["describe", "it", "test", "expect", "beforeEach", "afterEach", "beforeAll", "afterAll"] as const;
const FOREIGN_RUNNERS = /from\s+["'](?:vitest|@jest\/globals|jest)["']|require\(\s*["'](?:vitest|@jest\/globals|jest)["']\s*\)/;

/**
 * Why `content` would not run under the project's test runner, or null. Only for test files in a
 * node:test project: workers write Jest-style files there (`test(...)`, `expect(...)` as globals),
 * which fail to load with `ReferenceError` and prove nothing. Refusing the write says so before the
 * file lands, instead of after a whole suite run (oh-my-pi's stream rules, applied to tool input).
 */
export function testApiDenial(framework: string | undefined, path: string, content: string): string | null {
  if (framework !== "node-test" || testFileOperandDenial(path) !== null) return null;
  if (FOREIGN_RUNNERS.test(content)) {
    return `${path} imports vitest or jest, but this project runs its tests with node:test. ` +
      'Use `import test from "node:test"` (or `import { describe, it } from "node:test"`) and `import assert from "node:assert/strict"`.';
  }
  const unbound = TEST_GLOBALS.filter((name) => called(content, name) && !bound(content, name));
  if (unbound.length === 0) return null;
  return `${path} calls ${unbound.join(", ")} without importing them, and this project runs its tests with node:test, which has no globals: ` +
    `the file would fail with ReferenceError before any test runs. Import them from "node:test" ` +
    `(${unbound.includes("expect") ? 'there is no expect; use `import assert from "node:assert/strict"` and assert.equal/assert.deepEqual' : 'e.g. `import { describe, it } from "node:test"`'}).`;
}

function called(content: string, name: string): boolean {
  return new RegExp(`(?:^|[^.\\w$])${name}\\s*\\(`, "m").test(content);
}

function bound(content: string, name: string): boolean {
  return new RegExp(
    `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from|import\\s+${name}\\s*(?:,|from)|` +
      `\\b(?:const|let|var)\\s*(?:\\{[^}]*\\b${name}\\b[^}]*\\}|${name})\\s*=|function\\s+${name}\\b`,
  ).test(content);
}
