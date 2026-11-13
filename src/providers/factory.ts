import { resolve } from "node:path";
import type { ProviderConfig } from "../domain/config.js";
import type { ModelInfo, ProviderAdapter } from "../broker/types.js";
import { GeminiProvider } from "./gemini.js";
import { GroqProvider } from "./groq.js";
import { LmStudioProvider } from "./lmstudio.js";
import { OpenRouterProvider } from "./openrouter.js";
import { canonicalFamily, inferFamily, type FetchLike } from "./openaiCompat.js";
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
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
    ...(entry.baseUrl !== undefined ? { baseUrl: entry.baseUrl } : {}),
    ...(entry.capabilityHints !== undefined ? { capabilityHints: capabilityHintsFrom(entry.capabilityHints) } : {}),
  };
  switch (entry.kind) {
    case "openrouter":
      return new OpenRouterProvider(base);
    case "groq":
      return new GroqProvider(base);
    case "gemini":
      return new GeminiProvider(base);
    case "lmstudio":
      return new LmStudioProvider({
        ...base,
        // LM Studio takes no key unless token auth is on; an empty `apiKey` means "none".
        concurrency: entry.concurrency ?? 1,
        ...(entry.contextLength !== undefined ? { contextLength: entry.contextLength } : {}),
        ...(entry.lmsPath !== undefined ? { lmsPath: entry.lmsPath } : {}),
      });
    case "scripted": {
      const models = (entry.models ?? ["default"]).map((name) => ({
        name,
        // Each scripted name stands for its own vendor unless configured otherwise: a harness that
        // shares one family across every model cannot exercise a diversity rule at all.
        capabilities: {
          ...FAKE_CAPABILITIES.strong,
          inputCostPerM: 0,
          outputCostPerM: 0,
          family: canonicalFamily(entry.capabilityHints?.[name]?.family ?? inferFamily(name)),
        },
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

function capabilityHintsFrom(
  hints: NonNullable<ProviderConfig["capabilityHints"]>,
): Record<string, Partial<ModelInfo["capabilities"]>> {
  const out: Record<string, Partial<ModelInfo["capabilities"]>> = {};
  for (const [model, hint] of Object.entries(hints)) {
    const entry: Partial<ModelInfo["capabilities"]> = {};
    if (hint.contextWindow !== undefined) entry.contextWindow = hint.contextWindow;
    if (hint.maxOutputTokens !== undefined) entry.maxOutputTokens = hint.maxOutputTokens;
    if (hint.inputCostPerM !== undefined) entry.inputCostPerM = hint.inputCostPerM;
    if (hint.outputCostPerM !== undefined) entry.outputCostPerM = hint.outputCostPerM;
    if (hint.family !== undefined) entry.family = canonicalFamily(hint.family);
    out[model] = entry;
  }
  return out;
}
