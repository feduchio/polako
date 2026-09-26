import type { CheckStatus, TestSummary } from "./checks.js";

/** Parse test runner output into a summary. Framework-specific heuristics only — gates use counts, not trust. */
export function parseTestOutput(framework: string, stdout: string, stderr: string): TestSummary | null {
  const text = `${stdout}\n${stderr}`;
  if (framework === "vitest") return parseVitest(text) ?? parseNodeTest(text) ?? parseGenericPassed(text);
  if (framework === "jest") return parseJest(text) ?? parseNodeTest(text) ?? parseGenericPassed(text);
  return parseNodeTest(text) ?? parseGenericPassed(text);
}

function parseVitest(text: string): TestSummary | null {
  const passedFirst = /Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+failed)?(?:\s*\|\s*(\d+)\s+skipped)?(?:\s*\((\d+)\))?/i.exec(text);
  if (passedFirst) {
    const passed = Number(passedFirst[1]);
    const failed = passedFirst[2] ? Number(passedFirst[2]) : 0;
    const skipped = passedFirst[3] ? Number(passedFirst[3]) : 0;
    const total = passedFirst[4] ? Number(passedFirst[4]) : passed + failed + skipped;
    const failingTests = parseVitestFailingTests(text);
    return { total, passed, failed, skipped, failingTests };
  }
  const failedFirst = /Tests\s+(\d+)\s+failed(?:\s*\|\s*(\d+)\s+passed)?(?:\s*\|\s*(\d+)\s+skipped)?(?:\s*\((\d+)\))?/i.exec(text);
  if (failedFirst) {
    const failed = Number(failedFirst[1]);
    const passed = failedFirst[2] ? Number(failedFirst[2]) : 0;
    const skipped = failedFirst[3] ? Number(failedFirst[3]) : 0;
    const total = failedFirst[4] ? Number(failedFirst[4]) : passed + failed + skipped;
    const failingTests = parseVitestFailingTests(text);
    return { total, passed, failed, skipped, failingTests };
  }
  return null;
}

