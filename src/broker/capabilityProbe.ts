import type { ModelInfo, ProviderAdapter, CompletionRequest } from "./types.js";
import { ProviderError } from "./types.js";
import {
  DISABLED_REASONING,
  EMPIRICAL_SCORE_RESPONSE_SCHEMA,
  PROGRESS_SCORE_RESPONSE_SCHEMA,
  REVIEW_FINDINGS_RESPONSE_SCHEMA,
} from "./responseSchemas.js";

export type ProbeVerdict = "supported" | "unsupported" | "inconclusive" | "probe_failed";

export interface CapabilityProbeCheck {
  ok: boolean;
  verdict: ProbeVerdict;
  detail?: string;
}

export interface CapabilityProbeChecks {
  health: CapabilityProbeCheck;
  tools: CapabilityProbeCheck;
  json: CapabilityProbeCheck;
  strictReview: CapabilityProbeCheck;
  strictScore: CapabilityProbeCheck;
  strictProgress: CapabilityProbeCheck;
}

export interface CapabilityProbeResult {
  info: ModelInfo;
  available: boolean;
  checks: CapabilityProbeChecks;
}

const PROBE_TOOL = {
  name: "probe_ping",
  description: "Return ok when invoked.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const DEFAULT_PROBE_MAX_TOKENS = 256;

/**
 * Actively verify health/tools/json for one model. Declared capabilities are preserved when
 * probes are inconclusive or fail without an explicit denial.
 */
export async function probeModelCapabilities(
  adapter: ProviderAdapter,
  model: ModelInfo,
  ctx: {
    runId: string;
    signal?: AbortSignal;
    maxTokens?: number;
    skipHealth?: boolean;
    strictComplete?: ProviderAdapter["complete"];
    cachedStrict?: { review?: boolean; score?: boolean; progress?: boolean };
  },
): Promise<CapabilityProbeResult> {
  const probeMaxTokens = ctx.maxTokens ?? DEFAULT_PROBE_MAX_TOKENS;
  const checks: CapabilityProbeChecks = {
    health: { ok: false, verdict: "unsupported" },
    tools: { ok: false, verdict: "probe_failed" },
    json: { ok: false, verdict: "probe_failed" },
    strictReview: { ok: false, verdict: "probe_failed" },
    strictScore: { ok: false, verdict: "probe_failed" },
    strictProgress: { ok: false, verdict: "probe_failed" },
  };

  if (ctx.skipHealth !== true) {
    const health = await adapter.health(ctx.signal);
    checks.health = health.ok
      ? { ok: true, verdict: "supported", ...(health.detail !== undefined ? { detail: health.detail } : {}) }
      : { ok: false, verdict: "unsupported", ...(health.detail !== undefined ? { detail: health.detail } : {}) };
    if (!health.ok) {
      return {
        info: probedInfo(model, model.capabilities.supportsTools, model.capabilities.supportsJson, false, false, false),
        available: false,
        checks,
      };
    }
  } else {
    checks.health = { ok: true, verdict: "supported" };
  }

  let toolsVerdict: ProbeVerdict;
  try {
    const toolsRequest: CompletionRequest = {
      model: model.ref,
      messages: [{ role: "user", content: "Call probe_ping." }],
      tools: [PROBE_TOOL],
      maxTokens: probeMaxTokens,
      temperature: 0,
      metadata: { runId: ctx.runId, purpose: "capability_probe_tools", role: "probe" },
    };
    if (ctx.signal !== undefined) toolsRequest.signal = ctx.signal;
    const tools = await adapter.complete(toolsRequest);
    const hasToolCalls = tools.finishReason === "tool_calls" || (tools.message.toolCalls?.length ?? 0) > 0;
    toolsVerdict = hasToolCalls ? "supported" : "inconclusive";
    checks.tools = {
      ok: toolsVerdict === "supported",
      verdict: toolsVerdict,
      ...(toolsVerdict === "supported" ? {} : { detail: `finish=${tools.finishReason}` }),
    };
  } catch (err) {
    toolsVerdict = probeErrorVerdict(err);
    checks.tools = { ok: false, verdict: toolsVerdict, detail: probeErrorDetail(err) };
  }

  const strictReviewVerdict = ctx.cachedStrict?.review === undefined && ctx.strictComplete !== undefined
    ? await strictProbe(
        ctx.strictComplete,
        model,
        ctx,
        probeMaxTokens,
        REVIEW_FINDINGS_RESPONSE_SCHEMA,
        (value) => isRecord(value) && Array.isArray(value["findings"]),
        "capability_probe_strict_review",
      )
    : ctx.cachedStrict?.review === undefined ? "probe_failed" : ctx.cachedStrict.review ? "supported" : "unsupported";
  checks.strictReview = checkFromStrictVerdict(strictReviewVerdict);

  const strictScoreVerdict = ctx.cachedStrict?.score === undefined && ctx.strictComplete !== undefined
    ? await strictProbe(
        ctx.strictComplete,
        model,
        ctx,
        probeMaxTokens,
        EMPIRICAL_SCORE_RESPONSE_SCHEMA,
        (value) => isRecord(value) &&
          Object.keys(value).sort().join(",") === "scoreA,scoreB" &&
          isScore(value["scoreA"]) &&
          isScore(value["scoreB"]),
        "capability_probe_strict_score",
      )
    : ctx.cachedStrict?.score === undefined ? "probe_failed" : ctx.cachedStrict.score ? "supported" : "unsupported";
  checks.strictScore = checkFromStrictVerdict(strictScoreVerdict);

  const strictProgressVerdict = ctx.cachedStrict?.progress === undefined && ctx.strictComplete !== undefined
    ? await strictProbe(
        ctx.strictComplete,
        model,
        ctx,
        probeMaxTokens,
        PROGRESS_SCORE_RESPONSE_SCHEMA,
        (value) => isRecord(value) &&
          Object.keys(value).join(",") === "progress" &&
          isScore(value["progress"]),
        "capability_probe_strict_progress",
      )
    : ctx.cachedStrict?.progress === undefined
      ? "probe_failed"
      : ctx.cachedStrict.progress ? "supported" : "unsupported";
  checks.strictProgress = checkFromStrictVerdict(strictProgressVerdict);

  let jsonVerdict: ProbeVerdict;
  try {
    const jsonRequest: CompletionRequest = {
      model: model.ref,
      messages: [{ role: "user", content: 'Reply with JSON only: {"probe":"ok"}' }],
      responseFormat: "json",
      maxTokens: probeMaxTokens,
      temperature: 0,
      metadata: { runId: ctx.runId, purpose: "capability_probe_json", role: "probe" },
    };
    if (ctx.signal !== undefined) jsonRequest.signal = ctx.signal;
    const json = await adapter.complete(jsonRequest);
    if (looksLikeJson(json.message.content)) {
      jsonVerdict = "supported";
    } else if (isInconclusiveJsonResult(json.finishReason, json.message.content)) {
      jsonVerdict = "inconclusive";
    } else {
      jsonVerdict = "unsupported";
    }
    checks.json = {
      ok: jsonVerdict === "supported",
      verdict: jsonVerdict,
      ...(jsonVerdict === "supported" ? {} : { detail: `content=${json.message.content.slice(0, 40)}` }),
    };
  } catch (err) {
    jsonVerdict = probeErrorVerdict(err);
    checks.json = { ok: false, verdict: jsonVerdict, detail: probeErrorDetail(err) };
  }

  return {
    info: probedInfo(
      model,
      resolveCapability(model.capabilities.supportsTools, toolsVerdict),
      resolveCapability(model.capabilities.supportsJson, jsonVerdict),
      strictReviewVerdict === "supported",
      strictScoreVerdict === "supported",
      strictProgressVerdict === "supported",
    ),
    available: checks.health.ok,
    checks,
  };
}

function resolveCapability(declared: boolean, verdict: ProbeVerdict): boolean {
  if (verdict === "supported") return true;
  if (verdict === "unsupported") return false;
  return declared;
}

async function strictProbe(
  complete: ProviderAdapter["complete"],
  model: ModelInfo,
  ctx: { runId: string; signal?: AbortSignal },
  maxTokens: number,
  responseSchema: NonNullable<CompletionRequest["responseSchema"]>,
  accepts: (value: unknown) => boolean,
  purpose: string,
): Promise<ProbeVerdict> {
  try {
    const request: CompletionRequest = {
      model: model.ref,
      messages: [{ role: "user", content: "Return an empty valid response for the supplied schema." }],
      responseSchema,
      reasoning: DISABLED_REASONING,
      maxTokens,
      temperature: 0,
      metadata: { runId: ctx.runId, purpose, role: "probe", retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } },
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    };
    const response = await complete(request);
    const value: unknown = JSON.parse(response.message.content);
    return accepts(value) ? "supported" : "unsupported";
  } catch (error) {
    return probeErrorVerdict(error);
  }
}

