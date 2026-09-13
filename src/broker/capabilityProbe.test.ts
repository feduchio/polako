import { describe, expect, it } from "vitest";
import { probeModelCapabilities } from "./capabilityProbe.js";
import { ModelCatalog } from "./catalog.js";
import { buildDiscoveryShortlist } from "./discoveryShortlist.js";
import { FAKE_CAPABILITIES, ScriptedProvider, reply, type ScriptedModel } from "../providers/scripted.js";
import type { ModelInfo, ProviderAdapter } from "./types.js";
import { ProviderError } from "./types.js";
import { id } from "../shared/ids.js";
import { parseModelRefString } from "../daemon/configLoad.js";
import { DISABLED_REASONING } from "./responseSchemas.js";

const RUN = id("run");

function model(name: string, caps: ModelInfo["capabilities"] = FAKE_CAPABILITIES.strong, cost = 1): ModelInfo {
  return {
    ref: { provider: "p", model: name },
    displayName: name,
    capabilities: { ...caps, inputCostPerM: cost, outputCostPerM: cost },
    source: "provider",
  };
}

function manyModels(count: number): ModelInfo[] {
  return Array.from({ length: count }, (_, index) =>
    model(`model-${String(index).padStart(2, "0")}`, FAKE_CAPABILITIES.fast, index + 1),
  );
}

