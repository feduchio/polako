import { execFile } from "node:child_process";
import type { CompletionRequest, CompletionResponse, ModelInfo, ModelTier, ProviderAdapter, ProviderHealth } from "../broker/types.js";
import { localLineage } from "../broker/lineage.js";
import type { ResidencyScheduler } from "../broker/residency.js";
import { defaultLmsPath } from "./lmstudioControl.js";
import { OpenAICompatProvider, type FetchLike } from "./openaiCompat.js";

export const LMSTUDIO_DEFAULT_BASE_URL = "http://localhost:1234/v1";
/**
 * A dense 27B model needs minutes to read a 40-60k-token prompt and then writes ~25 tok/s; the
 * request is not streamed, so the timeout covers the whole generation (docs/LOCAL.md §a).
 */
export const LMSTUDIO_DEFAULT_TIMEOUT_MS = 30 * 60_000;
/** Context length the models are loaded with (`lms load -c`); LM Studio's own maximum is never used. */
/** Calls the lane admits at once when residency is managed; the scheduler still runs them one by one. */
export const LMSTUDIO_QUEUE_DEPTH = 4;
export const LMSTUDIO_DEFAULT_CONTEXT_LENGTH = 65_536;
/** `apiKey` the OpenAI-compatible client sends when none is configured; LM Studio ignores it. */
const PLACEHOLDER_API_KEY = "lm-studio";

/** One row of `lms ls --json`, reduced to the fields the broker needs. */
export interface LmsModelMeta {
  type: "llm" | "embedding" | (string & {});
  modelKey: string;
  displayName?: string;
  publisher?: string;
  path?: string;
  architecture?: string;
  paramsString?: string;
  quantization?: { name?: string; bits?: number };
  trainedForToolUse?: boolean;
  maxContextLength?: number;
  sizeBytes?: number;
}

/** Source of `lms ls --json` metadata; `[]` means "unknown", never an error. */
export type LmsCatalogSource = (signal?: AbortSignal) => Promise<LmsModelMeta[]>;

export interface LmStudioProviderOptions {
  id: string;
  /** Optional: LM Studio only checks a key when API-token auth is switched on. */
  apiKey?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  concurrency?: number | null;
  timeoutMs?: number;
  /** Context length the models are loaded with; caps the context window the broker sees. */
  contextLength?: number;
  capabilityHints?: Record<string, Partial<ModelInfo["capabilities"]>>;
  /** Replaces the `lms ls --json` call (tests, or a machine without the CLI). */
  catalog?: LmsCatalogSource;
  /** Path of the `lms` CLI used when `catalog` is not given. */
  lmsPath?: string;
  /**
   * Owns which model is loaded: every call waits its turn and runs under the model's own name
   * with that model resident. Without it LM Studio's own just-in-time loading decides.
   */
  residency?: ResidencyScheduler;
}

/**
 * LM Studio's local server through the OpenAI-compatible chat completions API.
 *
 * Zero cost, one request at a time by default (one model fits in memory and a second request only
 * queues behind the first), long timeouts, and a model listing joined with `lms ls --json` so tool
 * use, context length and a diversity family come from real metadata rather than defaults.
 */
export class LmStudioProvider implements ProviderAdapter {
  readonly id: string;
  readonly kind = "lmstudio";
  readonly concurrency: number | null;
  private readonly inner: OpenAICompatProvider;
  private readonly catalog: LmsCatalogSource;
  private readonly residency: ResidencyScheduler | undefined;
  private readonly contextLength: number;
  private readonly hints: Record<string, Partial<ModelInfo["capabilities"]>>;

  constructor(opts: LmStudioProviderOptions) {
    this.id = opts.id;
    this.residency = opts.residency;
    // With residency the scheduler is the one-at-a-time gate; the lane must be wide enough for it
    // to see several queued calls and batch them by model.
    this.concurrency = opts.concurrency ?? (opts.residency === undefined ? 1 : LMSTUDIO_QUEUE_DEPTH);
    this.contextLength = opts.contextLength ?? LMSTUDIO_DEFAULT_CONTEXT_LENGTH;
    this.hints = opts.capabilityHints ?? {};
    this.catalog = opts.catalog ?? lmsCliCatalog(opts.lmsPath);
    this.inner = new OpenAICompatProvider({
      id: opts.id,
      kind: "lmstudio",
      baseUrl: opts.baseUrl ?? LMSTUDIO_DEFAULT_BASE_URL,
      apiKey: opts.apiKey !== undefined && opts.apiKey.length > 0 ? opts.apiKey : PLACEHOLDER_API_KEY,
      concurrency: this.concurrency,
      timeoutMs: opts.timeoutMs ?? LMSTUDIO_DEFAULT_TIMEOUT_MS,
      adaptPayload: adaptLmStudioPayload,
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    });
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const served = await this.inner.listModels(signal);
    const catalog = await this.catalog(signal).catch((): LmsModelMeta[] => []);
    const index = indexCatalog(catalog);
    const out: ModelInfo[] = [];
    for (const model of served) {
      const row = index.get(model.ref.model);
      if (catalog.length > 0) {
        // `/v1/models` also lists the identifiers of loaded instances (`--identifier night`) and
        // models that are not language models; only a downloaded LLM's own key is a model here.
        if (row?.type !== "llm") continue;
      } else if (/embed/i.test(model.ref.model)) {
        // No `lms` metadata at all: the listing is all there is, minus the obvious non-LLMs.
        continue;
      }
      out.push(toLmStudioModelInfo(this.id, model.ref.model, row, this.contextLength, this.hints[model.ref.model]));
    }
    return out;
  }

