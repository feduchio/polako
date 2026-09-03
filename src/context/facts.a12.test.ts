import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NewEvent } from "../domain/event.js";
import type { Clock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { FactsService } from "./facts.js";

function evidence(runId: string, type: string): NewEvent {
  return {
    id: id("evt"),
    runId,
    ts: 1,
    type,
    payload: {},
    causedBy: [],
    actor: { kind: "system" },
    artifacts: [],
  };
}

describe("A12 fact evidence and consolidation", () => {
  let dir: string;
  let store: Store;
  let now: number;
  let facts: FactsService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polish-facts-a12-"));
    store = openStore({ artifactsDir: join(dir, "artifacts") });
    now = 100;
    const clock: Clock = {
      now: () => now,
      sleep: async () => undefined,
    };
    facts = new FactsService(store, clock);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("promotes only from an allowlisted same-run evidence event and records causality", () => {
    const runId = id("run");
    const modelCall = store.events.append([evidence(runId, "model.call")])[0]!;
    const inferred = facts.record({
      runId,
      kind: "behavior",
      statement: "Retries are bounded",
      provenanceKind: "llm_inferred",
      provenanceRefs: [modelCall.id],
      evidenceRefs: [],
      confidence: 0.9,
      tags: [],
      files: [],
    });
    expect(() => facts.promote(inferred.id, id("evt"))).toThrow(/allowlisted same-run/);
    expect(() => facts.promote(inferred.id, modelCall.id)).toThrow(/allowlisted same-run/);

    const validated = store.events.append([evidence(runId, "finding.validated")])[0]!;
    const promoted = facts.promote(inferred.id, validated.id);
    expect(promoted).toMatchObject({ provenanceKind: "verified", evidenceRefs: [validated.id] });
    expect(store.events.effects(validated.id).some((event) => event.type === "fact.promoted")).toBe(true);
  });

  it("chooses strongest semantic duplicate and unions evidence without weakening provenance", () => {
    const runId = id("run");
    const refs = store.events.append([
      evidence(runId, "model.call"),
      evidence(runId, "project.discovered"),
      evidence(runId, "finding.validated"),
    ]);
    const inferred = facts.record({
      runId,
      kind: "invariant",
      statement: "  Events   are durable ",
      provenanceKind: "llm_inferred",
      provenanceRefs: [refs[0]!.id],
      evidenceRefs: [],
      confidence: 0.8,
      tags: [],
      files: [],
    });
    now++;
    const deterministic = facts.record({
      runId,
      kind: "invariant",
      statement: "events are durable",
      provenanceKind: "deterministic",
      provenanceRefs: [refs[1]!.id],
      evidenceRefs: [refs[1]!.id],
      confidence: null,
      tags: [],
      files: [],
    });
    now++;
    const verified = facts.record({
      runId,
      kind: "invariant",
      statement: "EVENTS ARE DURABLE",
      provenanceKind: "verified",
      provenanceRefs: [refs[2]!.id],
      evidenceRefs: [refs[2]!.id],
      confidence: 0.7,
      tags: [],
      files: [],
    });

    expect(facts.consolidate(runId)).toEqual({ kept: 1, superseded: 2 });
    const [winner] = facts.listCurrent(runId);
    expect(winner).toMatchObject({ id: verified.id, provenanceKind: "verified" });
    expect(winner?.evidenceRefs).toEqual([refs[2]!.id]);
    expect(winner?.provenanceRefs.sort()).toEqual(refs.map((ref) => ref.id).sort());
    expect(store.repos.facts.get(inferred.id)?.supersededBy).toBe(verified.id);
    expect(store.repos.facts.get(deterministic.id)?.supersededBy).toBe(verified.id);
  });

  it("drops unresolved provenance refs when consolidating duplicates", () => {
    const runId = id("run");
    const live = store.events.append([evidence(runId, "finding.validated")])[0]!;
    const ghost = id("evt");
    facts.record({
      runId,
      kind: "invariant",
      statement: "events are durable",
      provenanceKind: "verified",
      provenanceRefs: [live.id],
      evidenceRefs: [live.id],
      confidence: 0.7,
      tags: [],
      files: [],
    });
    now++;
    facts.record({
      runId,
      kind: "invariant",
      statement: "Events are durable",
      provenanceKind: "llm_inferred",
      provenanceRefs: [ghost],
      evidenceRefs: [],
      confidence: 0.2,
      tags: [],
      files: [],
    });

    expect(facts.consolidate(runId)).toEqual({ kept: 1, superseded: 1 });
    const [winner] = facts.listCurrent(runId);
    expect(winner?.provenanceRefs).toEqual([live.id]);
    expect(winner?.provenanceRefs).not.toContain(ghost);
  });

  it("does not rewrite a winner with unresolvable provenance when consolidating ghost-only duplicates", () => {
    const runId = id("run");
    const ghostA = id("evt");
    const ghostB = id("evt");
    facts.record({
      runId,
      kind: "invariant",
      statement: "events are durable",
      provenanceKind: "llm_inferred",
      provenanceRefs: [ghostA],
      evidenceRefs: [],
      confidence: 0.4,
      tags: [],
      files: [],
    });
    now++;
    facts.record({
      runId,
      kind: "invariant",
      statement: "Events are durable",
      provenanceKind: "llm_inferred",
      provenanceRefs: [ghostB],
      evidenceRefs: [],
      confidence: 0.2,
      tags: [],
      files: [],
    });

    expect(facts.consolidate(runId)).toEqual({ kept: 1, superseded: 1 });
    const [winner] = facts.listCurrent(runId);
    expect(winner).toBeDefined();
    expect(winner!.provenanceRefs).toHaveLength(1);
    expect([ghostA, ghostB]).toContain(winner!.provenanceRefs[0]);
    expect(store.events.list(runId, { types: ["fact.recorded"] }).some((event) => {
      const fact = event.payload["fact"] as { provenanceRefs?: string[] } | undefined;
      return (fact?.provenanceRefs ?? []).includes(ghostA) && (fact?.provenanceRefs ?? []).includes(ghostB);
    })).toBe(false);
  });
});
