import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { distinctFamilies, familyCount } from "../broker/diversity.js";
import { ModelObservationRepository } from "../broker/observations.js";
import { REVIEW_FINDINGS_RESPONSE_SCHEMA } from "../broker/responseSchemas.js";
import { defaultConfig, type PolishConfig } from "../domain/config.js";
import type { ModelRef } from "../domain/common.js";
import type { PhaseContext } from "../engine/types.js";
import { threeDistinctDebateRoles } from "../findings/index.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { FakeClock } from "../shared/clock.js";
import { hashJson } from "../shared/hash.js";
import { openStore, type Store } from "../store/index.js";
import {
  authorFamilies,
  buildProductionDeps,
  describeRunMechanisms,
  selectDebateRoles,
  selectReviewProviders,
} from "./composition.js";

describe("distinctFamilies", () => {
  it("keeps the first item of each family, in order, and skips avoided families", () => {
    const items = [
      { id: "a1", family: "a" },
      { id: "b1", family: "b" },
      { id: "a2", family: "a" },
      { id: "c1", family: "c" },
    ];
    expect(distinctFamilies(items, (item) => item.family).map((item) => item.id)).toEqual(["a1", "b1", "c1"]);
    expect(distinctFamilies(items, (item) => item.family, new Set(["a"])).map((item) => item.id)).toEqual(["b1", "c1"]);
    expect(familyCount(items, (item) => item.family)).toBe(3);
  });
});

describe("threeDistinctDebateRoles with families", () => {
  const ref = (model: string): ModelRef => ({ provider: "p", model });

  it("refuses three models of two families", () => {
    const roles = { prosecutor: ref("a-1"), defender: ref("b-1"), judge: ref("a-2") };
    expect(threeDistinctDebateRoles(roles)).toBe(true);
    expect(threeDistinctDebateRoles(roles, (model) => model.model.split("-")[0] ?? "")).toBe(false);
  });
});

describe("production diversity selection", () => {
  let dir: string;
  let store: Store;
  let clock: FakeClock;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polish-diversity-"));
    store = openStore({ artifactsDir: join(dir, "artifacts") });
    clock = new FakeClock(1_700_000_000_000);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function depsWith(models: readonly { name: string; family: string }[], config: PolishConfig = defaultConfig()) {
    const provider = new ScriptedProvider("free", models.map((model) => ({
      name: model.name,
      capabilities: {
        ...FAKE_CAPABILITIES.strong,
        family: model.family,
        supportsStrictReviewSchema: true,
        inputCostPerM: 0,
        outputCostPerM: 0,
      },
    })));
    const deps = buildProductionDeps({ store, clock, config, home: join(dir, "home"), providers: [provider] });
    await deps.catalog.discover();
    const observations = new ModelObservationRepository(store);
    for (const model of models) {
      observations.recordStrictProbe({ provider: "free", model: model.name }, {
        schema: "review",
        schemaHash: hashJson(REVIEW_FINDINGS_RESPONSE_SCHEMA),
        supported: true,
        at: clock.now(),
      });
    }
    observations.restoreCatalog(deps.catalog);
    return deps;
  }

  function ctxWithWinner(author: string): PhaseContext {
    return {
      run: { id: "run_x", currentCheckpointHash: null },
      store: {
        repos: {
          candidates: { listByRun: () => [{ state: "WINNER", model: { provider: "free", model: author } }] },
          reviewExecutions: { listByRun: () => [] },
        },
      },
    } as unknown as PhaseContext;
  }

  it("offers one reviewer per family, so a fallback reaches another family", async () => {
    const deps = await depsWith([
      { name: "a-large", family: "a" },
      { name: "a-small", family: "a" },
      { name: "b-large", family: "b" },
    ]);
    const reviewers = await selectReviewProviders(deps);
    expect(reviewers.map((reviewer) => reviewer.family).sort()).toEqual(["a", "b"]);
    expect(reviewers.every((reviewer) => reviewer.family !== undefined)).toBe(true);
  });

  it("chooses debate roles from three families none of which wrote the code", async () => {
    const deps = await depsWith([
      { name: "a-1", family: "a" },
      { name: "a-2", family: "a" },
      { name: "b-1", family: "b" },
      { name: "c-1", family: "c" },
      { name: "d-1", family: "d" },
    ]);
    const ctx = ctxWithWinner("a-1");
    expect([...authorFamilies(deps, ctx)]).toEqual(["a"]);
    const roles = selectDebateRoles(deps, ctx);
    expect(roles).not.toBeNull();
    const families = [roles!.prosecutor, roles!.defender, roles!.judge].map((ref) => ref.model[0]);
    expect(new Set(families).size).toBe(3);
    expect(families).not.toContain("a");
  });

  it("counts only a winning candidate's family as an author", async () => {
    const deps = await depsWith([
      { name: "a-1", family: "a" },
      { name: "b-1", family: "b" },
    ]);
    const ctx = {
      run: { id: "run_x", currentCheckpointHash: null },
      store: {
        repos: {
          candidates: {
            listByRun: () => [
              { state: "LOSER", model: { provider: "free", model: "a-1" } },
              { state: "WINNER", model: { provider: "free", model: "b-1" } },
            ],
          },
        },
      },
    } as unknown as PhaseContext;
    expect([...authorFamilies(deps, ctx)]).toEqual(["b"]);
  });

  it("skips debate rather than seat the author's family", async () => {
    const deps = await depsWith([
      { name: "a-1", family: "a" },
      { name: "b-1", family: "b" },
      { name: "c-1", family: "c" },
      { name: "c-2", family: "c" },
    ]);
    expect(selectDebateRoles(deps)).not.toBeNull();
    expect(selectDebateRoles(deps, ctxWithWinner("a-1"))).toBeNull();
  });

  it("reports review quorum off when strict families are fewer than reviewers per round", async () => {
    const deps = await depsWith([
      { name: "a-1", family: "a" },
      { name: "a-2", family: "a" },
      { name: "b-1", family: "b" },
    ]);
    const mechanisms = describeRunMechanisms(deps);
    expect(mechanisms).toContainEqual({ name: "review_quorum", on: false, reason: "insufficient_families: 2 of 3 (a,b)" });
    expect(mechanisms).toContainEqual({ name: "debate_diversity", on: false, reason: "insufficient_families: 2 of 3 (a,b)" });
  });

  it("reports review quorum on with the families that fill it", async () => {
    const deps = await depsWith([
      { name: "a-1", family: "a" },
      { name: "b-1", family: "b" },
      { name: "c-1", family: "c" },
    ]);
    expect(describeRunMechanisms(deps)).toContainEqual({ name: "review_quorum", on: true, reason: "families: a,b,c" });
  });
});
