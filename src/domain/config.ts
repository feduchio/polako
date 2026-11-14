import { z } from "zod";
import { BRAND } from "../shared/brand.js";

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

export const ExecutionStrategySchema = z.object({
  /**
   * Coding tasks whose dependencies are settled that EXECUTING runs at once. Integration stays
   * serial; a task whose change no longer applies on the moved head retries from the new head.
   */
  maxParallelTasks: z.number().int().min(1).default(2),
});
export type ExecutionStrategy = z.infer<typeof ExecutionStrategySchema>;

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
  /**
   * Failed executions one axis may accumulate in one round before the run stops and asks for a
   * human. Without a bound the driver returns `waiting` after every provider failure and the
   * scheduler calls it again: one recorded run burned 2,402 executions on one axis in one round,
   * 2,300 of them rate-limited.
   */
  maxAxisAttemptsPerRound: z.number().int().min(1).default(6),
  /**
   * How long a reviewer that answered 429 on this checkpoint stays out of the pool. The exclusion
   * used to end only when that model completed a review, which it could not do while excluded, so
   * a round whose one remaining family was rate-limited waited forever. Its retries after the
   * cooldown count toward `maxAxisAttemptsPerRound`.
   */
  rateLimitCooldownMs: z.number().int().min(0).default(60_000),
  /**
   * Fresh review rounds on the same checkpoint after the reviewers behind a clean round fail the
   * seeded-defect canary. The failed models stay out of review for the rest of the run, and their
   * round never counts; once these are used up the run asks a human to replace the reviewers.
   */
  maxCanaryRotations: z.number().int().min(0).default(2),
  /**
   * Skip the `adversarial` axis in a round where every already-completed axis returned no findings.
   * `adversarial` is 64.4% of every token this tool has spent (`docs/ledger/g1-baseline.md`), and it
   * runs last, so the earlier axes' verdicts are known when it is reached.
   *
   * Default `false`: `docs/PLAN.md` §1 forbids enabling a cost-reducing behaviour by default while
   * the quality gate is not `pass`. Flip it in its own commit when P2.2 passes.
   */
  skipAdversarialWhenClean: z.boolean().default(false),
  /**
   * Hard cap on a reviewer's generated tokens. A tail guard, not a saving: observed completions are
   * 435-1,107 tokens, so 1500 does not bind in the observed range. The prompt route does not work --
   * a clause demanding terseness made output rise, 315->349 and 719->895.
   *
   * 1500 = 3x the ~115-token rendered size of one finding, times a 4-finding allowance. An estimate.
   */
  maxOutputTokens: z.number().int().min(1).default(1500),
  /**
   * When fewer model lineages than the round needs are available besides the author's, let the
   * author's own lineage (even the same model) review in isolation instead of stopping for a human.
   * The review is then `same-model-isolated`, the report says so, and convergence additionally
   * requires passing deterministic gates (docs/LOCAL.md §c). Off by default; the local profile turns it on.
   */
  sameModelFallback: z.boolean().default(false),
  /**
   * Reviewers must audit every test or check the diff adds, changes or removes — would it fail if
   * the feature were broken? — and a `no` blocks (docs/LOCAL.md). Off by default; the local
   * profile turns it on.
   */
  falsifiabilityAudit: z.boolean().default(false),
  /** Sampling temperature of an isolated review; the normal reviewers use 0, so this one differs. */
  isolatedTemperature: z.number().min(0).max(2).default(0.7),
});

export const ConvergenceStrategySchema = z.object({
  requiredCleanRounds: z.number().int().min(1).default(3),
  /** bounded investigation rounds for a single UNCERTAIN finding before NEEDS_HUMAN */
  maxInvestigationRoundsPerFinding: z.number().int().min(0).default(2),
  /** bounded Prosecutor/Defender/Judge rounds for a single UNCERTAIN finding */
  maxDebateRounds: z.number().int().min(1).default(2),
  /** consecutive attempts without evidence improvement before strategy change */
  noProgressAttempts: z.number().int().min(2).default(3),
  /** sliding-window sizes; a detector is silent until its full window exists */
  findingOscillationWindow: evenWindowSize(4).default(4),
  checkpointOscillationWindow: evenWindowSize(4).default(4),
  disagreementWindow: z.number().int().min(2).default(2),
  taskGrowthWindow: z.number().int().min(2).default(3),
  testOnlyCheckpointWindow: z.number().int().min(3).default(3),
  /** persisted CHANGE_ENSEMBLE cap per pathology kind */
  maxEnsembleChangesPerPathology: z.number().int().min(1).default(1),
});
export type ConvergenceStrategy = z.infer<typeof ConvergenceStrategySchema>;

