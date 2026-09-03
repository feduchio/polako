import type { BaselineSnapshot, CheckResult, RegressionDelta } from "../domain/checks.js";
import { compareToBaseline } from "../domain/checks.js";

export interface CandidateMetrics {
  candidateId: string;
  filesChanged: number;
  linesChanged: number;
  insertions: number;
  deletions: number;
  checksPassed: number;
  checksTotal: number;
  newFailures: number;
  newFailureKeys: string[];
}

export interface VerifiableCandidate {
  id: string;
  diffSummary: { files: number; insertions: number; deletions: number };
  gateResult: {
    checks: CheckResult[];
    regression: RegressionDelta;
    passed: boolean;
  } | null;
}

/** Produce a stable, scalar-free summary of deterministic gate evidence. */
export function candidateMetrics(candidate: VerifiableCandidate, baseline: BaselineSnapshot): CandidateMetrics {
  const checks = candidate.gateResult?.checks ?? [];
  const regression = candidate.gateResult?.regression ?? compareToBaseline(baseline, checks);
  const newFailureKeys = regressionFailureKeys(regression);
  return {
    candidateId: candidate.id,
    filesChanged: candidate.diffSummary.files,
    linesChanged: candidate.diffSummary.insertions + candidate.diffSummary.deletions,
    insertions: candidate.diffSummary.insertions,
    deletions: candidate.diffSummary.deletions,
    checksPassed: checks.filter((check) => check.status === "pass").length,
    checksTotal: checks.length,
    newFailures: newFailureKeys.length,
    newFailureKeys,
  };
}

function regressionFailureKeys(delta: RegressionDelta): string[] {
  return [
    ...delta.newlyFailing.map((key) => `test:${key}`),
    ...delta.newlyFailingChecks.map((name) => `check:new:${name}`),
    ...delta.degradedChecks.map((name) => `check:degraded:${name}`),
    ...delta.missing.map((detail) => `missing:${detail}`),
    ...delta.diagnosticChanges.map((name) => `diagnostic:${name}`),
  ].sort();
}
