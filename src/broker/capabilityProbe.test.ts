import { describe, expect, it } from "vitest";
import { probeModelCapabilities } from "./capabilityProbe.js";
import { ModelCatalog } from "./catalog.js";
import { FAKE_CAPABILITIES, ScriptedProvider, reply } from "../providers/scripted.js";
import type { ModelInfo, ProviderAdapter } from "./types.js";
import { id } from "../shared/ids.js";

const RUN = id("run");

function model(name: string, caps = FAKE_CAPABILITIES.strong): ModelInfo {
  return { ref: { provider: "p", model: name }, displayName: name, capabilities: caps, source: "provider" };
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
    expect(result.checks.json.ok).toBe(true);
    expect(result.info.source).toBe("probe");
    expect(result.info.capabilities.supportsTools).toBe(true);
    expect(result.info.capabilities.supportsJson).toBe(true);
  });

  it("clears capabilities when probes fail but health succeeds", async () => {
    const provider = new ScriptedProvider("p", [{ name: "m", capabilities: FAKE_CAPABILITIES.frontier }]);
    provider.script("m", [
      { kind: "reply", content: "plain text only" },
      { kind: "reply", content: "not json" },
    ]);
    const result = await probeModelCapabilities(provider, model("m"), { runId: RUN });
    expect(result.available).toBe(true);
    expect(result.checks.tools.ok).toBe(false);
    expect(result.checks.json.ok).toBe(false);
    expect(result.info.capabilities.supportsTools).toBe(false);
    expect(result.info.capabilities.supportsJson).toBe(false);
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
    expect(provider.calls).toHaveLength(0);
  });
});

describe("ModelCatalog discovery with probes", () => {
  it("disables models on probe failure without crashing provider discovery", async () => {
    const provider = new ScriptedProvider("p", [{ name: "good", capabilities: FAKE_CAPABILITIES.strong }, { name: "bad", capabilities: FAKE_CAPABILITIES.strong }]);
    provider.script("good", [
      { kind: "reply", content: "", toolCalls: [{ id: "t1", name: "probe_ping", arguments: "{}" }] },
      { kind: "reply", content: '{"probe":"ok"}' },
    ]);
    const catalog = new ModelCatalog();
    catalog.register(provider);
    const discovery = await catalog.discover({
      capabilityProbe: async (adapter, m) => {
        if (m.ref.model === "bad") throw new Error("probe exploded");
        return probeModelCapabilities(adapter, m, { runId: RUN });
      },
    });
    expect(discovery.errors["p/bad:probe"]).toMatch(/probe exploded/);
    expect(catalog.get({ provider: "p", model: "good" })?.available).toBe(true);
    expect(catalog.get({ provider: "p", model: "bad" })?.available).toBe(false);
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
      capabilityProbe: (adapter, m) => probeModelCapabilities(adapter, m, { runId: RUN }),
    });
    expect(discovery.errors["fail"]).toMatch(/network down/);
    expect(catalog.get({ provider: "ok", model: "m" })?.available).toBe(true);
    expect(catalog.list().some((e) => e.info.ref.provider === "fail")).toBe(false);
  });
});
