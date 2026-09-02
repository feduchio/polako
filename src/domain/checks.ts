import { z } from "zod";
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
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

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
  /** tests failing on baseline that now pass */
  newlyPassing: string[];
  /** tests present on baseline but absent from the candidate run (possible silencing) */
  missing: string[];
  /** checks whose status degraded (pass -> fail/error/timeout) */
  degradedChecks: string[];
}

export function compareToBaseline(baseline: BaselineSnapshot, candidate: CheckResult[]): RegressionDelta {
  const baseFailing = baselineFailingTests(baseline);
  const candFailing = new Set<string>();
  const degradedChecks: string[] = [];
  const candByName = new Map(candidate.map((c) => [c.name, c] as const));

  for (const c of candidate) for (const t of c.summary?.failingTests ?? []) candFailing.add(testKey(c.name, t));

  for (const b of baseline.checks) {
    const c = candByName.get(b.name);
    if (!c) {
      degradedChecks.push(b.name);
      continue;
    }
    if (checkDegraded(b.status, c.status)) degradedChecks.push(b.name);
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
    newlyPassing: [...baseFailing].filter((t) => !candFailing.has(t)).sort(),
    missing,
    degradedChecks,
  };
}

export function hasRegression(delta: RegressionDelta): boolean {
  return delta.newlyFailing.length > 0 || delta.degradedChecks.length > 0 || delta.missing.length > 0;
}
