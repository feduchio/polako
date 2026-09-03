import type { ModelInfo, ProviderAdapter, CompletionRequest } from "./types.js";
import { ProviderError } from "./types.js";

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
  ctx: { runId: string; signal?: AbortSignal; maxTokens?: number; skipHealth?: boolean },
): Promise<CapabilityProbeResult> {
  const probeMaxTokens = ctx.maxTokens ?? DEFAULT_PROBE_MAX_TOKENS;
  const checks: CapabilityProbeChecks = {
    health: { ok: false, verdict: "unsupported" },
    tools: { ok: false, verdict: "probe_failed" },
    json: { ok: false, verdict: "probe_failed" },
  };

  if (ctx.skipHealth !== true) {
    const health = await adapter.health(ctx.signal);
    checks.health = health.ok
      ? { ok: true, verdict: "supported", ...(health.detail !== undefined ? { detail: health.detail } : {}) }
      : { ok: false, verdict: "unsupported", ...(health.detail !== undefined ? { detail: health.detail } : {}) };
    if (!health.ok) {
      return {
        info: probedInfo(model, model.capabilities.supportsTools, model.capabilities.supportsJson),
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

function probedInfo(model: ModelInfo, supportsTools: boolean, supportsJson: boolean): ModelInfo {
  return {
    ...model,
    source: "probe",
    capabilities: { ...model.capabilities, supportsTools, supportsJson },
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
