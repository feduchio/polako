import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelInfo } from "../broker/types.js";
import { toLmStudioModelInfo } from "../providers/lmstudio.js";
import { loadPolishConfig } from "./configLoad.js";
import { loadInstalledModels, renderRolePlan, resolveRolePlan, ROLE_ORDER, ROLE_STAGES } from "./rolePlan.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function load(toml: string) {
  const home = mkdtempSync(join(tmpdir(), "polako-roles-"));
  dirs.push(home);
  writeFileSync(join(home, "polako.toml"), toml);
  return loadPolishConfig(home);
}

const PROVIDER = '[[providers]]\nid = "local"\nkind = "lmstudio"\nlmsPath = "/nonexistent/lms"\n';

function installed(rows: [string, string][]): Map<string, ModelInfo[]> {
  return new Map([["local", rows.map(([key, architecture]) => toLmStudioModelInfo("local", key, { type: "llm", modelKey: key, architecture, paramsString: "20B", trainedForToolUse: true, maxContextLength: 131072 }, 65536, undefined))]]);
}

const ALL = installed([["ornith-ai/ornith-1.5-35b-a3b", "qwen35moe"], ["gpt-oss-20b", "gpt-oss"], ["granite-4.2-8b", "granitehybrid"]]);

describe("[roles] config", () => {
  it("parses ordered chains and keeps them off unpinned roles", () => {
    const config = load(`${PROVIDER}[roles]\nimplementer = ["local:ornith-ai/ornith-1.5-35b-a3b"]\nreviewers = ["local:gpt-oss-20b", "local:ornith-ai/ornith-1.5-35b-a3b"]\n`);
    expect(config.roles.implementer).toEqual(["local:ornith-ai/ornith-1.5-35b-a3b"]);
    expect(config.roles.reviewers).toEqual(["local:gpt-oss-20b", "local:ornith-ai/ornith-1.5-35b-a3b"]);
    expect(config.roles.verifier).toBeUndefined();
  });

  it("rejects a malformed model reference and a provider that is not configured", () => {
    expect(() => load(`${PROVIDER}[roles]\nreviewers = ["gpt-oss-20b"]\n`)).toThrow(/invalid polako.toml/);
    expect(() => load(`${PROVIDER}[roles]\nreviewers = ["cloud:gpt-oss-20b"]\n`)).toThrow(/names provider "cloud", which is not an enabled \[\[providers\]\] id \(local\)/);
    expect(() => load(`${PROVIDER.replace("lmstudio", "lmstudio\"\nenabled = false\nx = \"")}[roles]\nimplementer = ["local:a"]\n`)).toThrow(/not an enabled/);
  });
});

describe("resolveRolePlan", () => {
  const config = load(`${PROVIDER}[roles]\nimplementer = ["local:ornith-ai/ornith-1.5-35b-a3b"]\nreviewers = ["local:gpt-oss-20b", "local:ornith-ai/ornith-1.5-35b-a3b"]\n`);

  it("names the first usable model of every pinned role and describes the unpinned ones", () => {
    const plan = resolveRolePlan(config, ALL);
    const byRole = Object.fromEntries(plan.map((item) => [item.role, item]));
    expect(byRole["implementer"]).toMatchObject({ first: "local:ornith-ai/ornith-1.5-35b-a3b", pinned: true });
    expect(byRole["reviewers"]?.chain.map((pin) => [pin.ref, pin.status, pin.family])).toEqual([
      ["local:gpt-oss-20b", "ok", "openai"],
      ["local:ornith-ai/ornith-1.5-35b-a3b", "ok", "qwen"],
    ]);
    expect(byRole["verifier"]).toMatchObject({ pinned: false, first: null });
    expect(byRole["verifier"]?.note).toContain("the router chooses among 3 installed model(s)");
    expect(plan.map((item) => item.role)).toEqual([...ROLE_ORDER]);
  });

  it("says the progress tracker is off in the local profile", () => {
    expect(resolveRolePlan(config, ALL).find((item) => item.role === "progress")?.note).toContain("off: agent.progressEnabled = false");
  });

  it("predicts each reviewer's independence from the implementer's lineage", () => {
    const reviewers = resolveRolePlan(config, ALL).find((item) => item.role === "reviewers");
    expect(reviewers?.independence).toEqual([
      { ref: "local:gpt-oss-20b", mode: "lineage" },
      { ref: "local:ornith-ai/ornith-1.5-35b-a3b", mode: "same-model-isolated" },
    ]);
  });

  it("flags a pin that is not installed, and a role with nothing usable", () => {
    const plan = resolveRolePlan(config, installed([["gpt-oss-20b", "gpt-oss"]]));
    const implementer = plan.find((item) => item.role === "implementer");
    expect(implementer?.chain[0]).toMatchObject({ status: "not installed" });
    expect(implementer?.chain[0]?.detail).toContain("installed: gpt-oss-20b");
    expect(implementer).toMatchObject({ first: null, note: "NO PINNED MODEL IS USABLE: the role will fail" });
    const reviewers = plan.find((item) => item.role === "reviewers");
    expect(reviewers?.first).toBe("local:gpt-oss-20b");
    expect(reviewers?.independence).toBeUndefined();
  });

  it("a pin on a provider that is not checked offline stays unchecked, not wrong", () => {
    const cloud = load('[[providers]]\nid = "or"\nkind = "openrouter"\napiKeyEnv = "K"\n[roles]\nreviewers = ["or:google/gemini-2.5-flash"]\n');
    const reviewers = resolveRolePlan(cloud, new Map()).find((item) => item.role === "reviewers");
    expect(reviewers?.chain[0]).toMatchObject({ status: "unchecked", family: "google" });
    expect(reviewers?.first).toBe("or:google/gemini-2.5-flash");
  });

  it("renders every role with its stage and chain", () => {
    const text = renderRolePlan(resolveRolePlan(config, ALL));
    expect(text).toContain("implementer    local:ornith-ai/ornith-1.5-35b-a3b");
    expect(text).toContain("reviewers      local:gpt-oss-20b");
    expect(text).toContain("then local:ornith-ai/ornith-1.5-35b-a3b  [ok] qwen");
    expect(text).toContain("review of local:ornith-ai/ornith-1.5-35b-a3b: same-model-isolated");
    expect(text).toContain("verifier       -  (router)");
    for (const stage of Object.values(ROLE_STAGES)) expect(text).toContain(stage);
  });
});

describe("loadInstalledModels", () => {
  it("asks only lmstudio providers, through the provider's own lists", async () => {
    const config = load(`${PROVIDER}excludeModels = ["granite-*"]\n`);
    // `lms` is absent here: the result is empty, never an error, and nothing else is contacted.
    expect(await loadInstalledModels(config)).toEqual(new Map([["local", []]]));
  });
});
