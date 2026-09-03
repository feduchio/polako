import { z } from "zod";

/**
 * User-configurable strategies and defaults. Nothing here is an architectural invariant:
 * these are tunables (see ADR-0001 "Invariants vs. configurable strategy").
 */

export const LaneLimitsSchema = z.object({
  /** concurrent worker shells (agent tool loops running commands) */
  "local.shell": z.number().int().min(1).default(6),
  "local.test": z.number().int().min(1).default(2),
  "local.build": z.number().int().min(1).default(1),
  /** serial integration queue — must stay 1; exposed for tests only */
  integration: z.literal(1).default(1),
  /** runtime scenario executions — serial so fixture processes cannot overlap */
  "local.runtime": z.literal(1).default(1),
  supervisor: z.number().int().min(1).default(2),
  verifier: z.number().int().min(1).default(2),
  /** default per-provider LLM concurrency when the provider does not advertise limits */
  "llm.default": z.number().int().min(1).default(8),
});
export type LaneLimits = z.infer<typeof LaneLimitsSchema>;

export const RetryPolicySchema = z.object({
  /** attempts 1..freshWorkerAttempts use a fresh worker with progressively more failure context */
  freshWorkerAttempts: z.number().int().min(1).default(3),
  /** from this attempt on, escalate to a model one tier above */
  escalateTierFromAttempt: z.number().int().min(2).default(4),
  /** after this many attempts the task becomes BLOCKED and goes to the supervisor */
  maxAttempts: z.number().int().min(1).default(5),
});

export const CandidateStrategySchema = z.object({
  trivial: z.number().int().min(1).default(1),
  normal: z.number().int().min(1).default(2),
  complex: z.number().int().min(1).default(3),
});

export const ReviewStrategySchema = z.object({
  reviewersPerRound: z.number().int().min(1).default(3),
  /** soft preference: rotate ensembles/axes between clean rounds when equally qualified models exist */
  rotateEnsembles: z.boolean().default(true),
  /** models below this observed-quality threshold are never picked just for novelty */
  minQualityForRotation: z.number().min(0).max(1).default(0.6),
});

export const ConvergenceStrategySchema = z.object({
  requiredCleanRounds: z.number().int().min(1).default(3),
  /** bounded investigation rounds for a single UNCERTAIN finding before NEEDS_HUMAN */
  maxInvestigationRoundsPerFinding: z.number().int().min(0).default(2),
  /** consecutive attempts without evidence improvement before strategy change */
  noProgressAttempts: z.number().int().min(1).default(3),
});

export const VerifierStrategySchema = z.object({
  backend: z.enum(["ts", "sidecar"]).default("ts"),
  /** score granularity (letter tokens); default follows LLM-as-a-Verifier findings */
  granularity: z.number().int().min(2).max(26).default(20),
  /** repeated evaluations per pair */
  repeats: z.number().int().min(1).default(2),
  criteria: z.array(z.string()).default(["specification", "output", "errors", "regression", "scope"]),
  /** use pivot tournament when candidates exceed this count */
  pivotTournamentFrom: z.number().int().min(3).default(4),
});

export const ContextBudgetSchema = z.object({
  /** fraction of the model context window reserved for the worker context pack */
  workerPackFraction: z.number().min(0.05).max(0.9).default(0.4),
  /** fraction reserved for supervisor views */
  supervisorViewFraction: z.number().min(0.05).max(0.9).default(0.5),
  /** hard cap in tokens regardless of window size */
  maxPackTokens: z.number().int().min(1000).default(60_000),
});

export const BudgetSchema = z.object({
  maxRunUsd: z.number().min(0).nullable().default(null),
  maxRunTokens: z.number().int().min(0).nullable().default(null),
  maxTaskTokens: z.number().int().min(0).nullable().default(null),
  maxRunWallClockMinutes: z.number().int().min(1).nullable().default(null),
});

export const RuntimeValidationConfigSchema = z.object({
  mode: z.enum(["auto", "required", "off"]).default("auto"),
  level: z.enum(["smoke", "affected", "full"]).default("smoke"),
});
export type RuntimeValidationConfig = z.infer<typeof RuntimeValidationConfigSchema>;

export const SandboxConfigSchema = z.object({
  backend: z.enum(["worktree", "sandbox-exec", "container"]).default("worktree"),
  commandTimeoutMs: z.number().int().min(1000).default(15 * 60_000),
  maxOutputBytes: z.number().int().min(1024).default(2 * 1024 * 1024),
  /** worker may run arbitrary commands (beyond the project profile allowlist) */
  allowArbitraryCommands: z.boolean().default(false),
  envAllowlist: z.array(z.string()).default(["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM", "SHELL", "USER"]),
  envDenyPatterns: z
    .array(z.string())
    .default(["_API_KEY$", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "^AWS_", "^GH_", "^GITHUB_", "^OPENAI", "^GEMINI", "^GOOGLE", "^GROQ", "^OPENROUTER"]),
});

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

export const SupervisorRoleConfigSchema = z.object({
  role: z.enum(["planner", "scope_guardian", "adversarial_auditor", "judge"]),
  /** provider/model reference as configured by the user, e.g. "gemini:gemini-3.8-flash" */
  model: z.string().min(1),
});

export const ProviderConfigSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["openrouter", "gemini", "groq", "scripted", "record-replay", "cursor-agent"]),
  enabled: z.boolean().default(true),
  /** env var name holding the key in secrets.env; never the key itself */
  apiKeyEnv: z.string().optional(),
  baseUrl: z.url().optional(),
  concurrency: z.number().int().min(1).optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const PolishConfigSchema = z.object({
  home: z.string().default("~/.polish"),
  lanes: LaneLimitsSchema.prefault({}),
  retry: RetryPolicySchema.prefault({}),
  candidates: CandidateStrategySchema.prefault({}),
  review: ReviewStrategySchema.prefault({}),
  convergence: ConvergenceStrategySchema.prefault({}),
  verifier: VerifierStrategySchema.prefault({}),
  contextBudget: ContextBudgetSchema.prefault({}),
  budget: BudgetSchema.prefault({}),
  sandbox: SandboxConfigSchema.prefault({}),
  runtimeValidation: RuntimeValidationConfigSchema.prefault({}),
  supervisors: z.array(SupervisorRoleConfigSchema).default([]),
  providers: z.array(ProviderConfigSchema).default([]),
});
export type PolishConfig = z.infer<typeof PolishConfigSchema>;

export function defaultConfig(): PolishConfig {
  return PolishConfigSchema.parse({});
}
