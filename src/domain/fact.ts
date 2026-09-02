import { z } from "zod";
import { IdSchema, TimestampSchema } from "./common.js";
import { PolishError } from "../shared/errors.js";

export const FactKindSchema = z.enum([
  "architecture",
  "convention",
  "invariant",
  "project_check",
  "behavior",
  "failed_approach",
  "decision",
  "pre_existing_failure",
]);
export type FactKind = z.infer<typeof FactKindSchema>;

/**
 * Provenance typing is the point: an LLM-inferred fact stays a hypothesis until a
 * deterministic evidence event confirms it. Confidence scores never promote a fact.
 */
export const ProvenanceKindSchema = z.enum(["user_stated", "deterministic", "llm_inferred", "verified"]);
export type ProvenanceKind = z.infer<typeof ProvenanceKindSchema>;

export const FactSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  kind: FactKindSchema,
  statement: z.string().min(1),
  provenanceKind: ProvenanceKindSchema,
  /** events that produced/asserted this fact */
  provenanceRefs: z.array(IdSchema).min(1),
  /** deterministic evidence events; required (non-empty) for `verified`, informational otherwise */
  evidenceRefs: z.array(IdSchema),
  /** hypothesis strength reported by the model; never used for promotion */
  confidence: z.number().min(0).max(1).nullable(),
  tags: z.array(z.string()),
  files: z.array(z.string()),
  supersededBy: IdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Fact = z.infer<typeof FactSchema>;

export const FactStrictSchema = FactSchema.superRefine((f, ctx) => {
  if (f.provenanceKind === "verified" && f.evidenceRefs.length === 0) {
    ctx.addIssue({ code: "custom", message: "verified facts require deterministic evidence refs", path: ["evidenceRefs"] });
  }
  if (f.provenanceKind === "deterministic" && f.confidence !== null) {
    ctx.addIssue({ code: "custom", message: "deterministic facts carry no model confidence", path: ["confidence"] });
  }
});

/** The only way an inferred fact becomes verified: attach a deterministic evidence event. */
export function promoteToVerified(fact: Fact, evidenceEventId: string, now: number): Fact {
  if (fact.provenanceKind !== "llm_inferred") {
    throw new PolishError("INVARIANT_VIOLATION", "only llm_inferred facts can be promoted", {
      factId: fact.id,
      provenanceKind: fact.provenanceKind,
    });
  }
  return FactStrictSchema.parse({
    ...fact,
    provenanceKind: "verified",
    evidenceRefs: [...fact.evidenceRefs, evidenceEventId],
    updatedAt: now,
  });
}

/** Facts safe to present as ground truth in prompts. Inferred facts must be labelled as hypotheses. */
export function isGroundTruth(fact: Fact): boolean {
  return fact.provenanceKind === "user_stated" || fact.provenanceKind === "deterministic" || fact.provenanceKind === "verified";
}