/** Oscillation windows must be even so A,B,A,B can fire; odd sizes would stay silent. */
function evenWindowSize(min: number) {
  return z
    .number()
    .int()
    .min(min)
    .refine((value) => value % 2 === 0, { message: `must be an even integer >= ${min}` });
}

export const VerifierStrategySchema = z.object({
  backend: z.string().transform((value, ctx): "ts" | "empirical" => {
    if (value === "sidecar") {
      ctx.addIssue({ code: "custom", message: 'verifier.backend "sidecar" was removed; use "empirical" or "ts"' });
      return z.NEVER;
    }
    if (value !== "ts" && value !== "empirical") {
      ctx.addIssue({ code: "custom", message: 'verifier.backend must be "empirical" or "ts"' });
      return z.NEVER;
    }
    return value;
  }).default("empirical"),
  /** score granularity (letter tokens); default follows LLM-as-a-Verifier findings */
  granularity: z.number().int().min(2).max(26).default(20),
  /** repeated evaluations per pair */
  repeats: z.number().int().min(1).default(2),
  empiricalRepeats: z.number().int().min(4).multipleOf(4).default(4),
  empiricalPivots: z.literal(2).default(2),
  maxEmpiricalCalls: z.number().int().min(1).max(48).default(48),
  maxEmpiricalInputTokens: z.number().int().min(1).max(192_000).default(192_000),
  maxVerifierDiffTokens: z.number().int().min(1).max(2_000).default(2_000),
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
  /** Tokens one worker attempt may spend, summed over its turns; null is no cap (owner E, 2026-09-26). */
  maxAttemptTokens: z.number().int().min(0).nullable().default(null),
  /** Earlier name of `maxAttemptTokens`, read when that is unset. */
  maxTaskTokens: z.number().int().min(0).nullable().default(null),
  maxRunWallClockMinutes: z.number().int().min(1).nullable().default(null),
});

export const DiscoveryConfigSchema = z.object({
  /** max non-pinned models to actively probe per provider during discovery */
  maxProbesPerProvider: z.number().int().min(1).default(8),
  /** generation budget for each capability probe call */
  probeMaxTokens: z.number().int().min(32).default(256),
});
export type DiscoveryConfig = z.infer<typeof DiscoveryConfigSchema>;

export const AgentConfigSchema = z.object({
  /** max tool-loop turns per worker invocation (not task retry attempts) */
  maxTurns: z.number().int().min(1).default(32),
  progressEnabled: z.boolean().default(true),
  /** A second model of another family notes each worker turn. Off until the live tier shows it pays. */
  advisor: z.boolean().default(false),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/**
 * Dynamic worker/reviewer/verifier routing cost gate (Phase B, not C2/C8).
 * Default free_only: both advertised input and output prices must be explicitly 0.
 * Unknown/null pricing is not free. Pinned supervisors bypass this via explicit model refs.
 */
export const RoutingConfigSchema = z.object({
  costEligibility: z.enum(["free_only", "ceiling", "unrestricted"]).default("free_only"),
  /** Used when costEligibility = "ceiling". 0/0 is equivalent to free_only. */
  maxInputCostPerM: z.number().nonnegative().default(0),
  maxOutputCostPerM: z.number().nonnegative().default(0),
  /**
   * Send `reasoning: { effort: "none", exclude: true }` on worker and council calls.
   *
   * The accepted 4.2x reviewer result is transport efficiency, not a quality claim, and it was
   * measured on reviewers only; P1.5 measures whether the saving exists at these two sites rather
   * than extrapolating. Default `false` -- today neither site sets the field at all, and
   * `docs/PLAN.md` §1 forbids enabling a cost-reducing behaviour by default while the quality gate
   * is not `pass`.
   *
   * Reviewers (`src/review/swarm.ts`) and the progress tracker disable reasoning unconditionally
   * and are deliberately not routed through this flag.
   */
  disableReasoning: z.boolean().default(false),
});
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;

export const AuditionTaskConfigSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  expected: z.string().optional(),
});
export type AuditionTaskConfig = z.infer<typeof AuditionTaskConfigSchema>;

