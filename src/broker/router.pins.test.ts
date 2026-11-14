import { describe, expect, it } from "vitest";
import { ModelCatalog } from "./catalog.js";
import { DEFAULT_ROUTER_POLICY, ModelRouter } from "./router.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";

async function catalog(): Promise<ModelCatalog> {
  const provider = new ScriptedProvider("local", [
    { name: "ornith", capabilities: { ...FAKE_CAPABILITIES.strong, family: "qwen" } },
    { name: "gpt-oss", capabilities: { ...FAKE_CAPABILITIES.strong, family: "openai" } },
    { name: "gemma", capabilities: { ...FAKE_CAPABILITIES.frontier, family: "google" } },
    { name: "granite", capabilities: { ...FAKE_CAPABILITIES.frontier, family: "ibm" } },
    { name: "no-tools", capabilities: { ...FAKE_CAPABILITIES.strong, family: "x", supportsTools: false } },
  ]);
  const cat = new ModelCatalog();
  cat.register(provider);
  await cat.discover();
  return cat;
}

const ref = (model: string) => ({ provider: "local", model });
const names = (rows: { entry: { info: { ref: { model: string } } } }[]) => rows.map((row) => row.entry.info.ref.model);

describe("ModelRouter role pins", () => {
  it("serves a pinned role from its chain alone, in chain order, whatever ranks higher", async () => {
    const router = new ModelRouter(await catalog(), DEFAULT_ROUTER_POLICY, { reviewer: [ref("gpt-oss"), ref("ornith")], worker: [ref("ornith")] });
    expect(names(router.select({ role: "reviewer", count: 8 }))).toEqual(["gpt-oss", "ornith"]);
    expect(names(router.select({ role: "worker", count: 8 }))).toEqual(["ornith"]);
    expect(names(router.select({ role: "reviewer", count: 1 }))).toEqual(["gpt-oss"]);
  });

  it("leaves an unpinned role to the ranking, with every model offered", async () => {
    const router = new ModelRouter(await catalog(), DEFAULT_ROUTER_POLICY, { worker: [ref("ornith")] });
    const verifiers = names(router.select({ role: "verifier", count: 8 }));
    expect(verifiers).toContain("gemma");
    expect(verifiers).toContain("granite");
    expect(router.pinnedChain("verifier")).toBeUndefined();
  });

  it("keeps the capability filters: a pinned model that cannot do the job is not offered", async () => {
    const router = new ModelRouter(await catalog(), DEFAULT_ROUTER_POLICY, { worker: [ref("no-tools"), ref("ornith")] });
    expect(names(router.select({ role: "worker", count: 8, requireTools: true }))).toEqual(["ornith"]);
  });

  it("skips a pinned model that is not in the catalogue and falls to the next in the chain", async () => {
    const router = new ModelRouter(await catalog(), DEFAULT_ROUTER_POLICY, { reviewer: [ref("missing"), ref("gpt-oss"), ref("ornith")] });
    expect(names(router.select({ role: "reviewer", count: 8 }))).toEqual(["gpt-oss", "ornith"]);
  });

  it("treats an empty chain as no pin", async () => {
    const router = new ModelRouter(await catalog(), DEFAULT_ROUTER_POLICY, { reviewer: [] });
    expect(router.pinnedChain("reviewer")).toBeUndefined();
    expect(names(router.select({ role: "reviewer", count: 8 })).length).toBe(5);
  });
});
