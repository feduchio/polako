import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NewEvent } from "../domain/event.js";
import type { Clock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { FactsService } from "./facts.js";

function evidence(runId: string, type: string, eventId?: string): NewEvent {
  return {
    id: eventId ?? id("evt"),
    runId,
    ts: 1,
    type,
    payload: {},
    causedBy: [],
    actor: { kind: "system" },
    artifacts: [],
  };
}

describe("facts verified integrity", () => {
  let dir: string;
  let store: Store;
  let now: number;
  let facts: FactsService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polish-facts-verified-"));
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

  it("rejects direct verified facts with missing, cross-run, or non-allowlisted evidence", () => {
    const runId = id("run");
    const otherRun = id("run");
    const valid = store.events.append([evidence(runId, "finding.validated")])[0]!;
    const crossRun = store.events.append([evidence(otherRun, "finding.validated")])[0]!;
    const nonAllowlisted = store.events.append([evidence(runId, "model.call")])[0]!;
    const base = {
      runId,
      kind: "behavior" as const,
      statement: "Retries are bounded",
      provenanceKind: "verified" as const,
      provenanceRefs: [valid.id],
      confidence: null,
      tags: [] as string[],
      files: [] as string[],
    };

    expect(() => facts.record({ ...base, evidenceRefs: [] })).toThrow(/deterministic evidence refs/);
    expect(() => facts.record({ ...base, evidenceRefs: [id("evt")] })).toThrow(/nonexistent evidence/);
    expect(() => facts.record({ ...base, evidenceRefs: [crossRun.id] })).toThrow(/cross-run evidence/);
    expect(() => facts.record({ ...base, evidenceRefs: [nonAllowlisted.id] })).toThrow(/non-allowlisted evidence/);
    expect(facts.record({ ...base, evidenceRefs: [valid.id] }).provenanceKind).toBe("verified");
  });

  it("does not launder invalid verified facts through projection rebuild", () => {
    const runId = id("run");
    const badFactId = id("fact");
    store.db.prepare(
      "INSERT INTO events (id, run_id, seq, ts, type, actor_kind, schema_version, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id("evt"),
      runId,
      0,
      1,
      "fact.recorded",
      "system",
      1,
      JSON.stringify({
        id: id("evt"),
        runId,
        seq: 0,
        ts: 1,
        type: "fact.recorded",
        payload: {
          fact: {
            id: badFactId,
            runId,
            kind: "behavior",
            statement: "forged",
            provenanceKind: "verified",
            provenanceRefs: [id("evt")],
            evidenceRefs: [id("evt")],
            confidence: null,
            tags: [],
            files: [],
            supersededBy: null,
            createdAt: 1,
            updatedAt: 1,
          },
        },
        causedBy: [],
        actor: { kind: "system" },
        artifacts: [],
        schemaVersion: 1,
      }),
    );
    expect(() => store.events.rebuildProjections(runId)).toThrow(/nonexistent evidence/);
  });

  it("consolidate rejects laundering weaker refs onto verified winners", () => {
    const runId = id("run");
    const valid = store.events.append([evidence(runId, "finding.validated")])[0]!;
    const crossRun = store.events.append([evidence(id("run"), "finding.validated")])[0]!;
    const nonAllowlisted = store.events.append([evidence(runId, "model.call")])[0]!;
    facts.record({
      runId,
      kind: "invariant",
      statement: "events are durable",
      provenanceKind: "verified",
      provenanceRefs: [valid.id],
      evidenceRefs: [valid.id],
      confidence: null,
      tags: [],
      files: [],
    });
    now++;
    facts.record({
      runId,
      kind: "invariant",
      statement: "EVENTS ARE DURABLE",
      provenanceKind: "llm_inferred",
      provenanceRefs: [nonAllowlisted.id],
      evidenceRefs: [nonAllowlisted.id, crossRun.id, id("evt")],
      confidence: 0.5,
      tags: [],
      files: [],
    });
    facts.consolidate(runId);
    const [winner] = facts.listCurrent(runId);
    expect(winner?.provenanceKind).toBe("verified");
    expect(winner?.evidenceRefs).toEqual([valid.id]);
  });

  it("supersede writes replacement and supersession in one append batch", () => {
    const runId = id("run");
    const valid = store.events.append([evidence(runId, "finding.validated")])[0]!;
    const old = facts.record({
      runId,
      kind: "behavior",
      statement: "old",
      provenanceKind: "deterministic",
      provenanceRefs: [valid.id],
      evidenceRefs: [valid.id],
      confidence: null,
      tags: [],
      files: [],
    });
    const before = store.events.lastSeq(runId);
    facts.supersede(old.id, {
      kind: "behavior",
      statement: "new",
      provenanceKind: "verified",
      provenanceRefs: [valid.id],
      evidenceRefs: [valid.id],
      confidence: null,
      tags: [],
      files: [],
    });
    const appended = store.events.list(runId, { afterSeq: before });
    expect(appended.map((event) => event.type)).toEqual(["fact.recorded", "fact.superseded"]);
    expect(appended[0]!.seq + 1).toBe(appended[1]!.seq);
  });
});