  complete(request: CompletionRequest): Promise<CompletionResponse> {
    const residency = this.residency;
    if (residency === undefined) return this.inner.complete(request);
    return residency.run(
      request.model.model,
      (identifier) => this.inner.complete({ ...request, model: { ...request.model, model: identifier } }),
      request.signal,
    );
  }

  health(signal?: AbortSignal): Promise<ProviderHealth> {
    return this.inner.health(signal);
  }
}

/**
 * LM Studio accepts `response_format` `json_schema` and `text` but rejects OpenAI's `json_object`,
 * so a plain "answer in JSON" request becomes an unconstrained-object schema.
 */
export function adaptLmStudioPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const format = payload["response_format"] as { type?: unknown } | undefined;
  if (format?.type !== "json_object") return payload;
  return {
    ...payload,
    response_format: { type: "json_schema", json_schema: { name: "json_object", schema: { type: "object" } } },
  };
}

/**
 * Diversity family for a local model: its lineage (`localLineage`), so two fine-tunes of Qwen are
 * one family and a gpt-oss, Gemma or Granite model is another. `capabilityHints[model].family`
 * overrides it, which is how a user declares that two models are, or are not, the same lineage.
 */
export function lmStudioFamily(modelKey: string, meta?: Pick<LmsModelMeta, "architecture" | "publisher" | "displayName" | "path">): string {
  return localLineage({ modelKey, architecture: meta?.architecture, publisher: meta?.publisher, displayName: meta?.displayName, path: meta?.path });
}

export function toLmStudioModelInfo(
  providerId: string,
  modelKey: string,
  meta: LmsModelMeta | undefined,
  loadedContextLength: number,
  hint: Partial<ModelInfo["capabilities"]> | undefined,
): ModelInfo {
  const contextWindow = Math.min(meta?.maxContextLength ?? loadedContextLength, loadedContextLength);
  const capabilities: ModelInfo["capabilities"] = {
    contextWindow,
    maxOutputTokens: null,
    // Unknown metadata is not "trained for tools": an agent loop on a model that cannot call them fails late.
    supportsTools: meta?.trainedForToolUse ?? false,
    supportsJson: true,
    inputCostPerM: 0,
    outputCostPerM: 0,
    tier: localTier(meta),
    family: lmStudioFamily(modelKey, meta),
    ...hint,
  };
  return { ref: { provider: providerId, model: modelKey }, displayName: meta?.displayName ?? modelKey, capabilities, source: "provider" };
}

/** Never `frontier`: a local model is not trusted to outrank a cloud one. 20B+ parameters (or MoE) is `strong`. */
function localTier(meta: LmsModelMeta | undefined): ModelTier {
  const params = Number.parseFloat(meta?.paramsString ?? "");
  return Number.isFinite(params) && params >= 20 ? "strong" : "fast";
}

/**
 * Keys are not unique per file (two quants of one model can share one); the first row wins, since
 * `lms load` takes only a key and cannot choose between them either.
 */
function indexCatalog(rows: readonly LmsModelMeta[]): Map<string, LmsModelMeta> {
  const index = new Map<string, LmsModelMeta>();
  for (const row of rows) if (!index.has(row.modelKey)) index.set(row.modelKey, row);
  return index;
}

/** Parse `lms ls --json`; tolerant of banners around the JSON and of rows missing a key. */
export function parseLmsCatalog(stdout: string): LmsModelMeta[] {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((row): row is LmsModelMeta => typeof row === "object" && row !== null && typeof (row as { modelKey?: unknown }).modelKey === "string");
}

/** `lms ls --json` via the CLI; any failure (no CLI, no daemon) degrades to "no metadata". */
export function lmsCliCatalog(lmsPath?: string): LmsCatalogSource {
  return (signal) =>
    new Promise((resolve) => {
      const bin = lmsPath ?? defaultLmsPath();
      const options: { timeout: number; maxBuffer: number; signal?: AbortSignal } = { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 };
      if (signal !== undefined) options.signal = signal;
      execFile(bin, ["ls", "--json"], options, (error, stdout) => {
        resolve(error === null ? parseLmsCatalog(stdout) : []);
      });
    });
}
