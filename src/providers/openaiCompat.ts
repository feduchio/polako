import type { ChatMessage, CompletionRequest, CompletionResponse, FinishReason, ModelInfo, ModelTier, ProviderAdapter, ProviderHealth, RateLimitScope, ToolCall } from "../broker/types.js";
import { ProviderError } from "../broker/types.js";
import { canonicalFamily, inferFamily } from "../broker/diversity.js";

export { canonicalFamily, inferFamily };

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface OpenAICompatOptions {
  id: string;
  kind: "openrouter" | "groq" | "gemini" | "openai-compat";
  baseUrl: string;
  apiKey: string;
  fetch?: FetchLike;
  concurrency?: number | null;
  timeoutMs?: number;
  /** extra headers (OpenRouter attribution etc.) */
  headers?: Record<string, string>;
  /** override/extend capability inference for models the provider under-describes */
  capabilityHints?: Record<string, Partial<ModelInfo["capabilities"]>>;
}

interface OpenAIModelRow {
  id: string;
  name?: string;
  context_length?: number;
  top_provider?: { max_completion_tokens?: number | null };
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
  architecture?: { input_modalities?: string[] };
}

/**
 * Adapter for the OpenAI-compatible chat completions API as served by OpenRouter and Groq.
 * Dumb transport: maps requests/responses and classifies errors; the broker owns retries.
 */