describe("probeModelCapabilities", () => {
  it("records probed tools/json capabilities without trusting provider listings", async () => {
    const provider = new ScriptedProvider("p", [{ name: "m", capabilities: { ...FAKE_CAPABILITIES.frontier, supportsTools: true, supportsJson: true } }]);
    provider.script("m", [
      { kind: "reply", content: "", toolCalls: [{ id: "t1", name: "probe_ping", arguments: "{}" }] },
      { kind: "reply", content: '{"probe":"ok"}' },
    ]);
    const result = await probeModelCapabilities(provider, model("m"), { runId: RUN });
    expect(result.available).toBe(true);
    expect(result.checks.health.ok).toBe(true);
    expect(result.checks.tools.ok).toBe(true);
    expect(result.checks.tools.verdict).toBe("supported");
    expect(result.checks.json.ok).toBe(true);
    expect(result.checks.json.verdict).toBe("supported");
    expect(result.info.source).toBe("probe");
    expect(result.info.capabilities.supportsTools).toBe(true);
    expect(result.info.capabilities.supportsJson).toBe(true);
  });

  it("probes review and score schemas independently and fail-closed", async () => {
    const provider = new ScriptedProvider("p", [{ name: "m", capabilities: FAKE_CAPABILITIES.strong }]);
    provider.script("m", [
      { kind: "reply", content: "", toolCalls: [{ id: "t1", name: "probe_ping", arguments: "{}" }] },
      { kind: "reply", content: '{"probe":"ok"}' },
    ]);
    const purposes: string[] = [];
    const result = await probeModelCapabilities(provider, model("m"), {
      runId: RUN,
      strictComplete: (request) => {
        purposes.push(request.metadata.purpose);
        expect(request.reasoning).toEqual(DISABLED_REASONING);
        return Promise.resolve({
          message: {
            role: "assistant",
            content: request.metadata.purpose.endsWith("review")
              ? '{"findings":[]}'
              : '{"scoreA":4,"scoreB":"bad"}',
          },
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
          finishReason: "stop",
          latencyMs: 1,
        });
      },
    });
    expect(purposes).toEqual([
      "capability_probe_strict_review",
      "capability_probe_strict_score",
      "capability_probe_strict_progress",
    ]);
    expect(result.checks.strictReview.verdict).toBe("supported");
    expect(result.checks.strictScore.verdict).toBe("unsupported");
    expect(result.info.capabilities.supportsStrictReviewSchema).toBe(true);
    expect(result.info.capabilities.supportsStrictScoreSchema).toBe(false);
    expect(result.info.capabilities.supportsStrictProgressSchema).toBe(false);
  });

  it("does not inherit strict support from advertisements on timeout", async () => {
    const provider = new ScriptedProvider("p", [{ name: "m", capabilities: FAKE_CAPABILITIES.strong }]);
    provider.script("m", [
      { kind: "reply", content: "", toolCalls: [{ id: "t1", name: "probe_ping", arguments: "{}" }] },
      { kind: "reply", content: '{"probe":"ok"}' },
    ]);
    const result = await probeModelCapabilities(provider, model("m", {
      ...FAKE_CAPABILITIES.strong,
      supportsStrictReviewSchema: true,
      supportsStrictScoreSchema: true,
      supportsStrictProgressSchema: true,
    }), {
      runId: RUN,
      strictComplete: () => Promise.reject(new ProviderError("p", "timeout", "timed out")),
    });
    expect(result.checks.strictReview.verdict).toBe("inconclusive");
    expect(result.checks.strictScore.verdict).toBe("inconclusive");
    expect(result.checks.strictProgress.verdict).toBe("inconclusive");
    expect(result.info.capabilities.supportsStrictReviewSchema).toBe(false);
    expect(result.info.capabilities.supportsStrictScoreSchema).toBe(false);
    expect(result.info.capabilities.supportsStrictProgressSchema).toBe(false);
  });

  it.each([
    ["explicit 400", new ProviderError("p", "bad_request", "schema rejected"), "unsupported"],
    ["probe failure", new Error("transport broke"), "probe_failed"],
  ] as const)("records %s as fail-closed strict support", async (_label, error, verdict) => {
    const provider = new ScriptedProvider("p", [{ name: "m", capabilities: FAKE_CAPABILITIES.strong }]);
    provider.script("m", [
      { kind: "reply", content: "", toolCalls: [{ id: "t1", name: "probe_ping", arguments: "{}" }] },
      { kind: "reply", content: '{"probe":"ok"}' },
    ]);
    const result = await probeModelCapabilities(provider, model("m", {
      ...FAKE_CAPABILITIES.strong,
      supportsStrictReviewSchema: true,
      supportsStrictScoreSchema: true,
      supportsStrictProgressSchema: true,
    }), {
      runId: RUN,
      strictComplete: () => Promise.reject(error),
    });
    expect(result.checks.strictReview.verdict).toBe(verdict);
    expect(result.checks.strictScore.verdict).toBe(verdict);
    expect(result.checks.strictProgress.verdict).toBe(verdict);
    expect(result.info.capabilities.supportsStrictReviewSchema).toBe(false);
    expect(result.info.capabilities.supportsStrictScoreSchema).toBe(false);
    expect(result.info.capabilities.supportsStrictProgressSchema).toBe(false);
  });

  it("reuses cached strict probe results without another strict call", async () => {
    const provider = new ScriptedProvider("p", [{ name: "m", capabilities: FAKE_CAPABILITIES.strong }]);
    provider.script("m", [
      { kind: "reply", content: "", toolCalls: [{ id: "t1", name: "probe_ping", arguments: "{}" }] },
      { kind: "reply", content: '{"probe":"ok"}' },
    ]);
    let strictCalls = 0;
    const result = await probeModelCapabilities(provider, model("m"), {
      runId: RUN,
      cachedStrict: { review: true, score: false, progress: true },
      strictComplete: () => {
        strictCalls++;
        throw new Error("must not run");
      },
    });
    expect(strictCalls).toBe(0);
    expect(result.info.capabilities.supportsStrictReviewSchema).toBe(true);
    expect(result.info.capabilities.supportsStrictScoreSchema).toBe(false);
    expect(result.info.capabilities.supportsStrictProgressSchema).toBe(true);
  });

  it("keeps progress support independent from pair-score support", async () => {
    const provider = new ScriptedProvider("p", [{ name: "m", capabilities: FAKE_CAPABILITIES.strong }]);
    provider.script("m", [
      { kind: "reply", content: "", toolCalls: [{ id: "t1", name: "probe_ping", arguments: "{}" }] },
      { kind: "reply", content: '{"probe":"ok"}' },
    ]);
    const result = await probeModelCapabilities(provider, model("m"), {
      runId: RUN,
      strictComplete: (request) => Promise.resolve({
        message: {
          role: "assistant",
          content: request.metadata.purpose.endsWith("review")
            ? '{"findings":[]}'
            : request.metadata.purpose.endsWith("progress")
              ? '{"progress":0}'
              : '{"progress":0}',
        },
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        finishReason: "stop",
        latencyMs: 1,
      }),
    });
    expect(result.info.capabilities.supportsStrictReviewSchema).toBe(true);
    expect(result.info.capabilities.supportsStrictScoreSchema).toBe(false);
    expect(result.info.capabilities.supportsStrictProgressSchema).toBe(true);
  });

  it("treats finish=stop prose without tool_calls as inconclusive and preserves declared supportsTools", async () => {
    const provider = new ScriptedProvider("p", [{ name: "m", capabilities: FAKE_CAPABILITIES.frontier }]);
    provider.script("m", [
      { kind: "reply", content: "plain text only" },
      { kind: "reply", content: "not json" },
    ]);
    const result = await probeModelCapabilities(provider, model("m"), { runId: RUN });
    expect(result.available).toBe(true);
    expect(result.checks.tools.ok).toBe(false);
    expect(result.checks.tools.verdict).toBe("inconclusive");
    expect(result.info.capabilities.supportsTools).toBe(true);
    expect(result.checks.json.ok).toBe(false);
    expect(result.checks.json.verdict).toBe("unsupported");
    expect(result.info.capabilities.supportsJson).toBe(false);
  });

  it("treats ProviderError timeout on tools probe as inconclusive and preserves declared supportsTools", async () => {
    const provider = new ScriptedProvider("p", [
      { name: "m", capabilities: { ...FAKE_CAPABILITIES.strong, supportsTools: true, supportsJson: true } },
    ]);
    provider.script("m", [
      { kind: "error", error: new ProviderError("p", "timeout", "request timed out") },
      { kind: "reply", content: '{"probe":"ok"}' },
    ]);
    const result = await probeModelCapabilities(provider, model("m"), { runId: RUN });
    expect(result.available).toBe(true);
    expect(result.checks.tools.verdict).toBe("inconclusive");
    expect(result.info.capabilities.supportsTools).toBe(true);
    expect(result.checks.json.verdict).toBe("supported");
  });

  it("treats finish=length as inconclusive and preserves declared supportsTools", async () => {
    const provider = new ScriptedProvider("p", [
      { name: "m", capabilities: { ...FAKE_CAPABILITIES.strong, supportsTools: true, supportsJson: true } },
    ]);
    provider.script("m", [
      { kind: "fn", fn: () => reply("truncated", 10, 5, null, undefined, "length") },
      { kind: "reply", content: '{"probe":"ok"}' },
    ]);
    const result = await probeModelCapabilities(provider, model("m"), { runId: RUN, maxTokens: 256 });
    expect(result.available).toBe(true);
    expect(result.checks.tools.verdict).toBe("inconclusive");
    expect(result.info.capabilities.supportsTools).toBe(true);
    expect(result.checks.json.verdict).toBe("supported");
  });

  it("treats tools finish=error with prose as inconclusive and preserves declared supportsTools", async () => {
    const provider = new ScriptedProvider("p", [
      { name: "m", capabilities: { ...FAKE_CAPABILITIES.strong, supportsTools: true, supportsJson: true } },
    ]);
    provider.script("m", [
      { kind: "fn", fn: () => reply("plain text only", 10, 5, null, undefined, "error") },
      { kind: "reply", content: '{"probe":"ok"}' },
    ]);
    const result = await probeModelCapabilities(provider, model("m"), { runId: RUN });
    expect(result.available).toBe(true);
    expect(result.checks.tools.verdict).toBe("inconclusive");
    expect(result.info.capabilities.supportsTools).toBe(true);
    expect(result.checks.json.verdict).toBe("supported");
  });

  it("treats tools finish=content_filter as inconclusive and preserves declared supportsTools", async () => {
    const provider = new ScriptedProvider("p", [
      { name: "m", capabilities: { ...FAKE_CAPABILITIES.strong, supportsTools: true, supportsJson: true } },
    ]);
    provider.script("m", [
      { kind: "fn", fn: () => reply("", 10, 5, null, undefined, "content_filter") },
      { kind: "reply", content: '{"probe":"ok"}' },
    ]);
    const result = await probeModelCapabilities(provider, model("m"), { runId: RUN });
    expect(result.available).toBe(true);
    expect(result.checks.tools.verdict).toBe("inconclusive");
    expect(result.info.capabilities.supportsTools).toBe(true);
    expect(result.checks.json.verdict).toBe("supported");
  });

  it("treats json finish=error with valid JSON body as supported", async () => {
    const provider = new ScriptedProvider("p", [
      { name: "m", capabilities: { ...FAKE_CAPABILITIES.strong, supportsTools: true, supportsJson: true } },
    ]);
    provider.script("m", [
      { kind: "reply", content: "", toolCalls: [{ id: "t1", name: "probe_ping", arguments: "{}" }] },
      { kind: "fn", fn: () => reply('{"probe":"ok"}', 10, 5, null, undefined, "error") },
    ]);
    const result = await probeModelCapabilities(provider, model("m"), { runId: RUN });
    expect(result.available).toBe(true);
    expect(result.checks.json.verdict).toBe("supported");
    expect(result.info.capabilities.supportsJson).toBe(true);
  });

  it("disables the model when health fails", async () => {
    const provider = new ScriptedProvider("p", [{ name: "m", capabilities: FAKE_CAPABILITIES.fast }]);
    const unhealthy = {
      health: () => Promise.resolve({ ok: false, checkedAt: Date.now(), detail: "down" }),
      listModels: provider.listModels.bind(provider),
      complete: provider.complete.bind(provider),
      id: provider.id,
      kind: provider.kind,
      concurrency: provider.concurrency,
    };
    const result = await probeModelCapabilities(unhealthy, model("m"), { runId: RUN });
    expect(result.available).toBe(false);
    expect(result.checks.health.ok).toBe(false);
    expect(result.checks.health.verdict).toBe("unsupported");
    expect(provider.calls).toHaveLength(0);
  });
});

