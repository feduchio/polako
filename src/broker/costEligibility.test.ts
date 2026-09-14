import { describe, expect, it } from "vitest";
import { probeModelCapabilities } from "./capabilityProbe.js";
import { ModelCatalog } from "./catalog.js";
import {
  FREE_ONLY_COST_ELIGIBILITY,
  isCostEligible,
  isExplicitlyFree,
  type CostEligibilityPolicy,
} from "./costEligibility.js";
import { DEFAULT_ROUTER_POLICY, ModelRouter } from "./router.js";
import { FAKE_CAPABILITIES, ScriptedProvider, type ScriptedModel } from "../providers/scripted.js";
import { id } from "../shared/ids.js";

const RUN = id("run");

function freeOnlyRouter(catalog: ModelCatalog): ModelRouter {
  return new ModelRouter(catalog, { ...DEFAULT_ROUTER_POLICY, costEligibility: FREE_ONLY_COST_ELIGIBILITY });
}

describe("cost eligibility", () => {
  it("treats only explicit 0/0 prices as free; null is not free", () => {
    expect(isExplicitlyFree({ inputCostPerM: 0, outputCostPerM: 0 })).toBe(true);
    expect(isCostEligible({ inputCostPerM: 0, outputCostPerM: 0 }, FREE_ONLY_COST_ELIGIBILITY)).toBe(true);
    expect(isCostEligible({ inputCostPerM: null, outputCostPerM: 0 }, FREE_ONLY_COST_ELIGIBILITY)).toBe(false);
    expect(isCostEligible({ inputCostPerM: 0, outputCostPerM: null }, FREE_ONLY_COST_ELIGIBILITY)).toBe(false);
    expect(isCostEligible({ inputCostPerM: null, outputCostPerM: null }, FREE_ONLY_COST_ELIGIBILITY)).toBe(false);
    expect(isCostEligible({ inputCostPerM: 0, outputCostPerM: 0.01 }, FREE_ONLY_COST_ELIGIBILITY)).toBe(false);
  });

  it("admits no unstated price under a ceiling, and a negative advertised price is unstated", () => {
    const ceiling: CostEligibilityPolicy = { mode: "ceiling", maxInputCostPerM: 0.3, maxOutputCostPerM: 1.2 };
    expect(isCostEligible({ inputCostPerM: 0.3, outputCostPerM: 1.2 }, ceiling)).toBe(true);
    expect(isCostEligible({ inputCostPerM: 0, outputCostPerM: 0 }, ceiling)).toBe(true);
    expect(isCostEligible({ inputCostPerM: 0.31, outputCostPerM: 1.2 }, ceiling)).toBe(false);
    expect(isCostEligible({ inputCostPerM: null, outputCostPerM: 1.2 }, ceiling)).toBe(false);
    // OpenRouter's "-1" for a route whose price depends on where it routes. `<=` used to pass it,
    // and openrouter/fusion then billed $0.003825 for 745 input tokens — 17x this ceiling.
    expect(isCostEligible({ inputCostPerM: -1_000_000, outputCostPerM: -1_000_000 }, ceiling)).toBe(false);
    expect(isCostEligible({ inputCostPerM: -1_000_000, outputCostPerM: -1_000_000 }, FREE_ONLY_COST_ELIGIBILITY)).toBe(false);
    expect(isCostEligible({ inputCostPerM: Number.NaN, outputCostPerM: 0 }, ceiling)).toBe(false);
  });

  it("does not let a paid higher-tier model beat a free lower-tier model under free_only", () => {
    const catalog = new ModelCatalog();
    catalog.register(new ScriptedProvider("p", []));
    catalog.upsert({
      ref: { provider: "p", model: "paid-frontier" },
      displayName: "paid-frontier",
      capabilities: { ...FAKE_CAPABILITIES.frontier, family: "paid", inputCostPerM: 3, outputCostPerM: 15 },
      source: "provider",
    });
    catalog.upsert({
      ref: { provider: "p", model: "free-fast" },
      displayName: "free-fast",
      capabilities: { ...FAKE_CAPABILITIES.fast, family: "free", supportsJson: true, inputCostPerM: 0, outputCostPerM: 0 },
      source: "provider",
    });
    catalog.upsert({
      ref: { provider: "p", model: "unknown-strong" },
      displayName: "unknown-strong",
      capabilities: { ...FAKE_CAPABILITIES.strong, family: "unknown", inputCostPerM: null, outputCostPerM: null },
      source: "provider",
    });

    const router = freeOnlyRouter(catalog);
    const workers = router.select({ role: "worker", count: 10, requireTools: true }).map((row) => row.entry.info.ref.model);
    const reviewers = router.select({ role: "reviewer", count: 10 }).map((row) => row.entry.info.ref.model);
    const verifiers = router.select({ role: "verifier", count: 10 }).map((row) => row.entry.info.ref.model);

    expect(workers).toEqual(["free-fast"]);
    expect(reviewers).toEqual(["free-fast"]);
    expect(verifiers).toEqual(["free-fast"]);
    expect(router.rank({ role: "worker", count: 10 }).map((row) => row.entry.info.ref.model)).not.toContain("paid-frontier");
    expect(router.rank({ role: "worker", count: 10 }).map((row) => row.entry.info.ref.model)).not.toContain("unknown-strong");
  });

  it("does not bypass the cost gate for unpinned supervisor/judge selection", () => {
    const catalog = new ModelCatalog();
    catalog.register(new ScriptedProvider("p", []));
    const paidPin = { provider: "p", model: "paid-supervisor" };
    catalog.upsert({
      ref: paidPin,
      displayName: "paid-supervisor",
      capabilities: { ...FAKE_CAPABILITIES.frontier, family: "council", supportsJson: true, inputCostPerM: 3, outputCostPerM: 15 },
      source: "provider",
    });
    catalog.upsert({
      ref: { provider: "p", model: "unknown-judge" },
      displayName: "unknown-judge",
      capabilities: { ...FAKE_CAPABILITIES.strong, family: "unknown", supportsJson: true, inputCostPerM: null, outputCostPerM: null },
      source: "provider",
    });
    catalog.upsert({
      ref: { provider: "p", model: "free-fast" },
      displayName: "free-fast",
      capabilities: { ...FAKE_CAPABILITIES.fast, family: "free", supportsJson: true, inputCostPerM: 0, outputCostPerM: 0 },
      source: "provider",
    });

    const router = freeOnlyRouter(catalog);
    const names = (role: "supervisor" | "judge") =>
      router.select({ role, count: 10, requireJson: true }).map((row) => row.entry.info.ref.model);
    expect(names("supervisor")).toEqual(["free-fast"]);
    expect(names("judge")).toEqual(["free-fast"]);
    expect(
      router.select({ role: "supervisor", count: 10, requireJson: true, pinned: [paidPin] }).map((row) => row.entry.info.ref.model),
    ).toEqual(["free-fast"]);
    expect(router.select({ role: "worker", count: 10, requireTools: true, pinned: [paidPin] }).map((row) => row.entry.info.ref.model)).toEqual([
      "free-fast",
    ]);
  });

  it("catalogs paid models under free_only but probes only free models plus pinned supervisors", async () => {
    const models: ScriptedModel[] = Array.from({ length: 10 }, (_, index) => ({
      name: `paid-${String(index).padStart(2, "0")}`,
      capabilities: { ...FAKE_CAPABILITIES.frontier, inputCostPerM: index + 1, outputCostPerM: index + 1 },
    }));
    models.push({
      name: "free-worker",
      capabilities: { ...FAKE_CAPABILITIES.fast, inputCostPerM: 0, outputCostPerM: 0 },
    });
    models.push({
      name: "pinned-council",
      capabilities: { ...FAKE_CAPABILITIES.strong, inputCostPerM: 0.5, outputCostPerM: 1.5 },
    });
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
      maxProbesPerProvider: 8,
      pinnedModels: [{ provider: "p", model: "pinned-council" }],
      costEligibility: FREE_ONLY_COST_ELIGIBILITY,
      capabilityProbe: (adapter, model) => probeModelCapabilities(adapter, model, { runId: RUN, skipHealth: true }),
    });

    expect(discovery.discovered).toBe(12);
    expect(catalog.list()).toHaveLength(12);
    expect(discovery.probes.map((probe) => probe.info.ref.model).sort()).toEqual(["free-worker", "pinned-council"]);

    const router = freeOnlyRouter(catalog);
    expect(router.select({ role: "worker", count: 10, requireTools: true }).map((row) => row.entry.info.ref.model)).toEqual([
      "free-worker",
    ]);
  });
});
