import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CompletionRequest, CompletionResponse, ModelInfo, ModelTier, ProviderAdapter, ProviderHealth } from "../broker/types.js";
import { OpenAICompatProvider, type FetchLike } from "./openaiCompat.js";

export const LMSTUDIO_DEFAULT_BASE_URL = "http://localhost:1234/v1";
/**
 * A dense 27B model needs minutes to read a 40-60k-token prompt and then writes ~25 tok/s; the
 * request is not streamed, so the timeout covers the whole generation (docs/LOCAL.md §a).
 */
export const LMSTUDIO_DEFAULT_TIMEOUT_MS = 30 * 60_000;
/** Context length the models are loaded with (`lms load -c`); LM Studio's own maximum is never used. */
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
  private readonly contextLength: number;
  private readonly hints: Record<string, Partial<ModelInfo["capabilities"]>>;

  constructor(opts: LmStudioProviderOptions) {
    this.id = opts.id;
    this.concurrency = opts.concurrency ?? 1;
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
    // Metadata is a refinement: without the CLI the listing still works from `/v1/models` alone.
    const meta = await this.catalog(signal).catch((): LmsModelMeta[] => []);
    const index = indexCatalog(meta);
    const out: ModelInfo[] = [];
    for (const model of served) {
      const row = index.get(model.ref.model);
      if (isEmbedding(model.ref.model, row)) continue;
      out.push(toLmStudioModelInfo(this.id, model.ref.model, row, this.contextLength, this.hints[model.ref.model]));
    }
    return out;
  }

  complete(request: CompletionRequest): Promise<CompletionResponse> {
    return this.inner.complete(request);
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
 * Diversity family for a local model. Every installed model is Qwen-lineage, so the vendor rule
 * (`inferFamily`: every `qwen*` id is `qwen`) would see one family. The policy (docs/LOCAL.md §c)
 * is that each distinct fine-tune is its own family: architecture + model key. Two quants of one
 * key share a key and therefore a family; `capabilityHints[model].family` overrides it, which is
 * how a user declares that two fine-tunes should count as one.
 */
export function lmStudioFamily(modelKey: string, meta?: Pick<LmsModelMeta, "architecture">): string {
  const arch = slug(meta?.architecture ?? "unknown");
  return `local-${arch}-${slug(modelKey)}`;
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

function isEmbedding(modelKey: string, meta: LmsModelMeta | undefined): boolean {
  return meta !== undefined ? meta.type === "embedding" : /embed/i.test(modelKey);
}

/**
 * Keys are not unique per file (two quants of one model can share one); the first row wins, since
 * `lms load` takes only a key and cannot choose between them either. A loaded model served under
 * a custom `--identifier` is found by its path.
 */
function indexCatalog(rows: readonly LmsModelMeta[]): Map<string, LmsModelMeta> {
  const index = new Map<string, LmsModelMeta>();
  for (const row of rows) if (!index.has(row.modelKey)) index.set(row.modelKey, row);
  for (const row of rows) if (row.path !== undefined && !index.has(row.path)) index.set(row.path, row);
  return index;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
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

function defaultLmsPath(): string {
  const standard = join(homedir(), ".lmstudio", "bin", "lms");
  return existsSync(standard) ? standard : "lms";
}
