import type { ChatMessage, CompletionRequest, CompletionResponse, FinishReason, ModelInfo, ModelTier, ProviderAdapter, ProviderHealth, ToolCall } from "../broker/types.js";
import { ProviderError } from "../broker/types.js";

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
    if (request.responseFormat === "json") payload["response_format"] = { type: "json_object" };
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
    if (status === 429) return new ProviderError(this.id, "rate_limit", `rate limited: ${snippet}`, { status, retryAfterMs });
    if (status === 408 || status === 504) return new ProviderError(this.id, "timeout", `timeout (${status}): ${snippet}`, { status });
    if (status >= 500) return new ProviderError(this.id, "server", `server error (${status}): ${snippet}`, { status, retryAfterMs });
    if (/context|too many tokens|maximum context length/i.test(body)) return new ProviderError(this.id, "context_length", snippet, { status });
    return new ProviderError(this.id, "bad_request", `bad request (${status}): ${snippet}`, { status });
  }

  private toModelInfo(row: OpenAIModelRow): ModelInfo {
    const hint = this.opts.capabilityHints?.[row.id] ?? {};
    const input = row.pricing?.prompt !== undefined ? Number(row.pricing.prompt) * 1_000_000 : null;
    const output = row.pricing?.completion !== undefined ? Number(row.pricing.completion) * 1_000_000 : null;
    const supported = new Set(row.supported_parameters ?? []);
    const contextWindow = row.context_length ?? 8192;
    const capabilities: ModelInfo["capabilities"] = {
      contextWindow,
      maxOutputTokens: row.top_provider?.max_completion_tokens ?? null,
      supportsTools: supported.size === 0 ? true : supported.has("tools"),
      supportsJson: supported.size === 0 ? true : supported.has("response_format") || supported.has("structured_outputs"),
      inputCostPerM: input !== null && Number.isFinite(input) ? input : null,
      outputCostPerM: output !== null && Number.isFinite(output) ? output : null,
      tier: inferTier(row.id, input, contextWindow),
      family: inferFamily(row.id),
      ...hint,
    };
    return { ref: { provider: this.id, model: row.id }, displayName: row.name ?? row.id, capabilities, source: "provider" };
  }
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

/** Vendor family from the model id prefix (`vendor/model` on OpenRouter) or well-known name stems. */
export function inferFamily(modelId: string): string {
  const slash = modelId.indexOf("/");
  if (slash > 0) return modelId.slice(0, slash).toLowerCase();
  const lower = modelId.toLowerCase();
  const stems: [RegExp, string][] = [
    [/^(gpt|o\d|chatgpt)/, "openai"],
    [/^claude/, "anthropic"],
    [/^gemini|^gemma/, "google"],
    [/^llama/, "meta"],
    [/^mixtral|^mistral|^magistral|^codestral/, "mistralai"],
    [/^deepseek/, "deepseek"],
    [/^qwen|^qwq/, "qwen"],
    [/^grok/, "x-ai"],
    [/^kimi|^moonshot/, "moonshotai"],
  ];
  for (const [re, fam] of stems) if (re.test(lower)) return fam;
  return lower.split(/[-_:.]/)[0] ?? lower;
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
