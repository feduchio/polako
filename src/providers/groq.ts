import type { CompletionRequest, CompletionResponse, ModelInfo, ProviderAdapter, ProviderHealth } from "../broker/types.js";
import { OpenAICompatProvider, type FetchLike } from "./openaiCompat.js";

export interface GroqProviderOptions {
  id: string;
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  concurrency?: number | null;
  timeoutMs?: number;
  capabilityHints?: Record<string, Partial<ModelInfo["capabilities"]>>;
}

/** Groq via the OpenAI-compatible chat completions API. */
export class GroqProvider implements ProviderAdapter {
  readonly id: string;
  readonly kind = "groq";
  readonly concurrency: number | null;
  private readonly inner: OpenAICompatProvider;

  constructor(opts: GroqProviderOptions) {
    this.id = opts.id;
    this.concurrency = opts.concurrency ?? null;
    this.inner = new OpenAICompatProvider({
      id: opts.id,
      kind: "groq",
      baseUrl: opts.baseUrl ?? "https://api.groq.com/openai/v1",
      apiKey: opts.apiKey,
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
      ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.capabilityHints !== undefined ? { capabilityHints: opts.capabilityHints } : {}),
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
