import type { CheckStatus, TestSummary } from "../domain/checks.js";

/** Parse test runner output into a summary. Framework-specific heuristics only — gates use counts, not trust. */
export function parseTestOutput(framework: string, stdout: string, stderr: string): TestSummary | null {
  const text = `${stdout}\n${stderr}`;
  if (framework === "vitest") return parseVitest(text);
  if (framework === "jest") return parseJest(text);
  const m = /(\d+)\s+passed(?:.*?(\d+)\s+failed)?/i.exec(text);
  if (m) {
    const passed = Number(m[1]);
    const failed = m[2] ? Number(m[2]) : 0;
    const failing = [...text.matchAll(/FAIL\s+(\S+)/g)].map((x) => x[1] ?? "unknown");
    return { total: passed + failed, passed, failed, skipped: 0, failingTests: failing };
  }
  return null;
}

function parseVitest(text: string): TestSummary | null {
  const files = /Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+failed)?(?:\s*\|\s*(\d+)\s+skipped)?/i.exec(text);
  if (files) {
    const passed = Number(files[1]);
    const failed = files[2] ? Number(files[2]) : 0;
    const skipped = files[3] ? Number(files[3]) : 0;
    const failingTests = [...text.matchAll(/FAIL\s+.*?(\S+\.test\.\w+)/g)].map((m) => m[1] ?? "unknown");
    return { total: passed + failed + skipped, passed, failed, skipped, failingTests };
  }
  return null;
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

export function statusFromProcess(timedOut: boolean, aborted: boolean, exitCode: number | null): CheckStatus {
  if (aborted) return "skipped";
  if (timedOut) return "timeout";
  if (exitCode === 0) return "pass";
  if (exitCode === null) return "error";
  return "fail";
}