/** Small explicit default micro-tasks. Used only when audition is enabled with micro-tasks. */
export const DEFAULT_AUDITION_TASKS: AuditionTaskConfig[] = [
  { id: "echo-ok", prompt: "Reply with exactly: ok", expected: "ok" },
  { id: "add-two", prompt: "Reply with exactly: 2", expected: "2" },
  { id: "say-yes", prompt: "Reply with exactly: yes", expected: "yes" },
];

export const AuditionConfigSchema = z.object({
  enabled: z.boolean().default(false),
  strategy: z.enum(["noop", "micro-tasks"]).default("noop"),
  minScoresForRouting: z.number().int().min(1).default(3),
  maxModels: z.number().int().min(1).default(4),
  maxTasks: z.number().int().min(1).default(4),
  tasks: z.array(AuditionTaskConfigSchema).default(DEFAULT_AUDITION_TASKS),
});
export type AuditionConfig = z.infer<typeof AuditionConfigSchema>;

export const RuntimeValidationConfigSchema = z.object({
  mode: z.enum(["auto", "required", "off"]).default("auto"),
  level: z.enum(["smoke", "affected", "full"]).default("smoke"),
});
export type RuntimeValidationConfig = z.infer<typeof RuntimeValidationConfigSchema>;

/**
 * The preparation defaults, here rather than inline in the schema because the check runner applies
 * the same two values when a caller says nothing. One definition, so an operator reading the config
 * and a sandbox prepared without one cannot disagree. Finding 54.
 */
export const DEFAULT_INSTALL_DEPENDENCIES = true;
export const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60_000;

export const SandboxConfigSchema = z.object({
  backend: z.enum(["worktree", "sandbox-exec", "container"]).default("worktree"),
  commandTimeoutMs: z.number().int().min(1000).default(15 * 60_000),
  maxOutputBytes: z.number().int().min(1024).default(2 * 1024 * 1024),
  /** worker may run arbitrary commands (beyond the project profile allowlist) */
  allowArbitraryCommands: z.boolean().default(false),
  /**
   * Install the project's dependencies in a sandbox before its checks run, when they are not
   * reachable there. Default on: a check run without them produces evidence about the environment
   * rather than the project, and the alternative — refusing to record a baseline — cannot be
   * cleared by an operator, because every attempt uses a fresh worktree. Finding 54.
   */
  installDependencies: z.boolean().default(DEFAULT_INSTALL_DEPENDENCIES),
  installTimeoutMs: z.number().int().min(1000).default(DEFAULT_INSTALL_TIMEOUT_MS),
  /** Keep installed dependency trees by lockfile under `<home>/dep-cache` and clone them into checkouts. */
  dependencyCache: z.boolean().default(true),
  envAllowlist: z.array(z.string()).default(["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM", "SHELL", "USER"]),
  envDenyPatterns: z
    .array(z.string())
    .default(["_API_KEY$", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "^AWS_", "^GH_", "^GITHUB_", "^OPENAI", "^GEMINI", "^GOOGLE", "^GROQ", "^OPENROUTER"]),
});

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

/**
 * Ordered preference chain for one Supervisor Council role.
 * `model` remains valid for a single pin; `models` is the explicit fallback list.
 * First entry is user preference, not a hard requirement that the endpoint succeed.
 */
export const SupervisorRoleConfigSchema = z
  .object({
    role: z.enum(["planner", "scope_guardian", "adversarial_auditor", "judge"]),
    /** provider/model reference as configured by the user, e.g. "gemini:gemini-3.8-flash" */
    model: z.string().min(1).optional(),
    /** Ordered preference/fallback chain. Overrides `model` when non-empty. */
    models: z.array(z.string().min(1)).optional(),
  })
  .superRefine((entry, ctx) => {
    if (supervisorModelChain(entry).length === 0) {
      ctx.addIssue({ code: "custom", message: "supervisor role requires model or models" });
    }
  })
  .transform((entry) => {
    const models = supervisorModelChain(entry);
    return { role: entry.role, model: models[0] ?? "", models };
  });
