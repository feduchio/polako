import { z } from "zod";
import { assertTransition, type TransitionTable } from "./fsm.js";
import { ActorSchema, ArtifactRefSchema, FileRefSchema, GitHashSchema, IdSchema, SeveritySchema, TimestampSchema } from "./common.js";
import { sha256Hex } from "../shared/hash.js";

export const ReviewAxisSchema = z.enum([
  "correctness",
  "spec_compliance",
  "regression",
  "adversarial",
  "architecture",
  "simplicity",
  "security",
  "performance",
]);
export type ReviewAxis = z.infer<typeof ReviewAxisSchema>;

export const FindingStatusSchema = z.enum([
  "RAW",
  "DUPLICATE",
  "NOTED",
  "VALIDATING",
  "VALID",
  "REJECTED",
  "UNCERTAIN",
  "RESOLVED",
]);
export type FindingStatus = z.infer<typeof FindingStatusSchema>;

export const FINDING_TABLE: TransitionTable<FindingStatus> = {
  initial: "RAW",
  states: FindingStatusSchema.options,
  terminal: ["DUPLICATE", "NOTED", "REJECTED", "RESOLVED"],
  edges: {
    RAW: ["DUPLICATE", "NOTED", "VALIDATING"],
    VALIDATING: ["VALID", "REJECTED", "UNCERTAIN"],
    UNCERTAIN: ["VALIDATING", "REJECTED", "NOTED"],
    VALID: ["RESOLVED", "VALIDATING"],
    DUPLICATE: [],
    NOTED: [],
    REJECTED: [],
    RESOLVED: [],
  },
};

/** The check the debate path, the validator, and validation persistence all go through. */
export function commitFindingStatus(from: FindingStatus, to: FindingStatus, findingId: string): void {
  if (from === to) return;
  assertTransition(FINDING_TABLE, `finding ${findingId}`, from, to);
}

/** Structured claim produced by a reviewer. Opinions without evidence become NOTED, not work. */
export const RawFindingSchema = z.object({
  criterion: z.string().min(1),
  severity: SeveritySchema,
  /** does this block convergence if valid? */
  blocking: z.boolean(),
  claim: z.string().min(1),
  evidence: z.array(FileRefSchema),
  reproduction: z.array(z.string().min(1)),
  suggestedCheck: z.string().optional(),
});
export type RawFinding = z.infer<typeof RawFindingSchema>;

export const FindingSchema = RawFindingSchema.extend({
  id: IdSchema,
  runId: IdSchema,
  /** code state the finding was raised against */
  checkpointHash: GitHashSchema,
  axis: ReviewAxisSchema,
  reportedBy: ActorSchema,
  status: FindingStatusSchema,
  duplicateOf: IdSchema.nullable(),
  fingerprint: z.string().min(1),
  investigationRounds: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Finding = z.infer<typeof FindingSchema>;

const STOP_WORDS = new Set(["the", "a", "an", "is", "are", "of", "to", "in", "on", "and", "or", "when", "after", "that", "this", "it"]);

/**
 * Stable fingerprint for dedupe and oscillation detection: criterion + touched files
 * (without lines) + salient claim tokens. Deliberately coarse.
 */
export function findingFingerprint(raw: Pick<RawFinding, "criterion" | "claim" | "evidence">): string {
  const files = [...new Set(raw.evidence.map((e) => e.path))].sort();
  const tokens = raw.claim
    .toLowerCase()
    .replace(/[^a-z0-9_./-\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t))
    .sort();
  const salient = [...new Set(tokens)].slice(0, 12);
  return sha256Hex(JSON.stringify({ c: raw.criterion.toLowerCase(), f: files, t: salient })).slice(0, 24);
}

export const ValidationMethodSchema = z.enum([
  "deterministic_reproduction",
  "failing_test",
  "static_proof",
  "independent_reviewer_agreement",
  "adversarial_verification",
  "llm_verifier",
  "runtime_evidence",
  "investigation",
  "finding_debate",
]);
export type ValidationMethod = z.infer<typeof ValidationMethodSchema>;

export const ValidationVerdictSchema = z.enum(["VALID", "REJECTED", "UNCERTAIN"]);
export type ValidationVerdict = z.infer<typeof ValidationVerdictSchema>;

export const FindingValidationSchema = z.object({
  id: IdSchema,
  findingId: IdSchema,
  runId: IdSchema,
  method: ValidationMethodSchema,
  verdict: ValidationVerdictSchema,
  rationale: z.string().min(1),
  /** every verdict must point at what was actually executed or inspected */
  evidenceRefs: z.array(ArtifactRefSchema),
  performedBy: ActorSchema,
  createdAt: TimestampSchema,
});
export type FindingValidation = z.infer<typeof FindingValidationSchema>;

/** A VALID verdict must be backed by at least one evidence artifact. */
export const FindingValidationStrictSchema = FindingValidationSchema.refine(
  (v) => v.verdict !== "VALID" || v.evidenceRefs.length > 0,
  { message: "VALID verdict requires evidence artifacts", path: ["evidenceRefs"] },
);

export function findingStatusFromVerdict(verdict: ValidationVerdict): FindingStatus {
  switch (verdict) {
    case "VALID":
      return "VALID";
    case "REJECTED":
      return "REJECTED";
    case "UNCERTAIN":
      return "UNCERTAIN";
  }
}
