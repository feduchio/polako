import { z } from "zod";
import { ModelRefSchema, type ModelRef } from "../domain/common.js";

export const ModelTierSchema = z.enum(["frontier", "strong", "fast"]);
export type ModelTier = z.infer<typeof ModelTierSchema>;

export const TIER_RANK: Record<ModelTier, number> = { frontier: 3, strong: 2, fast: 1 };

export const ModelCapabilitiesSchema = z.object({
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().nullable(),
  supportsTools: z.boolean(),
  supportsJson: z.boolean(),
  supportsStrictReviewSchema: z.boolean().optional(),
  supportsStrictScoreSchema: z.boolean().optional(),
  supportsStrictProgressSchema: z.boolean().optional(),
  /** USD per 1M tokens; null when unknown. Unknown is not treated as free. */
  inputCostPerM: z.number().nonnegative().nullable(),
  outputCostPerM: z.number().nonnegative().nullable(),
  tier: ModelTierSchema,
  /** vendor family used for diversity (e.g. "anthropic", "google", "openai", "meta", "deepseek") */
  family: z.string().min(1),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

export const ModelInfoSchema = z.object({
  ref: ModelRefSchema,
  displayName: z.string(),
  capabilities: ModelCapabilitiesSchema,
  source: z.enum(["provider", "config", "probe"]),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export interface ToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments as produced by the model */
  arguments: string;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CompletionRequest {
  model: ModelRef;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  responseFormat?: "text" | "json";
  responseSchema?: {
    name: string;
    strict: true;
    schema: Record<string, unknown>;
  };
  reasoning?: {
    effort: "none" | "low" | "medium" | "high";
    exclude: boolean;
  };
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  metadata: {
    runId: string;
    purpose: string;
    role: string;
    taskId?: string;
    /** event ids that caused this call (why-chain) */
    causedBy?: string[];
    /** Correlate start/retry/completion events for one logical call. */
    callId?: string;
    /** Override constructor retry policy for this request (council uses a tighter bound). */
    retryPolicy?: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
  };
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "error";

export interface CompletionResponse {
  message: ChatMessage & { role: "assistant" };
  usage: Usage;
  finishReason: FinishReason;
  latencyMs: number;
  /** provider-side identifiers for forensics */
  providerResponseId?: string;
}

export type ProviderErrorKind = "rate_limit" | "auth" | "server" | "timeout" | "bad_request" | "context_length" | "network" | "not_found";

/**
 * Whose allowance a 429 spent.
 *
 * `account` — every model of that provider is behind the same exhausted allowance, so trying
 * another one cannot succeed. `model` — the limit belongs to this route. `unknown` is kept
 * distinct from `model` at the point of parsing even though the two are handled alike: the
 * difference between "the provider said so" and "we assumed" is the difference this whole item is
 * about, and a later reader must be able to tell which one produced a decision.
 */
export type RateLimitScope = "account" | "model" | "unknown";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly provider: string;
  readonly status: number | null;
  /** Non-null only for `rate_limit`. */
  readonly limitScope: RateLimitScope | null;

  constructor(
    provider: string,
    kind: ProviderErrorKind,
    message: string,
    opts: { retryAfterMs?: number | null; status?: number | null; cause?: unknown; limitScope?: RateLimitScope } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "ProviderError";
    this.provider = provider;
    this.kind = kind;
    this.retryable = kind === "rate_limit" || kind === "server" || kind === "timeout" || kind === "network";
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.status = opts.status ?? null;
    this.limitScope = kind === "rate_limit" ? opts.limitScope ?? "unknown" : null;
  }
}

/** An account-wide allowance, which no other model of the same provider can escape. */
export function isAccountScopedLimit(error: unknown): boolean {
  return error instanceof ProviderError && error.limitScope === "account";
}

export interface ProviderHealth {
  ok: boolean;
  checkedAt: number;
  detail?: string;
}

/**
 * One provider (OpenRouter, Gemini, Groq, scripted, ...). Adapters are dumb transports:
 * no retries, no budgets, no logging — the broker does that uniformly.
 */
export interface ProviderAdapter {
  readonly id: string;
  readonly kind: string;
  /** hard concurrency limit advertised by the provider/config, if any */
  readonly concurrency: number | null;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  health(signal?: AbortSignal): Promise<ProviderHealth>;
}
