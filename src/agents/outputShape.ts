import { parseTestReport } from "../domain/testReport.js";

export interface ShapedOutput {
  text: string;
  /** Set when lines were left out of `text`; the whole output is then kept by reference. */
  folded: string | null;
}

/** A line that only says a test or suite passed or started. */
const PASS_LINE = /^\s*(?:✔|✓|√|▶ |ok \d+ - |PASS\s)/;
const MIN_FOLD_RUN = 3;
const MAX_FAILURES_LISTED = 20;
const HEAD_LINES = 60;
const TAIL_LINES = 60;

/**
 * What a worker is shown of a command's output. A test run leads with what the runner reported —
 * counts and each failing test with its kind — and folds runs of passing-test lines into a count,
 * keeping every other line verbatim. Other long output keeps its head and its tail, where a
 * failure summary is printed. Nothing is lost: the caller keeps the whole output by reference.
 * (After oh-my-pi's shell minimizer, which has no node:test filter.)
 */
export function shapeCommandOutput(text: string, framework: string): ShapedOutput {
  const lines = text.split("\n");
  const report = parseTestReport(framework, text, "");
  if (report.summary !== null || report.failures.length > 0) {
    const header: string[] = [];
    if (report.summary !== null) {
      const { total, passed, failed, skipped } = report.summary;
      header.push(`[test report] tests ${String(total)}, passed ${String(passed)}, failed ${String(failed)}, skipped ${String(skipped)}`);
    }
    for (const failure of report.failures.slice(0, MAX_FAILURES_LISTED)) {
      header.push(`[failing] ${failure.identity} (${failure.kind}): ${failure.message}`);
    }
    if (report.failures.length > MAX_FAILURES_LISTED) header.push(`[failing] … and ${String(report.failures.length - MAX_FAILURES_LISTED)} more`);
    const { body, foldedLines } = foldPasses(lines);
    if (foldedLines === 0) return { text: [...header, "", text].join("\n"), folded: null };
    return { text: [...header, "", ...body].join("\n"), folded: `${String(foldedLines)} passing-test lines folded` };
  }
  if (lines.length > HEAD_LINES + TAIL_LINES + 20) {
    const omitted = lines.length - HEAD_LINES - TAIL_LINES;
    return {
      text: [...lines.slice(0, HEAD_LINES), `… ${String(omitted)} lines omitted …`, ...lines.slice(-TAIL_LINES)].join("\n"),
      folded: `${String(omitted)} middle lines omitted`,
    };
  }
  return { text, folded: null };
}

function foldPasses(lines: readonly string[]): { body: string[]; foldedLines: number } {
  const body: string[] = [];
  let run = 0;
  let folded = 0;
  const flush = (index: number) => {
    if (run >= MIN_FOLD_RUN) {
      body.push(`  … ${String(run)} passing lines …`);
      folded += run;
    } else {
      body.push(...lines.slice(index - run, index));
    }
    run = 0;
  };
  lines.forEach((line, index) => {
    if (PASS_LINE.test(line)) {
      run += 1;
      return;
    }
    flush(index);
    body.push(line);
  });
  flush(lines.length);
  return { body, foldedLines: folded };
}