function checkFromStrictVerdict(verdict: ProbeVerdict): CapabilityProbeCheck {
  return { ok: verdict === "supported", verdict };
}

function isScore(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 4;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function probedInfo(
  model: ModelInfo,
  supportsTools: boolean,
  supportsJson: boolean,
  supportsStrictReviewSchema: boolean,
  supportsStrictScoreSchema: boolean,
  supportsStrictProgressSchema: boolean,
): ModelInfo {
  return {
    ...model,
    source: "probe",
    capabilities: {
      ...model.capabilities,
      supportsTools,
      supportsJson,
      supportsStrictReviewSchema,
      supportsStrictScoreSchema,
      supportsStrictProgressSchema,
    },
  };
}

function isInconclusiveJsonResult(finishReason: string, content: string): boolean {
  if (finishReason === "length") return true;
  if (content.trim().length === 0) return true;
  if (finishReason === "error") return true;
  if (finishReason === "content_filter") return true;
  return false;
}

function explicitDenial(err: unknown): boolean {
  return err instanceof ProviderError && err.kind === "bad_request";
}

function probeErrorVerdict(err: unknown): ProbeVerdict {
  if (explicitDenial(err)) return "unsupported";
  if (err instanceof ProviderError && err.kind === "timeout") return "inconclusive";
  return "probe_failed";
}

function looksLikeJson(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function probeErrorDetail(err: unknown): string {
  if (err instanceof ProviderError) return `${err.kind}: ${err.message.slice(0, 120)}`;
  return err instanceof Error ? err.message.slice(0, 120) : String(err);
}