export type SupervisorRoleConfig = z.infer<typeof SupervisorRoleConfigSchema>;

/** Preferred-then-fallback model refs for a supervisor pin. */
export function supervisorModelChain(entry: {
  model?: string | undefined;
  models?: readonly string[] | undefined;
}): string[] {
  if (entry.models !== undefined && entry.models.length > 0) return [...entry.models];
  if (entry.model !== undefined && entry.model.length > 0) return [entry.model];
  return [];
}

/**
 * Bounded transient retry for a single council model before the next authorised fallback.
 * Keep this short so a shared free endpoint is not hammered for minutes.
 */
export const CouncilRetryConfigSchema = z.object({
  maxAttemptsPerModel: z.number().int().min(1).default(2),
  baseBackoffMs: z.number().int().min(0).default(1_500),
  maxBackoffMs: z.number().int().min(0).default(8_000),
});
export type CouncilRetryConfig = z.infer<typeof CouncilRetryConfigSchema>;

const CapabilityHintSchema = z.object({
  contextWindow: z.number().int().min(1).optional(),
  maxOutputTokens: z.number().int().min(1).optional(),
  inputCostPerM: z.number().min(0).optional(),
  outputCostPerM: z.number().min(0).optional(),
  family: z.string().min(1).optional(),
}).strict();

export const ProviderConfigSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["openrouter", "gemini", "groq", "lmstudio", "scripted", "record-replay", "cursor-agent"]),
  enabled: z.boolean().default(true),
  /** env var name holding the key in secrets.env; never the key itself */
  apiKeyEnv: z.string().optional(),
  baseUrl: z.url().optional(),
  concurrency: z.number().int().min(1).optional(),
  /** Per-request timeout in ms; a local model may take minutes before its first token. */
  timeoutMs: z.number().int().min(1_000).optional(),
  /** `lmstudio`: context length the model is loaded with; caps the advertised context window. */
  contextLength: z.number().int().min(1).optional(),
  /** `lmstudio`: path of the `lms` CLI used for model metadata (default `~/.lmstudio/bin/lms`, then PATH). */
  lmsPath: z.string().min(1).optional(),
  /**
   * `lmstudio`: let the tool load/unload models (one resident at a time, calls batched by model).
   * Off leaves loading to LM Studio. It unloads whatever else is loaded, so it is on only when
   * the tool is meant to own the machine's model memory.
   */
  manageResidency: z.boolean().optional(),
  /**
   * Scripted provider model names (relative to polish home for record-replay cassettes). For
   * `lmstudio` it is an allowlist: only these model keys (`*` matches any run of characters) are
   * ever listed, probed or selected.
   */
  models: z.array(z.string().min(1)).optional(),
  /** `lmstudio`: model keys (`*` wildcards allowed) that are never listed, probed or selected. */
  excludeModels: z.array(z.string().min(1)).optional(),
  cassette: z.string().optional(),
  /**
   * What the provider's listing does not state, declared per model id. Gemini's OpenAI-compatible
   * listing carries no price and no context length, so under a cost ceiling every Gemini model is
   * ineligible until its price is declared here.
   */
  capabilityHints: z.record(z.string().min(1), CapabilityHintSchema).optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

const ModelRefStringSchema = z.string().regex(/^[^:\s]+:\S+$/, 'expected "provider:model", for example "local:ornith-ai/ornith-1.5-35b-a3b"');

/**
 * Model pins by role. Each is an ordered chain: the first model is preferred and the rest are the
 * fallbacks, in order; a role that is pinned uses only its chain, never the rest of the catalogue.
 * An unpinned role is chosen by the router as before.
 */
