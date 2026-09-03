import { z } from "zod";
import { canonicalJson, sha256Hex } from "../shared/hash.js";
import { ArtifactRefSchema, GitHashSchema, IdSchema, Sha256Schema, TimestampSchema } from "./common.js";

export const CheckKindSchema = z.enum(["test", "typecheck", "lint", "build", "custom", "regression"]);
export type CheckKind = z.infer<typeof CheckKindSchema>;

export const CheckDefinitionSchema = z.object({
  name: z.string().min(1),
  kind: CheckKindSchema,
  command: z.array(z.string().min(1)).min(1),
  cwd: z.string().optional(),
  mandatory: z.boolean(),
  timeoutMs: z.number().int().positive().optional(),
});
export type CheckDefinition = z.infer<typeof CheckDefinitionSchema>;

export const CheckStatusSchema = z.enum(["pass", "fail", "error", "timeout", "skipped"]);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const TestSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failingTests: z.array(z.string()),
});
export type TestSummary = z.infer<typeof TestSummarySchema>;

export const CheckResultSchema = z.object({
  name: z.string().min(1),
  kind: CheckKindSchema,
  status: CheckStatusSchema,
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  summary: TestSummarySchema.nullable(),
  outputRef: ArtifactRefSchema.nullable(),
  /** Deterministic digest of failure diagnostics when available. */
  failureFingerprint: Sha256Schema.optional(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

/** Persistable evidence that repeated observations of the same baseline contradicted. */
export const BaselineFlakinessSchema = z.object({
  kind: z.literal("baseline_flakiness"),
  checkNames: z.array(z.string().min(1)),
  observations: z.array(z.array(CheckResultSchema)).min(2),
  signatures: z.array(Sha256Schema).min(2),
  confirmationRuns: z.number().int().nonnegative(),
});
export type BaselineFlakiness = z.infer<typeof BaselineFlakinessSchema>;

/**
 * Snapshot of the project on the base commit before any change. Regression is always
 * measured relative to this: pre-existing failures are facts, not candidate regressions.
 */
export const BaselineSnapshotSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  commitHash: GitHashSchema,
  checks: z.array(CheckResultSchema),
  /** relative path -> sha256 of check configs and manifests that gates must see unchanged */
  configHashes: z.record(z.string(), Sha256Schema),
  /** sha256 of the check-related scripts block (e.g. package.json scripts) */
  scriptsHash: Sha256Schema,
  toolchain: z.record(z.string(), z.string()),
  createdAt: TimestampSchema,
});
export type BaselineSnapshot = z.infer<typeof BaselineSnapshotSchema>;

/** Collision-free identity for a failing test: (check name, test name) as a JSON tuple. */
export function testKey(checkName: string, testName: string): string {
  return JSON.stringify([checkName, testName]);
}

export function baselineFailingTests(baseline: BaselineSnapshot): Set<string> {
  const out = new Set<string>();
  for (const c of baseline.checks) for (const t of c.summary?.failingTests ?? []) out.add(testKey(c.name, t));
  return out;
}

/** Higher is healthier. `skipped` sits below `pass`: a check that used to run and now does not is a degradation. */
const CHECK_RANK: Record<CheckStatus, number> = { pass: 4, fail: 2, skipped: 1, error: 0, timeout: 0 };

export function checkDegraded(before: CheckStatus, after: CheckStatus): boolean {
  return CHECK_RANK[after] < CHECK_RANK[before];
}

export interface RegressionDelta {
  /** tests that pass on baseline but fail on the candidate */
  newlyFailing: string[];
  /** newly introduced checks that do not pass */
  newlyFailingChecks: string[];
  /** tests failing on baseline that now pass */
  newlyPassing: string[];
  /** tests present on baseline but absent from the candidate run (possible silencing) */
  missing: string[];
  /** checks whose status degraded (pass -> fail/error/timeout) */
  degradedChecks: string[];
  /** non-passing checks whose deterministic diagnostics changed */
  diagnosticChanges: string[];
}

export function compareToBaseline(baseline: BaselineSnapshot, candidate: CheckResult[]): RegressionDelta {
  const baseFailing = baselineFailingTests(baseline);
  const candFailing = new Set<string>();
  const degradedChecks: string[] = [];
  const diagnosticChanges: string[] = [];
  const candByName = new Map(candidate.map((c) => [c.name, c] as const));
  const baseByName = new Map(baseline.checks.map((c) => [c.name, c] as const));

  for (const c of candidate) for (const t of c.summary?.failingTests ?? []) candFailing.add(testKey(c.name, t));

  for (const b of baseline.checks) {
    const c = candByName.get(b.name);
    if (!c) {
      degradedChecks.push(b.name);
      continue;
    }
    if (checkDegraded(b.status, c.status)) degradedChecks.push(b.name);
    if (b.status !== "pass" && c.status !== "pass") {
      // Legacy baselines without a fingerprint cannot be compared; fail closed and
      // require recapture rather than treating an opaque FAIL→FAIL as unchanged.
      if (b.failureFingerprint === undefined || c.failureFingerprint === undefined) {
        diagnosticChanges.push(b.name);
      } else if (b.failureFingerprint !== c.failureFingerprint) {
        diagnosticChanges.push(b.name);
      }
    }
  }

  const missing: string[] = [];
  for (const b of baseline.checks) {
    const c = candByName.get(b.name);
    if (!c) continue;
    if (b.summary && !c.summary) {
      missing.push(`${b.name}: test summary omitted (baseline had ${b.summary.total} tests)`);
    } else if (b.summary && c.summary && c.summary.total < b.summary.total) {
      missing.push(`${b.name}: ${b.summary.total - c.summary.total} fewer tests than baseline`);
    }
  }

  return {
    newlyFailing: [...candFailing].filter((t) => !baseFailing.has(t)).sort(),
    newlyFailingChecks: candidate
      .filter((check) => !baseByName.has(check.name) && check.status !== "pass")
      .map((check) => check.name)
      .sort(),
    newlyPassing: [...baseFailing].filter((t) => !candFailing.has(t)).sort(),
    missing,
    degradedChecks,
    diagnosticChanges,
  };
}

export function hasRegression(delta: RegressionDelta): boolean {
  return (
    delta.newlyFailing.length > 0 ||
    delta.newlyFailingChecks.length > 0 ||
    delta.degradedChecks.length > 0 ||
    delta.missing.length > 0 ||
    delta.diagnosticChanges.length > 0
  );
}

const LOCATION_PARENS = /\(\d+,\d+\)/g;
const LOCATION_COLON = /:\d+:\d+\b/g;
const LOCATION_LEADING = /(^|\s)\d+:\d+\b/g;
const LOCATION_LINE_WORD = /\bline\s+\d+\b/gi;

/** Strip volatile source locations so an unchanged diagnostic survives line-number shifts. */
export function stripDiagnosticLocations(line: string): string {
  return line
    .replace(LOCATION_PARENS, "(<loc>)")
    .replace(LOCATION_COLON, ":<loc>")
    .replace(LOCATION_LEADING, "$1<loc>")
    .replace(LOCATION_LINE_WORD, "line <n>");
}

function isTestCountSummary(line: string): boolean {
  return /^(?:Test(?:s| Files?)\s+\d|\d+\s+(?:passed|failed|skipped|total)\b)/i.test(line.trim());
}

export interface FailureFingerprintInput {
  kind: CheckKind;
  status: CheckStatus;
  exitCode: number | null;
  summary: TestSummary | null;
  diagnostics: readonly string[];
}

/**
 * Kind-aware canonical payload for a non-passing check. Test fingerprints ignore
 * aggregate pass counts (padding must not look like a new failure); typecheck/lint
 * fingerprints ignore line/column shifts but still see new diagnostic text.
 */
export function failureFingerprintPayload(input: FailureFingerprintInput): unknown {
  if (input.kind === "test" || input.kind === "regression") {
    return {
      kind: input.kind,
      status: input.status,
      failingTests: [...(input.summary?.failingTests ?? [])].sort(),
      diagnostics: input.diagnostics.filter((line) => !isTestCountSummary(line)).map(stripDiagnosticLocations),
    };
  }
  return {
    kind: input.kind,
    status: input.status,
    diagnostics: input.diagnostics.map(stripDiagnosticLocations),
  };
}

export function computeFailureFingerprint(input: FailureFingerprintInput): string {
  return sha256Hex(canonicalJson(failureFingerprintPayload(input)));
}
