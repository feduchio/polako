import type { CompletionRequest, CompletionResponse, ModelInfo, ProviderAdapter, ProviderHealth } from "../broker/types.js";
import { ProviderError } from "../broker/types.js";

export interface ScriptedModel {
  name: string;
  displayName?: string;
  capabilities: ModelInfo["capabilities"];
}

export type ScriptStep =
  | { kind: "reply"; content: string; toolCalls?: { id: string; name: string; arguments: string }[]; usage?: { inputTokens: number; outputTokens: number; costUsd?: number | null } }
  | { kind: "error"; error: ProviderError }
  | { kind: "fn"; fn: (request: CompletionRequest, callIndex: number) => CompletionResponse | Promise<CompletionResponse> };

/**
 * Deterministic provider for simulations. Steps are consumed per model in order; when the
 * script runs out, `fallback` is used (default: echo the last user message).
 */
export class ScriptedProvider implements ProviderAdapter {
  readonly kind = "scripted";
  readonly concurrency: number | null;
  readonly calls: CompletionRequest[] = [];
  private readonly scripts = new Map<string, ScriptStep[]>();
  private readonly models: ModelInfo[];

  constructor(
    readonly id: string,
    models: ScriptedModel[],
    opts: { concurrency?: number | null; fallback?: ScriptStep } = {},
  ) {
    this.concurrency = opts.concurrency ?? null;
    this.models = models.map((m) => ({ ref: { provider: id, model: m.name }, displayName: m.displayName ?? m.name, capabilities: m.capabilities, source: "provider" }));
    this.fallback = opts.fallback ?? { kind: "fn", fn: (req) => reply(lastUser(req), 10, 5) };
  }

  private readonly fallback: ScriptStep;

  script(model: string, steps: ScriptStep[]): this {
    this.scripts.set(model, [...(this.scripts.get(model) ?? []), ...steps]);
    return this;
  }

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve(this.models);
  }

  health(): Promise<ProviderHealth> {
    return Promise.resolve({ ok: true, checkedAt: Date.now() });
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.calls.push(request);
    if (!this.models.some((m) => m.ref.model === request.model.model)) {
      throw new ProviderError(this.id, "not_found", `unknown model ${request.model.model}`);
    }
    if (
      request.metadata.purpose === "capability_probe_strict_review" &&
      request.responseSchema?.name === "review_findings"
    ) {
      return reply('{"findings":[]}', 1, 1, 0);
    }
    if (
      request.metadata.purpose === "capability_probe_strict_score" &&
      request.responseSchema?.name === "empirical_pair_score"
    ) {
      return reply('{"scoreA":2,"scoreB":2}', 1, 1, 0);
    }
    const queue = this.scripts.get(request.model.model) ?? [];
    const step = queue.shift() ?? this.fallback;
    switch (step.kind) {
      case "reply":
        return reply(step.content, step.usage?.inputTokens ?? 10, step.usage?.outputTokens ?? 5, step.usage?.costUsd ?? null, step.toolCalls);
      case "error":
        throw step.error;
      case "fn":
        return step.fn(request, this.calls.length - 1);
    }
  }
}

function lastUser(req: CompletionRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m?.role === "user") return m.content;
  }
  return "";
}

export function reply(
  content: string,
  inputTokens = 10,
  outputTokens = 5,
  costUsd: number | null = null,
  toolCalls?: { id: string; name: string; arguments: string }[],
  finishReason?: CompletionResponse["finishReason"],
): CompletionResponse {
  const resolvedFinish =
    finishReason ?? (toolCalls ? "tool_calls" : "stop");
  return {
    message: toolCalls ? { role: "assistant", content, toolCalls } : { role: "assistant", content },
    usage: { inputTokens, outputTokens, costUsd },
    finishReason: resolvedFinish,
    latencyMs: 1,
  };
}

export const FAKE_CAPABILITIES = {
  frontier: { contextWindow: 200_000, maxOutputTokens: 16_000, supportsTools: true, supportsJson: true, inputCostPerM: 3, outputCostPerM: 15, tier: "frontier" as const, family: "alpha" },
  strong: { contextWindow: 128_000, maxOutputTokens: 8_000, supportsTools: true, supportsJson: true, inputCostPerM: 0.5, outputCostPerM: 1.5, tier: "strong" as const, family: "beta" },
  fast: { contextWindow: 64_000, maxOutputTokens: 4_000, supportsTools: true, supportsJson: false, inputCostPerM: 0.05, outputCostPerM: 0.1, tier: "fast" as const, family: "gamma" },
};
