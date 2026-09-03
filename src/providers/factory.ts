import type { ProviderConfig } from "../domain/config.js";
import type { ProviderAdapter } from "../broker/types.js";
import { GeminiProvider } from "./gemini.js";
import { GroqProvider } from "./groq.js";
import { OpenRouterProvider } from "./openrouter.js";
import type { FetchLike } from "./openaiCompat.js";

export interface CreateProviderOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
}

/** Instantiate a real provider adapter from config + resolved secret value. */
export function createProviderFromConfig(
  entry: ProviderConfig,
  apiKey: string,
  opts: CreateProviderOptions = {},
): ProviderAdapter | null {
  const base = {
    id: entry.id,
    apiKey,
    concurrency: entry.concurrency ?? null,
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(entry.baseUrl !== undefined ? { baseUrl: entry.baseUrl } : {}),
  };
  switch (entry.kind) {
    case "openrouter":
      return new OpenRouterProvider(base);
    case "groq":
      return new GroqProvider(base);
    case "gemini":
      return new GeminiProvider(base);
    case "scripted":
    case "record-replay":
    case "cursor-agent":
      return null;
  }
}
