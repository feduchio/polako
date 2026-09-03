import type { ModelInfo, ProviderAdapter, CompletionRequest } from "./types.js";
import { ProviderError } from "./types.js";

export interface CapabilityProbeChecks {
  health: { ok: boolean; detail?: string };
  tools: { ok: boolean; detail?: string };
  json: { ok: boolean; detail?: string };
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

/**
 * Actively verify health/tools/json for one model. Listing metadata is not trusted:
 * failed checks disable the model or clear the corresponding capability flag.
 */
export async function probeModelCapabilities(
  adapter: ProviderAdapter,
  model: ModelInfo,
  ctx: { runId: string; signal?: AbortSignal },
): Promise<CapabilityProbeResult> {
  const checks: CapabilityProbeChecks = {
    health: { ok: false },
    tools: { ok: false },
    json: { ok: false },
  };

  const health = await adapter.health(ctx.signal);
  checks.health = health.ok ? { ok: true, ...(health.detail !== undefined ? { detail: health.detail } : {}) } : { ok: false, ...(health.detail !== undefined ? { detail: health.detail } : {}) };
  if (!health.ok) {
    return {
      info: probedInfo(model, model.capabilities.supportsTools, model.capabilities.supportsJson),
      available: false,
      checks,
    };
  }

  let supportsTools = false;
  try {
    const toolsRequest: CompletionRequest = {
      model: model.ref,
      messages: [{ role: "user", content: "Call probe_ping." }],
      tools: [PROBE_TOOL],
      maxTokens: 32,
      temperature: 0,
      metadata: { runId: ctx.runId, purpose: "capability_probe_tools", role: "probe" },
    };
    if (ctx.signal !== undefined) toolsRequest.signal = ctx.signal;
    const tools = await adapter.complete(toolsRequest);
    supportsTools = tools.finishReason === "tool_calls" || (tools.message.toolCalls?.length ?? 0) > 0;
    checks.tools = supportsTools ? { ok: true } : { ok: false, detail: `finish=${tools.finishReason}` };
  } catch (err) {
    checks.tools = { ok: false, detail: probeErrorDetail(err) };
  }

  let supportsJson = false;
  try {
    const jsonRequest: CompletionRequest = {
      model: model.ref,
      messages: [{ role: "user", content: 'Reply with JSON only: {"probe":"ok"}' }],
      responseFormat: "json",
      maxTokens: 32,
      temperature: 0,
      metadata: { runId: ctx.runId, purpose: "capability_probe_json", role: "probe" },
    };
    if (ctx.signal !== undefined) jsonRequest.signal = ctx.signal;
    const json = await adapter.complete(jsonRequest);
    supportsJson = json.finishReason !== "error" && looksLikeJson(json.message.content);
    checks.json = supportsJson ? { ok: true } : { ok: false, detail: `content=${json.message.content.slice(0, 40)}` };
  } catch (err) {
    checks.json = { ok: false, detail: probeErrorDetail(err) };
  }

  const available = checks.health.ok;
  return {
    info: probedInfo(model, supportsTools, supportsJson),
    available,
    checks,
  };
}

function probedInfo(model: ModelInfo, supportsTools: boolean, supportsJson: boolean): ModelInfo {
  return {
    ...model,
    source: "probe",
    capabilities: { ...model.capabilities, supportsTools, supportsJson },
  };
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
