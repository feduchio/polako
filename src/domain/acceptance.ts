import { z } from "zod";
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

/** Paths a candidate may not modify: everything covered by acceptance artifacts. */
export function protectedPaths(artifacts: readonly AcceptanceArtifact[]): Set<string> {
  return new Set(artifacts.map((a) => a.relativePath));
}