function parseVitestFailingTests(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (name: string): void => {
    if (name === "" || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };
  for (const match of text.matchAll(/(?:FAIL|×)\s+(\S+\.(?:test|spec)\.\w+)(?:\s+>\s+([^\n]+))?/g)) {
    const file = match[1] ?? "unknown";
    add(file);
    const rest = match[2]?.trim().replace(/\s+\d+ms$/i, "");
    if (rest) add(`${file} > ${rest}`);
  }
  return names;
}

function parseJest(text: string): TestSummary | null {
  const m = /Tests:\s+(?:(\d+)\s+failed,\s*)?(?:(\d+)\s+skipped,\s*)?(?:(\d+)\s+passed,\s*)?(\d+)\s+total/i.exec(text);
  if (!m) return null;
  const failed = m[1] ? Number(m[1]) : 0;
  const skipped = m[2] ? Number(m[2]) : 0;
  const passed = m[3] ? Number(m[3]) : 0;
  const total = Number(m[4]);
  const failingTests = [...text.matchAll(/●\s+(.+)/g)].map((x) => x[1]?.trim() ?? "unknown");
  return { total, passed, failed, skipped, failingTests };
}

/** Node `node --test` TAP (npm default) and spec reporter. */
export function parseNodeTest(text: string): TestSummary | null {
  return parseNodeTap(text) ?? parseNodeSpec(text);
}

function parseNodeTap(text: string): TestSummary | null {
  const looksLikeTap =
    /TAP version\s+\d+/i.test(text) ||
    /(?:^|\n)# tests\s+\d+/.test(text) ||
    /(?:^|\n)[ \t]*not ok\s+\d+\s+-/.test(text);
  if (!looksLikeTap) return null;
  const total = hashCount(text, "tests");
  const passed = hashCount(text, "pass");
  const failed = hashCount(text, "fail");
  const skipped = hashCount(text, "skipped") ?? hashCount(text, "skip") ?? 0;
  const failingTests = tapFailingTests(text);
  if (total === null && passed === null && failed === null && failingTests.length === 0) return null;
  const resolvedPassed = passed ?? 0;
  const resolvedFailed = failed ?? failingTests.length;
  const resolvedTotal = total ?? resolvedPassed + resolvedFailed + skipped;
  return {
    total: resolvedTotal,
    passed: resolvedPassed,
    failed: resolvedFailed,
    skipped,
    failingTests,
  };
}

function hashCount(text: string, key: string): number | null {
  const match = new RegExp(`(?:^|\\n)# ${key}\\s+(\\d+)`).exec(text);
  return match ? Number(match[1]) : null;
}

function tapFailingTests(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const re = /^[ \t]*not ok\s+\d+\s+-\s+(.+)$/gm;
  for (const match of text.matchAll(re)) {
    const name = (match[1] ?? "").trim();
    if (name === "") continue;
    const yaml = tapYamlAfter(text, match.index, match[0].length);
    if (/type:\s*['"]suite['"]/.test(yaml) || /failureType:\s*['"]subtestsFailed['"]/.test(yaml) || /\d+\s+subtest failed/i.test(yaml)) {
      continue;
    }
    const location = /location:\s*['"]([^'"]+)['"]/.exec(yaml)?.[1];
    const identity = location === undefined ? name : `${projectRelativeLocation(location)} > ${name}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    names.push(identity);
  }
  return names;
}

function tapYamlAfter(text: string, matchIndex: number, matchLength: number): string {
  const rest = text.slice(matchIndex + matchLength);
  const end = rest.search(/\n[ \t]*(?:ok|not ok)\s+\d+|\n[ \t]*1\.\.\d+/);
  return (end === -1 ? rest : rest.slice(0, end)).slice(0, 1200);
}

function parseNodeSpec(text: string): TestSummary | null {
  const combined = /(?:^|\n)ℹ\s+tests\s+(\d+)\s*\/\s*pass\s+(\d+)\s*\/\s*fail\s+(\d+)/.exec(text);
  const tests = combined ? Number(combined[1]) : specInfoCount(text, "tests");
  const passed = combined ? Number(combined[2]) : specInfoCount(text, "pass");
  const failed = combined ? Number(combined[3]) : specInfoCount(text, "fail");
  const skipped = specInfoCount(text, "skipped") ?? 0;
  const failingTests = specFailingTests(text);
  if (tests === null && passed === null && failed === null && failingTests.length === 0) return null;
  const resolvedPassed = passed ?? 0;
  const resolvedFailed = failed ?? failingTests.length;
  const resolvedTotal = tests ?? resolvedPassed + resolvedFailed + skipped;
  return {
    total: resolvedTotal,
    passed: resolvedPassed,
    failed: resolvedFailed,
    skipped,
    failingTests,
  };
}

function specInfoCount(text: string, key: string): number | null {
  const match = new RegExp(`(?:^|\\n)ℹ\\s+${key}\\s+(\\d+)`).exec(text);
  return match ? Number(match[1]) : null;
}

function specFailingTests(text: string): string[] {
  const suites = new Set([...text.matchAll(/^▶\s+(.+)$/gm)].map((match) => (match[1] ?? "").trim()));
  const titles: string[] = [];
  const seenTitles = new Set<string>();
  for (const match of text.matchAll(/^✖\s+(.+)$/gm)) {
    const raw = (match[1] ?? "").trim().replace(/\s+\([\d.]+m?s\)$/i, "");
    if (raw === "" || raw === "failing tests:" || suites.has(raw) || seenTitles.has(raw)) continue;
    seenTitles.add(raw);
    titles.push(raw);
  }
  const locations = [...text.matchAll(/^test at\s+(\S+)/gm)].map((match) => projectRelativeLocation(match[1] ?? ""));
  if (titles.length === 0 && locations.length === 0) return [];
  if (titles.length === 1 && locations.length === 1) {
    return [`${locations[0]} > ${titles[0]}`];
  }
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (name: string): void => {
    if (name === "" || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };
  for (let index = 0; index < Math.max(titles.length, locations.length); index++) {
    const title = titles[index];
    const location = locations[index];
    if (title !== undefined && location !== undefined) add(`${location} > ${title}`);
    else if (title !== undefined) add(title);
    else if (location !== undefined) add(location);
  }
  return names;
}

/** Relativize a node:test location to tests/src/lib when present. */
export function projectRelativeLocation(location: string): string {
  const stripped = location.replace(/^file:\/\//, "");
  const nested = /(?:^|\/)((?:tests|src|lib|test)\/\S+\.(?:mjs|cjs|js|ts|mts|cts):\d+(?::\d+)?)/.exec(stripped);
  if (nested?.[1] !== undefined) return nested[1];
  const file = /([^/\\]+\.(?:mjs|cjs|js|ts|mts|cts):\d+(?::\d+)?)$/.exec(stripped);
  return file?.[1] ?? stripped;
}

function parseGenericPassed(text: string): TestSummary | null {
  const m = /(\d+)\s+passed(?:.*?(\d+)\s+failed)?/i.exec(text);
  if (!m) return null;
  const passed = Number(m[1]);
  const failed = m[2] ? Number(m[2]) : 0;
  const failing = [...text.matchAll(/FAIL\s+(\S+)/g)].map((x) => x[1] ?? "unknown");
  return { total: passed + failed, passed, failed, skipped: 0, failingTests: failing };
}

/**
 * What stopped a failing test. `assertion` is the only kind that says the code under test behaved
 * differently from what the test expected; the others say the test could not ask.
 */
export type FailureKind = "assertion" | "reference_error" | "syntax_error" | "module_not_found" | "error" | "file_failed";

export interface TestFailure {
  /** `location > title` for a test, the file itself for a file that failed to load. */
  identity: string;
  kind: FailureKind;
  /** The error line as printed, e.g. `ReferenceError: test is not defined`. */
  message: string;
  /** Top stack frame outside the runner and node_modules, `path:line:col` without `file://`. */
  location: string | null;
}

export interface TestReport {
  summary: TestSummary | null;
  failures: TestFailure[];
}

/** Summary plus one classified entry per failing test or file, from node:test (spec), vitest or jest output. */
export function parseTestReport(framework: string, stdout: string, stderr: string): TestReport {
  const text = stripAnsi(`${stdout}\n${stderr}`);
  const extractors = framework === "vitest"
    ? [vitestFailures, jestFailures, nodeSpecFailures]
    : framework === "jest"
      ? [jestFailures, vitestFailures, nodeSpecFailures]
      : [nodeSpecFailures, vitestFailures, jestFailures];
  let failures: TestFailure[] = [];
  for (const extract of extractors) {
    failures = extract(text);
    if (failures.length > 0) break;
  }
  return { summary: parseTestOutput(framework, stdout, stderr), failures };
}

/** How a test process ended, independent of what it printed. */
export type ProcessEnd = "exited" | "killed" | "timeout" | "aborted";

export function processEnd(result: { exitCode: number | null; signal: string | null; timedOut: boolean; aborted: boolean }): ProcessEnd {
  if (result.aborted) return "aborted";
  if (result.timedOut) return "timeout";
  if (result.signal !== null || result.exitCode === null) return "killed";
  return "exited";
}

const ERROR_LINE = /^\s*(?:(AssertionError|ReferenceError|SyntaxError|[A-Z]\w*Error)(?:\s*\[(\w+)\])?:\s*(.*)|(expect\(.*\)\..*))$/;

function classify(lines: readonly string[]): { kind: FailureKind; message: string } | null {
  for (const raw of lines) {
    const line = raw.trim();
    if (/ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)\b/.test(line)) return { kind: "module_not_found", message: line };
    const match = ERROR_LINE.exec(line);
    if (match === null) continue;
    if (match[4] !== undefined || match[2] === "ERR_ASSERTION" || match[1] === "AssertionError") return { kind: "assertion", message: line };
    if (match[1] === "ReferenceError") return { kind: "reference_error", message: line };
    if (match[1] === "SyntaxError") return { kind: "syntax_error", message: line };
    return { kind: "error", message: line };
  }
  return null;
}

function topFrame(lines: readonly string[]): string | null {
  for (const raw of lines) {
    const line = raw.trim();
    const frame = /^at (?:.*\()?((?:file:\/\/)?[^\s()]+:\d+:\d+)\)?$/.exec(line)?.[1] ?? /^❯ (?:\S+ )?(\S+:\d+:\d+)$/.exec(line)?.[1];
    if (frame === undefined || frame.startsWith("node:") || frame.includes("node_modules/")) continue;
    return frame.replace(/^file:\/\//, "");
  }
  return null;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

function nodeSpecFailures(text: string): TestFailure[] {
  const start = text.search(/^✖ failing tests:$/m);
  if (start === -1) return [];
  const lines = text.slice(start).split("\n").slice(1);
  const failures: TestFailure[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const at = /^test at (\S+)/.exec(lines[i] ?? "");
    if (at === null) continue;
    const title = /^✖ (.+?)(?:\s+\([\d.]+m?s\))?$/.exec(lines[i + 1] ?? "")?.[1]?.trim() ?? "";
    let end = i + 2;
    while (end < lines.length && !/^\S/.test(lines[end] ?? "")) end += 1;
    const body = lines.slice(i + 2, end);
    const location = projectRelativeLocation(at[1] ?? "");
    const loadFailure = body.every((line) => line.trim() === "" || line.trim() === "'test failed'");
    const cause = loadFailure ? uncaughtErrorFor(text, title) : null;
    // A file whose process ended with no error printed was killed or exited on its own; the spec
    // reporter keeps neither the signal nor the exit code.
    const classified = cause ?? (loadFailure
      ? { kind: "file_failed" as const, message: "the test file's process ended without reporting a result" }
      : classify(body) ?? { kind: "error" as const, message: body.find((line) => line.trim() !== "")?.trim() ?? "test failed" });
    failures.push({
      identity: loadFailure ? title : `${location} > ${title}`,
      kind: classified.kind,
      message: classified.message,
      location: loadFailure ? (cause?.location ?? null) : topFrame(body),
    });
    i = end - 1;
  }
  return failures;
}

/** node:test reports a file that threw while loading as a test named after the file; the error itself is printed elsewhere. */
function uncaughtErrorFor(text: string, file: string): { kind: FailureKind; message: string; location: string | null } | null {
  const name = file.split("/").at(-1) ?? file;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const classified = classify([lines[i] ?? ""]);
    if (classified === null) continue;
    const window = lines.slice(Math.max(0, i - 5), i + 4);
    if (!window.some((line) => line.includes(name))) continue;
    return { ...classified, location: topFrame(lines.slice(i + 1, i + 12)) };
  }
  return null;
}

function vitestFailures(text: string): TestFailure[] {
  const lines = text.split("\n");
  const failures: TestFailure[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const head = /^\s*FAIL\s+(.+?)\s*$/.exec(lines[i] ?? "");
    if (head === null) continue;
    let end = i + 1;
    while (end < lines.length && !/^\s*(?:FAIL\s|⎯|Test Files\s)/.test(lines[end] ?? "")) end += 1;
    const body = lines.slice(i + 1, end);
    const classified = classify(body);
    if (classified === null) continue;
    failures.push({ identity: (head[1] ?? "").replace(/\s*\[.*\]$/, ""), ...classified, location: topFrame(body) });
    i = end - 1;
  }
  return failures;
}

function jestFailures(text: string): TestFailure[] {
  const lines = text.split("\n");
  const failures: TestFailure[] = [];
  let file = "";
  for (let i = 0; i < lines.length; i += 1) {
    const suite = /^\s*FAIL\s+(\S+)/.exec(lines[i] ?? "");
    if (suite !== null) {
      file = suite[1] ?? "";
      continue;
    }
    const head = /^\s*●\s+(.+?)\s*$/.exec(lines[i] ?? "");
    if (head === null) continue;
    let end = i + 1;
    while (end < lines.length && !/^\s*(?:●\s|FAIL\s|PASS\s|Test Suites:)/.test(lines[end] ?? "")) end += 1;
    const body = lines.slice(i + 1, end);
    const classified = classify(body) ?? { kind: "error" as const, message: head[1] ?? "" };
    const title = head[1] ?? "";
    failures.push({ identity: title === "Test suite failed to run" ? file : `${file} > ${title}`, ...classified, location: topFrame(body) });
    i = end - 1;
  }
  return failures;
}

export function statusFromProcess(timedOut: boolean, aborted: boolean, exitCode: number | null): CheckStatus {
  if (aborted) return "skipped";
  if (timedOut) return "timeout";
  if (exitCode === 0) return "pass";
  if (exitCode === null) return "error";
  return "fail";
}