export class OpenAICompatProvider implements ProviderAdapter {
  readonly id: string;
  readonly kind: string;
  readonly concurrency: number | null;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: OpenAICompatOptions) {
    this.id = opts.id;
    this.kind = opts.kind;
    this.concurrency = opts.concurrency ?? null;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const body = await this.request("GET", "/models", undefined, signal);
    const parsed = JSON.parse(body) as { data?: OpenAIModelRow[] };
    return (parsed.data ?? []).map((row) => this.toModelInfo(row));
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const started = Date.now();
    const payload: Record<string, unknown> = {
      model: request.model.model,
      messages: request.messages.map(toOpenAIMessage),
    };
    if (request.tools && request.tools.length > 0) {
      payload["tools"] = request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    if (request.responseSchema !== undefined) {
      payload["response_format"] = {
        type: "json_schema",
        json_schema: request.responseSchema,
      };
    } else if (request.responseFormat === "json") {
      payload["response_format"] = { type: "json_object" };
    }
    if (request.reasoning !== undefined) payload["reasoning"] = request.reasoning;
    if (request.maxTokens !== undefined) payload["max_tokens"] = request.maxTokens;
    if (request.temperature !== undefined) payload["temperature"] = request.temperature;

    const text = await this.request("POST", "/chat/completions", JSON.stringify(payload), request.signal);
    const parsed = JSON.parse(text) as {
      id?: string;
      choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      error?: { message?: string; code?: number | string };
    };
    if (parsed.error) throw new ProviderError(this.id, "server", parsed.error.message ?? "provider error in body");
    const choice = parsed.choices?.[0];
    if (!choice?.message) throw new ProviderError(this.id, "server", "no choices in response");
    const toolCalls: ToolCall[] | undefined = choice.message.tool_calls?.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments }));
    const message: CompletionResponse["message"] = toolCalls && toolCalls.length > 0
      ? { role: "assistant", content: choice.message.content ?? "", toolCalls }
      : { role: "assistant", content: choice.message.content ?? "" };
    const response: CompletionResponse = {
      message,
      usage: {
        inputTokens: parsed.usage?.prompt_tokens ?? 0,
        outputTokens: parsed.usage?.completion_tokens ?? 0,
        costUsd: parsed.usage?.cost ?? null,
      },
      finishReason: mapFinish(choice.finish_reason, toolCalls !== undefined && toolCalls.length > 0),
      latencyMs: Date.now() - started,
    };
    if (parsed.id !== undefined) response.providerResponseId = parsed.id;
    return response;
  }

  async health(signal?: AbortSignal): Promise<ProviderHealth> {
    try {
      await this.request("GET", "/models", undefined, signal);
      return { ok: true, checkedAt: Date.now() };
    } catch (err) {
      return { ok: false, checkedAt: Date.now(), detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private async request(method: string, path: string, body: string | undefined, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.opts.timeoutMs ?? 120_000);
    const onAbort = (): void => {
      controller.abort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const init: Parameters<FetchLike>[1] = {
        method,
        headers: { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json", ...(this.opts.headers ?? {}) },
        signal: controller.signal,
      };
      if (body !== undefined) init.body = body;
      const res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, "")}${path}`, init);
      const text = await res.text();
      if (res.status >= 200 && res.status < 300) return text;
      throw this.classify(res.status, res.headers.get("retry-after"), text);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (signal?.aborted) throw err;
      if (controller.signal.aborted) throw new ProviderError(this.id, "timeout", `request timed out after ${this.opts.timeoutMs ?? 120_000}ms`, { cause: err });
      throw new ProviderError(this.id, "network", err instanceof Error ? err.message : String(err), { cause: err });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private classify(status: number, retryAfter: string | null, body: string): ProviderError {
    const snippet = body.slice(0, 500);
    const retryAfterMs = retryAfter ? (Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : null) : null;
    if (status === 401 || status === 403) return new ProviderError(this.id, "auth", `auth failed (${status}): ${snippet}`, { status });
    if (status === 404) return new ProviderError(this.id, "not_found", `not found: ${snippet}`, { status });
    if (status === 429) {
      return new ProviderError(this.id, "rate_limit", `rate limited: ${snippet}`, {
        status,
        retryAfterMs: retryAfterMs ?? rateLimitResetMs(body, Date.now()),
        limitScope: rateLimitScope(body),
      });
    }
    if (status === 408 || status === 504) return new ProviderError(this.id, "timeout", `timeout (${status}): ${snippet}`, { status });
    if (status >= 500) return new ProviderError(this.id, "server", `server error (${status}): ${snippet}`, { status, retryAfterMs });
    if (/context|too many tokens|maximum context length/i.test(body)) return new ProviderError(this.id, "context_length", snippet, { status });
    return new ProviderError(this.id, "bad_request", `bad request (${status}): ${snippet}`, { status });
  }

  private toModelInfo(row: OpenAIModelRow): ModelInfo {
    const hints = this.opts.capabilityHints;
    const hint = hints?.[row.id] ?? hints?.[row.id.replace(/^models\//, "")] ?? {};
    const input = advertisedPricePerM(row.pricing?.prompt);
    const output = advertisedPricePerM(row.pricing?.completion);
    const supported = new Set(row.supported_parameters ?? []);
    const contextWindow = row.context_length ?? 8192;
    const capabilities: ModelInfo["capabilities"] = {
      contextWindow,
      maxOutputTokens: row.top_provider?.max_completion_tokens ?? null,
      supportsTools: supported.size === 0 ? true : supported.has("tools"),
      supportsJson: supported.size === 0 ? true : supported.has("response_format") || supported.has("structured_outputs"),
      inputCostPerM: input,
      outputCostPerM: output,
      tier: inferTier(row.id, input, contextWindow),
      family: inferFamily(row.id),
      ...hint,
    };
    return { ref: { provider: this.id, model: row.id }, displayName: row.name ?? row.id, capabilities, source: "provider" };
  }
}

/** Longest wait for an allowance's reset that is worth sleeping through; a daily reset is not. */
const MAX_RESET_WAIT_MS = 120_000;

/**
 * How long until OpenRouter's allowance resets, from `error.metadata.headers["X-RateLimit-Reset"]`
 * (epoch ms). The free tier's per-minute limit (20/min, shared by every free route) says when it
 * lifts only there, not in `Retry-After`; without it every retry fell inside the same minute.
 */
export function rateLimitResetMs(body: string, now: number): number | null {
  let reset: unknown;
  try {
    reset = (JSON.parse(body) as { error?: { metadata?: { headers?: Record<string, unknown> } } }).error?.metadata?.headers?.["X-RateLimit-Reset"];
  } catch {
    return null;
  }
  const at = Number(reset);
  if (!Number.isFinite(at)) return null;
  const wait = at - now;
  return wait > 0 && wait <= MAX_RESET_WAIT_MS ? wait : null;
}

/**
 * Whose allowance the 429 spent, read from OpenRouter's `error.metadata.limit_source` rather than
 * from the message text. Observed value on the funded key:
 * `openrouter_free_tier_daily`, with `X-RateLimit-Limit: 1000` and `X-RateLimit-Remaining: 0`.
 * Every `openrouter_free_tier_*` variant is one allowance shared by every free route on the
 * account, so rotating to another model cannot help. `upstream_provider_shared_pool` belongs to
 * the route (`docs/RECOVERY.md` R1). Anything else is `unknown` and is handled as model-scoped,
 * which is the behaviour that already existed.
 */
function rateLimitScope(body: string): RateLimitScope {
  let source: unknown;
  try {
    source = (JSON.parse(body) as { error?: { metadata?: { limit_source?: unknown } } }).error?.metadata?.limit_source;
  } catch {
    return "unknown";
  }
  if (typeof source !== "string") return "unknown";
  if (source.startsWith("openrouter_free_tier")) return "account";
  if (source === "upstream_provider_shared_pool") return "model";
  return "unknown";
}

/**
 * USD per 1M tokens, or `null` when the provider is not stating a price. OpenRouter advertises
 * `"-1"` for routes whose price depends on where they route (`openrouter/auto-beta`,
 * `openrouter/fusion`); a negative number is that sentinel, not a discount. Returning it as a
 * number made those routes satisfy every cost ceiling, and the first one selected billed $0.003825
 * for 745 input tokens — 17x the ceiling that admitted it (`docs/ledger/R0-run.md`).
 */
function advertisedPricePerM(raw: string | undefined): number | null {
  // `Number` is not a price parser: it reads "" and "   " as 0, "0x10" as 16, and "Infinity" as a
  // number. Only an unsigned decimal, with an optional fraction and exponent, is a price.
  if (raw === undefined) return null;
  const mantissa = /^(\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.exec(raw.trim());
  if (mantissa === null) return null;
  const perM = Number(raw) * 1_000_000;
  // After the multiplication, not before: "1e303" is a finite double that stops being one here.
  if (!Number.isFinite(perM)) return null;
  // A mantissa carrying a non-zero digit that reaches zero has underflowed. "1e-324" is a price
  // too small for a double, not the price zero, and zero is the one value that means "free". The
  // exponent is excluded from the test, or "0e999" would look non-zero because of its exponent.
  if (perM === 0 && /[1-9]/.test(mantissa[1] ?? "")) return null;
  return perM;
}

function toOpenAIMessage(m: ChatMessage): Record<string, unknown> {
  switch (m.role) {
    case "system":
    case "user":
      return { role: m.role, content: m.content };
    case "assistant":
      return m.toolCalls && m.toolCalls.length > 0
        ? {
            role: "assistant",
            content: m.content || null,
            tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
          }
        : { role: "assistant", content: m.content };
    case "tool":
      return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
  }
}

function mapFinish(reason: string | undefined, hasToolCalls: boolean): FinishReason {
  if (hasToolCalls) return "tool_calls";
  if (reason === undefined) return "stop";
  switch (reason) {
    case "stop":
    case "end_turn":
      return "stop";
    case "length":
    case "max_tokens":
      return "length";
    case "tool_calls":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "error";
  }
}

/**
 * Coarse tier heuristic used only until observed quality exists. Price and context are the
 * signals (no model-name knowledge baked in beyond family stems).
 */
export function inferTier(_modelId: string, inputCostPerM: number | null, contextWindow: number): ModelTier {
  if (inputCostPerM !== null) {
    if (inputCostPerM >= 2) return "frontier";
    if (inputCostPerM >= 0.3) return "strong";
    return "fast";
  }
  return contextWindow >= 128_000 ? "strong" : "fast";
}
