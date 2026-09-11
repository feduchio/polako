import { z } from "zod";

export const ProtocolAppliesToSchema = z.enum([
  "worker",
  "reviewer",
  "evidence",
  "prosecutor",
  "defender",
  "judge",
  "supervisor",
]);
export type ProtocolAppliesTo = z.infer<typeof ProtocolAppliesToSchema>;

export const ProtocolKindSchema = z.enum(["base", "task", "domain", "role"]);
export type ProtocolKind = z.infer<typeof ProtocolKindSchema>;

export const ProtocolFrontmatterSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "name must be lowercase alphanumeric with single hyphens"),
  description: z.string().min(1).max(1024),
  applies_to: z.array(ProtocolAppliesToSchema).min(1),
  kind: ProtocolKindSchema,
  budget_tokens: z.number().int().positive(),
  resources: z.array(z.string().min(1)).default([]),
});
export type ProtocolFrontmatter = z.infer<typeof ProtocolFrontmatterSchema>;

export const TaskProtocolNameSchema = z.enum([
  "bugfix",
  "feature",
  "refactor",
  "simplify",
  "investigate",
]);
export type TaskProtocolName = z.infer<typeof TaskProtocolNameSchema>;

export const BASE_PROTOCOL_NAME = "base-engineering-policy" as const;

export interface LoadedProtocol {
  meta: ProtocolFrontmatter;
  /** Markdown body after frontmatter (instructions only). */
  body: string;
  /** Absolute directory containing SKILL.md. */
  dir: string;
}

export interface ProtocolBundleMember {
  name: string;
  kind: ProtocolKind;
  body: string;
  resources: string[];
  budgetTokens: number;
  dir: string;
}

export interface ProtocolBundle {
  members: ProtocolBundleMember[];
  /** Concatenated SKILL bodies for the prompt (no resource files). */
  promptText: string;
  /** Forensic hash of the composed members. */
  hash: string;
  totalBudgetTokens: number;
}

export interface ComposeInput {
  task: TaskProtocolName;
  /** Domain protocol names (e.g. typescript); sorted by composer. */
  domains?: readonly string[];
  role: string;
}
