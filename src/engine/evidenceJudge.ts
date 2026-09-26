import { demonstrated, notExamined, refuted, type Evidence } from "../domain/evidence.js";
import { parseTestReport, processEnd, type TestFailure } from "../project/parsers.js";
import type { ProcessResult } from "../sandbox/process.js";

export interface ReproductionJudgeInput {
  framework: string;
  /** The command with the reproduction's files in place. */
  treatment: ProcessResult;
  /** The same command without them; null when there was nothing meaningful to compare with. */
  control: ProcessResult | null;
  /** Paths of the files the reproduction added, relative to the checkout. */
  added: readonly string[];
  /** The command names an added file, so everything it reports is the reproduction's. */
  scoped: boolean;
}

/**
 * Decide what one reproduction execution showed. The exit code is never enough on its own: a
 * defect is demonstrated only by a failing test the runner reports inside the reproduction, whose
 * failure is not the reproduction failing to load, and only when the same command passes without
 * it. A pass refutes only when the reproduction is seen to have run.
 */
export function judgeReproduction(input: ReproductionJudgeInput): Evidence {
  const { treatment, control, added } = input;
  const singleFile = input.scoped;
  const ended = ending(treatment, "reproduction");
  if (ended !== null) return ended;
  if (commandMissing(treatment)) return notExamined("environment", `the reproduction command was not found: ${treatment.argv.join(" ")}`);

  const report = parseTestReport(input.framework, treatment.stdout, treatment.stderr);
  const ownFailure = (failure: TestFailure) => singleFile || added.some((path) => mentions(failure, path));
  const own = report.failures.filter(ownFailure);
  const other = report.failures.filter((failure) => !ownFailure(failure));

  const missing = report.failures.find((failure) => failure.kind === "module_not_found");
  if (missing !== undefined) return notExamined("environment", `a module the reproduction needs is missing: ${missing.message}`);
  const broken = own.find((failure) =>
    (failure.kind === "reference_error" || failure.kind === "syntax_error") && inAddedFile(failure, added, singleFile));
  if (broken !== undefined) {
    return notExamined("reproduction_broken", `the reproduction itself does not run: ${broken.identity}: ${broken.message}`);
  }
  const died = own.find((failure) => failure.kind === "file_failed");
  if (died !== undefined) {
    return notExamined("killed", `the reproduction's test process ended without a result (killed by a signal or exited early): ${died.identity}`);
  }

  if (control !== null) {
    const controlEnded = ending(control, "control run");
    if (controlEnded !== null) return notExamined("control_failed", controlEnded.rationale);
    if (control.exitCode !== 0) {
      return notExamined("control_failed", `the same command already fails without the reproduction (exit ${String(control.exitCode)}), so its failure cannot be attributed`);
    }
  }

  if (treatment.exitCode === 0) {
    if (report.summary === null) {
      return notExamined("unrecognised_runner", "the command passed but printed no test report the engine recognises, so nothing shows the reproduction ran");
    }
    if (!ran(input, report.summary.total)) {
      return notExamined("reproduction_not_executed", `the command passed without running the reproduction (${added.join(", ") || "no added file"})`);
    }
    return refuted(`the engine ran the reproduction and its ${String(report.summary.total)} test(s) passed: the defect is not there`);
  }

  const shown = own.find((failure) => failure.kind === "assertion" || failure.kind === "error" || failure.kind === "reference_error" || failure.kind === "syntax_error");
  if (shown !== undefined) {
    return demonstrated(`the engine ran the reproduction and ${shown.identity} failed: ${shown.message}`);
  }
  if (other.length > 0) {
    return notExamined("failure_outside_reproduction", `a test outside the reproduction failed: ${other[0]?.identity ?? ""}: ${other[0]?.message ?? ""}`);
  }
  return notExamined("unrecognised_runner", `the command exited ${String(treatment.exitCode)} but no failing test was recognised in its output`);
}

function ending(result: ProcessResult, what: string): Evidence | null {
  const end = processEnd(result);
  if (end === "killed") return notExamined("killed", `the ${what} was killed (${result.signal ?? "no exit code"})`);
  if (end === "timeout") return notExamined("timeout", `the ${what} timed out after ${String(result.durationMs)}ms`);
  if (end === "aborted") return notExamined("aborted", `the ${what} was aborted`);
  return null;
}

function commandMissing(result: ProcessResult): boolean {
  return result.exitCode === 127 || /^(?:.*: )?command not found|spawn \S+ ENOENT/m.test(result.stderr);
}

function mentions(failure: TestFailure, path: string): boolean {
  return failure.identity.includes(path) || (failure.location ?? "").includes(path);
}

/** A load error counts against the reproduction only when it is raised in the reproduction's own file. */
function inAddedFile(failure: TestFailure, added: readonly string[], singleFile: boolean): boolean {
  if (failure.location === null) return singleFile || added.some((path) => failure.identity.includes(path));
  return added.some((path) => failure.location?.includes(path) === true);
}

/** Whether the reproduction's tests were among those that ran. */
function ran(input: ReproductionJudgeInput, total: number): boolean {
  if (input.scoped) return total > 0;
  if (input.control === null) return false;
  const before = parseTestReport(input.framework, input.control.stdout, input.control.stderr).summary;
  return before !== null && total > before.total;
}
