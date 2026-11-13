import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerCards } from "../cards/index.js";
import { composeWorkerInstruction } from "../context/workerInstruction.js";
import { defaultConfig } from "../domain/config.js";
import { createTaskFromRequirement } from "../domain/task.js";
import { ProtocolRegistry } from "../protocols/loader.js";
import { defaultProtocolsRoot } from "../protocols/index.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { FakeClock } from "../shared/clock.js";
import { openStore, type Store } from "../store/index.js";
import { buildProductionDeps, cardGuidance } from "./composition.js";

describe("card worker guidance", () => {
  let dir: string;
  let store: Store;
  let clock: FakeClock;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polako-guidance-"));
    store = openStore({ artifactsDir: join(dir, "artifacts") });
    clock = new FakeClock(1_700_000_000_000);
    mkdirSync(join(dir, "project", "notes"), { recursive: true });
    writeFileSync(join(dir, "project", "notes", "ornith.md"), "Ornith habit: no casts.\n");
    writeFileSync(join(dir, "project", "notes", "qwen.md"), "Qwen lineage: prefer small edits.\n");
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function depsWith(modelNotes: Record<string, string>) {
    const config = defaultConfig();
    config.cards.modelNotes = modelNotes;
    const provider = new ScriptedProvider("local", [
      { name: "ornith-ai/ornith-1.5-35b-a3b", capabilities: { ...FAKE_CAPABILITIES.strong, family: "qwen", inputCostPerM: 0, outputCostPerM: 0 } },
      { name: "gpt-oss-20b", capabilities: { ...FAKE_CAPABILITIES.strong, family: "openai", inputCostPerM: 0, outputCostPerM: 0 } },
    ]);
    const deps = buildProductionDeps({ store, clock, config, home: join(dir, "home"), providers: [provider] });
    await deps.catalog.discover();
    return deps;
  }

  function ctxFor(cards: boolean) {
    const runId = "run_x";
    const registration = registerCards(
      [{ id: "N01", title: "T", depends: [], files: ["a.ts"], goal: "Do.", acceptance: ["ok"] }],
      { brief: "Project brief: only the card's files." },
    );
    return {
      run: { id: runId, projectPath: join(dir, "project") },
      store: { events: { list: () => (cards ? [{ payload: { registration } }] : []) } },
    } as unknown as Parameters<typeof cardGuidance>[1];
  }

  it("is the brief, then the notes of the model by prefix and by lineage", async () => {
    const deps = await depsWith({ ornith: "notes/ornith.md", qwen: "notes/qwen.md", gpt: "notes/missing.md" });
    const text = cardGuidance(deps, ctxFor(true), { provider: "local", model: "ornith-ai/ornith-1.5-35b-a3b" });
    expect(text).toBe("Project brief: only the card's files.\n\nOrnith habit: no casts.\n\nQwen lineage: prefer small edits.");
  });

  it("gives another lineage only the brief, and skips a missing notes file", async () => {
    const deps = await depsWith({ ornith: "notes/ornith.md", "gpt-oss": "notes/missing.md" });
    expect(cardGuidance(deps, ctxFor(true), { provider: "local", model: "gpt-oss-20b" })).toBe("Project brief: only the card's files.");
  });

  it("is empty for a mission run", async () => {
    const deps = await depsWith({ ornith: "notes/ornith.md" });
    expect(cardGuidance(deps, ctxFor(false), { provider: "local", model: "ornith-ai/ornith-1.5-35b-a3b" })).toBe("");
  });

  it("reaches the worker's instruction as a protected section", () => {
    const task = createTaskFromRequirement("mint_" + "0".repeat(22), "R1", {
      id: "task_" + "0".repeat(22), runId: "run_" + "0".repeat(22), title: "T", description: "Card N01: T", kind: "feature", acceptance: ["ok"],
      complexity: "normal", baseCheckpointHash: "a".repeat(40), now: 1,
    });
    const registry = ProtocolRegistry.load(defaultProtocolsRoot());
    const withGuidance = composeWorkerInstruction({ registry, task, findings: [], profile: null, tools: [], maxPackTokens: 20_000, guidance: "Brief text here." });
    expect(withGuidance.text).toContain("## projectBrief\nBrief text here.");
    const without = composeWorkerInstruction({ registry, task, findings: [], profile: null, tools: [], maxPackTokens: 20_000 });
    expect(without.text).not.toContain("projectBrief");
  });
});