describe("bounded catalog discovery", () => {
  it("strips strict capability advertisements until a probe or observation supplies them", () => {
    const catalog = new ModelCatalog();
    const advertised = model("m", {
      ...FAKE_CAPABILITIES.strong,
      supportsStrictReviewSchema: true,
      supportsStrictScoreSchema: true,
      supportsStrictProgressSchema: true,
    });
    catalog.upsert(advertised);
    expect(catalog.get(advertised.ref)?.info.capabilities.supportsStrictReviewSchema).toBeUndefined();
    expect(catalog.get(advertised.ref)?.info.capabilities.supportsStrictScoreSchema).toBeUndefined();
    expect(catalog.get(advertised.ref)?.info.capabilities.supportsStrictProgressSchema).toBeUndefined();
    catalog.upsert({ ...advertised, source: "probe" });
    expect(catalog.get(advertised.ref)?.info.capabilities.supportsStrictReviewSchema).toBe(true);
    expect(catalog.get(advertised.ref)?.info.capabilities.supportsStrictScoreSchema).toBe(true);
    expect(catalog.get(advertised.ref)?.info.capabilities.supportsStrictProgressSchema).toBe(true);
  });

  it("probes only the shortlist cap, not every listed model", async () => {
    const models: ScriptedModel[] = Array.from({ length: 50 }, (_, index) => ({
      name: `model-${String(index).padStart(2, "0")}`,
      capabilities: { ...FAKE_CAPABILITIES.fast, inputCostPerM: index, outputCostPerM: index },
    }));
    const provider = new ScriptedProvider("p", models);
    for (const entry of models) {
      provider.script(entry.name, [
        { kind: "reply", content: "", toolCalls: [{ id: "t1", name: "probe_ping", arguments: "{}" }] },
        { kind: "reply", content: '{"probe":"ok"}' },
      ]);
    }
    const catalog = new ModelCatalog();
    catalog.register(provider);
    const discovery = await catalog.discover({
      maxProbesPerProvider: 3,
      pinnedModels: [],
      capabilityProbe: (adapter, m) => probeModelCapabilities(adapter, m, { runId: RUN, skipHealth: true }),
    });
    expect(discovery.discovered).toBe(50);
    expect(discovery.probes).toHaveLength(3);
    const probeCalls = provider.calls.filter((call) => call.metadata.purpose.startsWith("capability_probe"));
    expect(probeCalls).toHaveLength(6);
    expect(catalog.list()).toHaveLength(50);
  });

  it("always probes pinned supervisor models in addition to the shortlist cap", async () => {
    const models: ScriptedModel[] = Array.from({ length: 50 }, (_, index) => ({
      name: `model-${String(index).padStart(2, "0")}`,
      capabilities: { ...FAKE_CAPABILITIES.fast, inputCostPerM: index, outputCostPerM: index },
    }));
    models.push({ name: "pinned-council", capabilities: { ...FAKE_CAPABILITIES.strong } });
    const provider = new ScriptedProvider("p", models);
    for (const entry of models) {
      provider.script(entry.name, [
        { kind: "reply", content: "", toolCalls: [{ id: "t1", name: "probe_ping", arguments: "{}" }] },
        { kind: "reply", content: '{"probe":"ok"}' },
      ]);
    }
    const catalog = new ModelCatalog();
    catalog.register(provider);
    const discovery = await catalog.discover({
      maxProbesPerProvider: 3,
      pinnedModels: [parseModelRefString("p:pinned-council")],
      capabilityProbe: (adapter, m) => probeModelCapabilities(adapter, m, { runId: RUN, skipHealth: true }),
    });
    expect(discovery.probes).toHaveLength(4);
    expect(discovery.probes.some((probe) => probe.info.ref.model === "pinned-council")).toBe(true);
  });

  it("records probe errors without disabling models when health succeeded", async () => {
    const provider = new ScriptedProvider("p", [{ name: "good", capabilities: FAKE_CAPABILITIES.strong }, { name: "bad", capabilities: FAKE_CAPABILITIES.strong }]);
    provider.script("good", [
      { kind: "reply", content: "", toolCalls: [{ id: "t1", name: "probe_ping", arguments: "{}" }] },
      { kind: "reply", content: '{"probe":"ok"}' },
    ]);
    const catalog = new ModelCatalog();
    catalog.register(provider);
    const discovery = await catalog.discover({
      maxProbesPerProvider: 8,
      pinnedModels: [],
      capabilityProbe: async (adapter, m) => {
        if (m.ref.model === "bad") throw new Error("probe exploded");
        return probeModelCapabilities(adapter, m, { runId: RUN, skipHealth: true });
      },
    });
    expect(discovery.errors["p/bad:probe"]).toMatch(/probe exploded/);
    expect(catalog.get({ provider: "p", model: "good" })?.available).toBe(true);
    expect(catalog.get({ provider: "p", model: "bad" })?.available).toBe(true);
    expect(catalog.get({ provider: "p", model: "good" })?.info.source).toBe("probe");
  });

  it("survives listModels failure for one provider", async () => {
    const ok = new ScriptedProvider("ok", [{ name: "m", capabilities: FAKE_CAPABILITIES.fast }]);
    ok.script("m", [
      { kind: "fn", fn: () => reply("", 1, 1, null, [{ id: "t", name: "probe_ping", arguments: "{}" }]) },
      { kind: "fn", fn: () => reply('{"probe":"ok"}') },
    ]);
    const fail = new ScriptedProvider("fail", [{ name: "x", capabilities: FAKE_CAPABILITIES.fast }]);
    const broken: ProviderAdapter = {
      id: fail.id,
      kind: fail.kind,
      concurrency: fail.concurrency,
      listModels: () => Promise.reject(new Error("network down")),
      complete: fail.complete.bind(fail),
      health: fail.health.bind(fail),
    };
    const catalog = new ModelCatalog();
    catalog.register(ok);
    catalog.register(broken);
    const discovery = await catalog.discover({
      maxProbesPerProvider: 8,
      pinnedModels: [],
      capabilityProbe: (adapter, m) => probeModelCapabilities(adapter, m, { runId: RUN, skipHealth: true }),
    });
    expect(discovery.errors["fail"]).toMatch(/network down/);
    expect(catalog.get({ provider: "ok", model: "m" })?.available).toBe(true);
    expect(catalog.list().some((e) => e.info.ref.provider === "fail")).toBe(false);
  });
});

describe("buildDiscoveryShortlist", () => {
  it("prefers cheaper declared-tool models after pinned refs", () => {
    const models = manyModels(5);
    const shortlist = buildDiscoveryShortlist(models, "p", [models[4]!.ref], 2);
    expect(shortlist.map((entry) => entry.ref.model)).toEqual(["model-04", "model-00", "model-01"]);
  });

  it("under free_only excludes paid and unknown prices except pinned supervisors", () => {
    const models = [
      ...manyModels(3),
      model("free-zero", FAKE_CAPABILITIES.fast, 0),
      {
        ref: { provider: "p", model: "unknown-price" },
        displayName: "unknown-price",
        capabilities: { ...FAKE_CAPABILITIES.fast, inputCostPerM: null, outputCostPerM: null },
        source: "provider" as const,
      },
    ];
    const shortlist = buildDiscoveryShortlist(models, "p", [models[2]!.ref], 8, {
      mode: "free_only",
      maxInputCostPerM: 0,
      maxOutputCostPerM: 0,
    });
    expect(shortlist.map((entry) => entry.ref.model)).toEqual(["model-02", "free-zero"]);
  });
});
