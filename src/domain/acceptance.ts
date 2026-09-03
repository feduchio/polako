import { z } from "zod";
import { posix } from "node:path";
import { GitHashSchema, IdSchema, Sha256Schema, TimestampSchema } from "./common.js";

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

export const RuntimeCapabilityClassSchema = z.enum([
  "AVAILABLE_SAFE",
  "AVAILABLE_UNSAFE",
  "UNAVAILABLE",
  "NOT_APPLICABLE",
]);
export type RuntimeCapabilityClass = z.infer<typeof RuntimeCapabilityClassSchema>;

export const RuntimeValidationModeSchema = z.enum(["auto", "required", "off"]);
export type RuntimeValidationMode = z.infer<typeof RuntimeValidationModeSchema>;

export const RuntimeEvidenceSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  scenarioId: z.string().min(1),
  validator: z.string().min(1),
  kind: z.enum(["node_script", "http_smoke", "browser"]),
  status: z.enum(["passed", "failed", "unavailable", "skipped"]),
  summary: z.string().min(1),
  observations: z.record(z.string(), z.unknown()),
  /** Commit the scenario actually executed against. Stale evidence cannot satisfy DONE. */
  checkpointHash: GitHashSchema,
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

/** True when evidence belongs to a different checkpoint than the one under consideration. */
export function isStaleRuntimeEvidence(evidence: RuntimeEvidence, checkpointHash: string): boolean {
  return evidence.checkpointHash !== checkpointHash;
}

/**
 * Whether DONE is allowed given runtime mode and evidence for the *final* checkpoint.
 * Evidence whose checkpointHash differs from `finalCheckpointHash` is stale and never
 * satisfies DONE (including auto skip/unavailable records from an earlier checkpoint).
 * `null` means "no runtime attempt at this checkpoint" and is allowed only in `auto`/`off`.
 */
export function runtimeAllowsDone(
  mode: RuntimeValidationMode,
  evidence: RuntimeEvidence | null,
  finalCheckpointHash: string,
): boolean {
  if (mode === "off") return true;
  if (evidence !== null && evidence.checkpointHash !== finalCheckpointHash) return false;
  if (mode === "auto") {
    if (evidence === null) return true;
    if (evidence.status === "skipped" || evidence.status === "unavailable") return true;
    return evidence.status === "passed";
  }
  return evidence !== null && evidence.status === "passed";
}

/**
 * Corpus-level DONE gate. Stale evidence (wrong checkpoint) always blocks when present.
 * `requiredScenarioIds` must each have `passed` evidence at `finalCheckpointHash` when
 * mode is `required`. In `auto`, a failed current-checkpoint run blocks; missing runs do not.
 */
export function runtimeCorpusAllowsDone(
  mode: RuntimeValidationMode,
  evidences: readonly RuntimeEvidence[],
  finalCheckpointHash: string,
  requiredScenarioIds: readonly string[] = [],
): boolean {
  if (mode === "off") return true;
  if (evidences.some((e) => e.checkpointHash !== finalCheckpointHash)) return false;
  const current = evidences.filter((e) => e.checkpointHash === finalCheckpointHash);
  if (mode === "auto") {
    return !current.some((e) => e.status === "failed");
  }
  return requiredScenarioIds.every((id) => current.some((e) => e.scenarioId === id && e.status === "passed"));
}

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
