import type { CompletionRequest, CompletionResponse, ModelInfo, ProviderAdapter, ProviderHealth } from "../broker/types.js";
import { OpenAICompatProvider, type FetchLike } from "./openaiCompat.js";

export interface GeminiProviderOptions {
  id: string;
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  concurrency?: number | null;
  timeoutMs?: number;
  /** override capability inference for models the listing under-describes */
  capabilityHints?: Record<string, Partial<ModelInfo["capabilities"]>>;
}

/**
 * Google Gemini via the OpenAI-compatible endpoint on the Generative Language API.
 * Native Gemini REST is not used here; transport stays OpenAI-shaped for broker uniformity.
 */
export class GeminiProvider implements ProviderAdapter {
  readonly id: string;
  readonly kind = "gemini";
  readonly concurrency: number | null;
  private readonly inner: OpenAICompatProvider;

  constructor(opts: GeminiProviderOptions) {
    this.id = opts.id;
    this.concurrency = opts.concurrency ?? null;
    this.inner = new OpenAICompatProvider({
      id: opts.id,
      kind: "gemini",
      baseUrl: opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta/openai",
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
