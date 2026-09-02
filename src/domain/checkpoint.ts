import { z } from "zod";
import { CheckStatusSchema } from "./checks.js";
import { GitHashSchema, IdSchema, SEVERITY_ORDER, SeveritySchema, TimestampSchema } from "./common.js";

/**
 * Evidence vector attached to every checkpoint. Comparison is a partial order (dominance),
 * never a scalar score: a checkpoint dominates another only if it is at least as good on
 * every axis and strictly better on at least one.
 */
export const EvidenceVectorSchema = z.object({
  gates: z.record(z.string(), CheckStatusSchema),
  testsPassed: z.number().int().nonnegative(),
  testsFailed: z.number().int().nonnegative(),
  testsTotal: z.number().int().nonnegative(),
  /** validated, still-open findings by severity for this code state */
  openValidatedFindings: z.record(SeveritySchema, z.number().int().nonnegative()),
  /** relative to baseline; smaller is preferable, ties are fine */
  diffLinesFromBaseline: z.number().int().nonnegative(),
});
export type EvidenceVector = z.infer<typeof EvidenceVectorSchema>;

export const CheckpointSourceSchema = z.enum(["baseline", "integration", "simplification", "rollback"]);

export const CheckpointSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  seq: z.number().int().nonnegative(),
  commitHash: GitHashSchema,
  parentId: IdSchema.nullable(),
  source: CheckpointSourceSchema,
  /** task whose integration produced this checkpoint, if any */
  taskId: IdSchema.nullable(),
  evidence: EvidenceVectorSchema,
  createdAt: TimestampSchema,
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

const GATE_RANK: Record<z.infer<typeof CheckStatusSchema>, number> = {
  pass: 3,
  skipped: 2,
  fail: 1,
  error: 0,
  timeout: 0,
};

type Cmp = -1 | 0 | 1;

function cmpNum(a: number, b: number): Cmp {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Per-axis comparison: 1 means `a` is better than `b` on that axis. */
export function compareAxes(a: EvidenceVector, b: EvidenceVector): Cmp[] {
  const axes: Cmp[] = [];
  const gateNames = new Set([...Object.keys(a.gates), ...Object.keys(b.gates)]);
  for (const g of [...gateNames].sort()) {
    const ra = GATE_RANK[a.gates[g] ?? "error"];
    const rb = GATE_RANK[b.gates[g] ?? "error"];
    axes.push(cmpNum(ra, rb));
  }
  axes.push(cmpNum(a.testsPassed, b.testsPassed));
  axes.push(cmpNum(b.testsFailed, a.testsFailed));
  for (const sev of SEVERITY_ORDER) {
    if (sev === "info") continue;
    axes.push(cmpNum(b.openValidatedFindings[sev], a.openValidatedFindings[sev]));
  }
  return axes;
}

/** Strict dominance: better-or-equal on all axes and strictly better on at least one. */
export function dominates(a: EvidenceVector, b: EvidenceVector): boolean {
  const axes = compareAxes(a, b);
  return axes.every((c) => c >= 0) && axes.some((c) => c > 0);
}

export function equivalentEvidence(a: EvidenceVector, b: EvidenceVector): boolean {
  return compareAxes(a, b).every((c) => c === 0);
}

export function emptyFindingCounts(): Record<z.infer<typeof SeveritySchema>, number> {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}
