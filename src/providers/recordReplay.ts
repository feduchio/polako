import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CompletionRequest, CompletionResponse, ModelInfo, ProviderAdapter, ProviderHealth } from "../broker/types.js";
import { ProviderError } from "../broker/types.js";
import { hashJson } from "../shared/hash.js";

interface Cassette {
  models: ModelInfo[];
  responses: Record<string, CompletionResponse>;
}

/**
 * Wrap a real adapter to record (request-hash → response) into a JSON cassette, or replay from
 * it without touching the network. Request hash excludes `signal` and metadata.
 */
export class RecordReplayProvider implements ProviderAdapter {
  readonly kind = "record-replay";
  readonly concurrency: number | null;
  private cassette: Cassette;

  constructor(
    readonly id: string,
    private readonly cassettePath: string,
    private readonly mode: "record" | "replay",
    private readonly inner: ProviderAdapter | null,
  ) {
    this.concurrency = inner?.concurrency ?? null;
    this.cassette = existsSync(cassettePath) ? (JSON.parse(readFileSync(cassettePath, "utf8")) as Cassette) : { models: [], responses: {} };
    if (mode === "record" && !inner) throw new Error("record mode requires an inner adapter");
  }

  static requestKey(req: CompletionRequest): string {
    return hashJson({
      model: req.model,
      messages: req.messages,
      tools: req.tools ?? null,
      responseFormat: req.responseFormat ?? "text",
      responseSchema: req.responseSchema ?? null,
      reasoning: req.reasoning ?? null,
      maxTokens: req.maxTokens ?? null,
      temperature: req.temperature ?? null,
    });
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    if (this.mode === "replay" || !this.inner) return this.cassette.models;
    const models = await this.inner.listModels(signal);
    this.cassette.models = models;
    this.save();
    return models;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const key = RecordReplayProvider.requestKey(request);
    const hit = this.cassette.responses[key];
    if (hit) return hit;
    if (this.mode === "replay" || !this.inner) {
      throw new ProviderError(this.id, "not_found", `no recorded response for request ${key.slice(0, 12)} (${request.metadata.purpose})`);
    }
    const response = await this.inner.complete(request);
    this.cassette.responses[key] = response;
    this.save();
    return response;
  }

  health(signal?: AbortSignal): Promise<ProviderHealth> {
    if (this.mode === "replay" || !this.inner) return Promise.resolve({ ok: true, checkedAt: Date.now(), detail: "replay" });
    return this.inner.health(signal);
  }

  private save(): void {
    mkdirSync(dirname(this.cassettePath), { recursive: true });
    writeFileSync(this.cassettePath, JSON.stringify(this.cassette, null, 2));
  }
}
