import { z } from "zod";
import { posix } from "node:path";
import { IdSchema, Sha256Schema, TimestampSchema } from "./common.js";

/**
 * Artifacts a candidate is judged by. Stored outside any worktree
 * (`~/.polish/runs/<run>/acceptance/`), injected at gate time, hash-verified.
 * A candidate that modifies any of these paths inside its worktree fails gates.
 */
export const AcceptanceArtifactKindSchema = z.enum(["regression_test", "check_config", "check_scripts", "baseline_manifest"]);

export const AcceptanceArtifactSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  taskId: IdSchema.nullable(),
  kind: AcceptanceArtifactKindSchema,
  /** path relative to the project root where the artifact is injected / must stay unchanged */
  relativePath: z.string().min(1),
  sha256: Sha256Schema,
  /** the finding/requirement this artifact provides evidence for, if any */
  evidenceFor: IdSchema.nullable(),
  createdAt: TimestampSchema,
});
export type AcceptanceArtifact = z.infer<typeof AcceptanceArtifactSchema>;

/** Generalized mission evidence: scenario definitions and their executed evidence are distinct. */
export const CorpusEntryKindSchema = z.enum([
  "regression_test",
  "check_config",
  "check_scripts",
  "baseline_manifest",
  "runtime_scenario",
  "runtime_evidence",
]);
export type CorpusEntryKind = z.infer<typeof CorpusEntryKindSchema>;

export const RuntimeEvidenceSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  scenarioId: z.string().min(1),
  validator: z.string().min(1),
  kind: z.enum(["node_script", "http_smoke", "browser"]),
  status: z.enum(["passed", "failed", "unavailable", "skipped"]),
  summary: z.string().min(1),
  observations: z.record(z.string(), z.unknown()),
  /** Runtime validation is read-only unless the caller explicitly opts into a broader policy. */
  sideEffects: z.object({
    policy: z.enum(["safe", "explicit"]),
    destructiveExternalEffectsAllowed: z.boolean(),
  }),
  artifactHashes: z.array(Sha256Schema),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema,
});
export type RuntimeEvidence = z.infer<typeof RuntimeEvidenceSchema>;

export const CorpusEntrySchema = z.object({
  id: IdSchema,
  missionId: IdSchema,
  sourceRunId: IdSchema,
  requirementRef: z.string().min(1),
  kind: CorpusEntryKindSchema,
  summary: z.string().min(1),
  /** Existing causal evidence events. */
  evidenceRefs: z.array(IdSchema),
  artifactHashes: z.array(Sha256Schema),
  metadata: z.record(z.string(), z.unknown()),
  runtimeEvidence: RuntimeEvidenceSchema.optional(),
  createdAt: TimestampSchema,
});
export type CorpusEntry = z.infer<typeof CorpusEntrySchema>;

export const MissionAcceptanceCorpusSchema = z.object({
  missionId: IdSchema,
  entries: z.array(CorpusEntrySchema),
});
export type MissionAcceptanceCorpus = z.infer<typeof MissionAcceptanceCorpusSchema>;

/**
 * Canonical identity used when comparing git paths with persisted artifact paths.
 * Persisted histories may contain harmless aliases such as `./tests/x.ts`; comparison must
 * not let those aliases bypass protected-path detection before materialization.
 */
export function normalizeAcceptancePath(path: string): string {
  return posix.normalize(path.replaceAll("\\", "/")).replace(/^\.\/+/, "");
}

/** Paths a candidate may not modify: everything covered by acceptance artifacts. */
export function protectedPaths(artifacts: readonly AcceptanceArtifact[]): Set<string> {
  return new Set(artifacts.map((a) => normalizeAcceptancePath(a.relativePath)));
}
