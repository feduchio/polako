import { z } from "zod";

export const IdSchema = z.string().regex(/^[a-z]+_[0-9a-hjkmnp-tv-z]{22}$/, "opaque time-sortable id");
export type Id = z.infer<typeof IdSchema>;

export const TimestampSchema = z.number().int().nonnegative();

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const GitHashSchema = z.string().regex(/^[0-9a-f]{7,64}$/);

export const ModelRefSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

export function modelRefKey(ref: ModelRef): string {
  return `${ref.provider}:${ref.model}`;
}

export const ActorKindSchema = z.enum([
  "system",
  "user",
  "supervisor",
  "worker",
  "reviewer",
  "verifier",
  "evidence_agent",
  "defender",
  "scout",
]);
export type ActorKind = z.infer<typeof ActorKindSchema>;

export const ActorSchema = z.object({
  kind: ActorKindSchema,
  role: z.string().optional(),
  model: ModelRefSchema.optional(),
});
export type Actor = z.infer<typeof ActorSchema>;

export const SYSTEM_ACTOR: Actor = { kind: "system" };

export const SeveritySchema = z.enum(["critical", "high", "medium", "low", "info"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low", "info"];

export const FileRefSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
});
export type FileRef = z.infer<typeof FileRefSchema>;

export const ArtifactRefSchema = z.object({
  sha256: Sha256Schema,
  kind: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  label: z.string().optional(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
