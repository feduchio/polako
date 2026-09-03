import type { CompletionRequest, CompletionResponse, ModelInfo, ProviderAdapter, ProviderHealth } from "../broker/types.js";
import { OpenAICompatProvider, type FetchLike } from "./openaiCompat.js";

export interface OpenRouterProviderOptions {
  id: string;
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  concurrency?: number | null;
  timeoutMs?: number;
}

/** OpenRouter via the OpenAI-compatible chat completions API. */
export class OpenRouterProvider implements ProviderAdapter {
  readonly id: string;
  readonly kind = "openrouter";
  readonly concurrency: number | null;
  private readonly inner: OpenAICompatProvider;

  constructor(opts: OpenRouterProviderOptions) {
    this.id = opts.id;
    this.concurrency = opts.concurrency ?? null;
    this.inner = new OpenAICompatProvider({
      id: opts.id,
      kind: "openrouter",
      baseUrl: opts.baseUrl ?? "https://openrouter.ai/api/v1",
      apiKey: opts.apiKey,
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
      ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      headers: {
        "HTTP-Referer": "https://github.com/polish-orchestrator/polish",
        "X-Title": "Polish",
      },
    });
  }

  listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    return this.inner.listModels(signal);
  }

  complete(request: CompletionRequest): Promise<CompletionResponse> {
    return this.inner.complete(request);
  }

  health(signal?: AbortSignal): Promise<ProviderHealth> {
    return this.inner.health(signal);
  }
}