export const RolesConfigSchema = z.object({
  /** Workers: candidate implementers and investigation workers (and their rate-limit fallbacks). */
  implementer: z.array(ModelRefStringSchema).optional(),
  /** Review axes, the seeded-defect canary and review-ensemble alternatives. */
  reviewers: z.array(ModelRefStringSchema).optional(),
  /** Pairwise comparison of several passing candidates; unused while a task has one candidate. */
  verifier: z.array(ModelRefStringSchema).optional(),
  /** Council roles; they run only when a worker asks for a split (a card run plans without a council). */
  planner: z.array(ModelRefStringSchema).optional(),
  scope_guardian: z.array(ModelRefStringSchema).optional(),
  judge: z.array(ModelRefStringSchema).optional(),
  /** Progress tracker: exactly two models of different families, or the tracker stays off. */
  progress: z.array(ModelRefStringSchema).optional(),
});
export type RolesConfig = z.infer<typeof RolesConfigSchema>;

/** `polako run <cards>`: the project brief and per-model notes every card worker is given. */
export const CardsConfigSchema = z.object({
  /** Brief file, relative to the project (td: `docs/agents/night-brief.md`); `--brief` overrides it. */
  brief: z.string().min(1).optional(),
  /**
   * Notes files appended to the brief for a model, keyed by model key, key prefix (`ornith`) or
   * lineage family (`qwen`); paths are relative to the project.
   */
  modelNotes: z.record(z.string().min(1), z.string().min(1)).default({}),
});
export type CardsConfig = z.infer<typeof CardsConfigSchema>;

export const PolishConfigSchema = z.object({
  home: z.string().default(`~/${BRAND.homeDir}`),
  /**
   * `local` (or `auto` with only `lmstudio` providers) lays the local-model defaults of
   * `domain/localProfile.ts` under this file before parsing; `cloud` never does.
   */
  profile: z.enum(["auto", "local", "cloud"]).default("auto"),
  lanes: LaneLimitsSchema.prefault({}),
  agent: AgentConfigSchema.prefault({}),
  discovery: DiscoveryConfigSchema.prefault({}),
  routing: RoutingConfigSchema.prefault({}),
  audition: AuditionConfigSchema.prefault({}),
  retry: RetryPolicySchema.prefault({}),
  execution: ExecutionStrategySchema.prefault({}),
  candidates: CandidateStrategySchema.prefault({}),
  review: ReviewStrategySchema.prefault({}),
  convergence: ConvergenceStrategySchema.prefault({}),
  verifier: VerifierStrategySchema.prefault({}),
  contextBudget: ContextBudgetSchema.prefault({}),
  budget: BudgetSchema.prefault({}),
  sandbox: SandboxConfigSchema.prefault({}),
  runtimeValidation: RuntimeValidationConfigSchema.prefault({}),
  council: CouncilRetryConfigSchema.prefault({}),
  cards: CardsConfigSchema.prefault({}),
  roles: RolesConfigSchema.prefault({}),
  supervisors: z.array(SupervisorRoleConfigSchema).default([]),
  providers: z.array(ProviderConfigSchema).default([]),
});
export type PolishConfig = z.infer<typeof PolishConfigSchema>;

export function defaultConfig(): PolishConfig {
  return PolishConfigSchema.parse({});
}

/**
 * Run-scoped view of `base` that differs only in `runtimeValidation.mode`.
 * Never assigns into `base`: concurrent runs share one loaded config object and a
 * per-run mode must not leak between them.
 */
export function withRuntimeValidationMode(
  base: PolishConfig,
  mode: RuntimeValidationConfig["mode"],
): PolishConfig {
  // Unconditional. Returning `base` when the modes happen to match hands the caller the shared
  // config object, and that case is exactly the one a default-mode run takes.
  return { ...base, runtimeValidation: { ...base.runtimeValidation, mode } };
}

/** The per-attempt worker token cap, or null for none. */
export function attemptTokenCap(budget: { maxAttemptTokens: number | null; maxTaskTokens: number | null }): number | null {
  return budget.maxAttemptTokens ?? budget.maxTaskTokens;
}

/** Where installed dependency trees are cached, or null: only under a resolved (absolute) home. */
export function dependencyCacheDir(config: { home: string; sandbox: { dependencyCache: boolean } }): string | null {
  return config.sandbox.dependencyCache && config.home.startsWith("/") ? `${config.home.replace(/\/$/, "")}/dep-cache` : null;
}
