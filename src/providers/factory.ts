import { resolve } from "node:path";
import type { ProviderConfig } from "../domain/config.js";
import type { ProviderAdapter } from "../broker/types.js";
import { GeminiProvider } from "./gemini.js";
import { GroqProvider } from "./groq.js";
import { OpenRouterProvider } from "./openrouter.js";
import type { FetchLike } from "./openaiCompat.js";
import { RecordReplayProvider } from "./recordReplay.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "./scripted.js";

export interface CreateProviderOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Polish home — required for record-replay cassette resolution */
  home?: string;
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
    case "scripted": {
      const models = (entry.models ?? ["default"]).map((name) => ({
        name,
        capabilities: { ...FAKE_CAPABILITIES.strong, inputCostPerM: 0, outputCostPerM: 0 },
      }));
      return new ScriptedProvider(entry.id, models, { concurrency: entry.concurrency ?? null });
    }
    case "record-replay": {
      if (opts.home === undefined || entry.cassette === undefined) return null;
      return new RecordReplayProvider(entry.id, resolve(opts.home, entry.cassette), "replay", null);
    }
    case "cursor-agent":
      return null;
  }
}
