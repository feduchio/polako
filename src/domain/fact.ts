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

/** Event kinds whose payload is produced by deterministic or independently validated work. */
export const FACT_PROMOTION_EVIDENCE_TYPES = [
  "shell.command",
  "candidate.gated",
  "baseline.snapshotted",
  "finding.validated",
  "acceptance.recorded",
] as const;
export type FactPromotionEvidenceType = (typeof FACT_PROMOTION_EVIDENCE_TYPES)[number];

export function isFactPromotionEvidenceType(type: string): type is FactPromotionEvidenceType {
  return (FACT_PROMOTION_EVIDENCE_TYPES as readonly string[]).includes(type);
}

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
    provenanceRefs: [...new Set([...fact.provenanceRefs, evidenceEventId])],
    evidenceRefs: [...new Set([...fact.evidenceRefs, evidenceEventId])],
    updatedAt: now,
  });
}

/** Higher rank means stronger evidence and therefore wins semantic consolidation. */
export function provenanceStrength(kind: ProvenanceKind): number {
  switch (kind) {
    case "verified":
      return 3;
    case "deterministic":
    case "user_stated":
      return 2;
    case "llm_inferred":
      return 1;
  }
}

/** Facts safe to present as ground truth in prompts. Inferred facts must be labelled as hypotheses. */
export function isGroundTruth(fact: Fact): boolean {
  return fact.provenanceKind === "user_stated" || fact.provenanceKind === "deterministic" || fact.provenanceKind === "verified";
}

export interface FactEvidenceLookup {
  get(id: string): { runId: string; type: string } | null;
}

/** Verified facts may only cite existing, same-run, allowlisted evidence events. */
export function assertVerifiedFactEvidence(
  fact: Pick<Fact, "runId" | "provenanceKind" | "evidenceRefs">,
  events: FactEvidenceLookup,
): void {
  if (fact.provenanceKind !== "verified") return;
  if (fact.evidenceRefs.length === 0) {
    throw new PolishError("INVARIANT_VIOLATION", "verified facts require deterministic evidence refs", { factRunId: fact.runId });
  }
  for (const ref of fact.evidenceRefs) {
    const evidence = events.get(ref);
    if (!evidence) {
      throw new PolishError("INVARIANT_VIOLATION", "verified fact cites nonexistent evidence event", { evidenceRef: ref });
    }
    if (evidence.runId !== fact.runId) {
      throw new PolishError("INVARIANT_VIOLATION", "verified fact cites cross-run evidence event", { evidenceRef: ref, factRunId: fact.runId });
    }
    if (!isFactPromotionEvidenceType(evidence.type)) {
      throw new PolishError("INVARIANT_VIOLATION", "verified fact cites non-allowlisted evidence event", {
        evidenceRef: ref,
        evidenceType: evidence.type,
      });
    }
  }
}

/** Keep only evidence refs that survive verified-fact validation rules. */
export function filterVerifiedEvidenceRefs(
  runId: string,
  refs: readonly string[],
  events: FactEvidenceLookup,
): string[] {
  const kept: string[] = [];
  for (const ref of refs) {
    const evidence = events.get(ref);
    if (evidence?.runId === runId && isFactPromotionEvidenceType(evidence.type)) kept.push(ref);
  }
  return [...new Set(kept)].sort();
}

/** Keep only provenance refs that still resolve to a same-run event. */
export function filterResolvableProvenanceRefs(
  runId: string,
  refs: readonly string[],
  events: FactEvidenceLookup,
): string[] {
  const kept: string[] = [];
  for (const ref of refs) {
    if (events.get(ref)?.runId === runId) kept.push(ref);
  }
  return [...new Set(kept)].sort();
}
