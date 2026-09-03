import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchesProtectedChangeWaiver } from "../domain/protectedChangeWaiver.js";
import type { NewEvent } from "../domain/event.js";
import type { Run } from "../domain/run.js";
import { CURRENT_EVENT_SCHEMA_VERSION } from "../domain/event.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import {
  MissionAcceptanceService,
  ProtectedChangeWaiverService,
  openStore,
  type Store,
} from "./index.js";

const NOW = 1_700_000_000_000;

function run(runId: string, missionId: string): Run {
  return {
    id: runId,
    missionId,
    projectPath: "/tmp/p",
    runBranch: `polish/${runId}`,
    phase: "CREATED",
    control: "RUNNING",
    currentCheckpointHash: null,
    baselineId: null,
    interpretationId: null,
    createdAt: NOW,
    updatedAt: NOW,
    terminalReason: null,
  };
}

function event(runId: string, type: string, actor: NewEvent["actor"] = { kind: "system" }): NewEvent {
  return { id: id("evt"), runId, ts: NOW, type, payload: {}, causedBy: [], actor, artifacts: [] };
}

function waiverScope(base: {
  taskId: string;
  requirementId: string;
  baseCheckpointHash: string;
  pathScope: string[];
  findingKind: string;
}) {
  return {
    waiverScope: {
      requirementId: base.requirementId,
      taskId: base.taskId,
      baseCheckpointHash: base.baseCheckpointHash,
      relativePath: base.pathScope[0]!,
      findingKind: base.findingKind,
    },
  };
}

describe("A12 store foundations", () => {
  let dir: string;
  let store: Store;
  let clock: FakeClock;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polish-a12-"));
    store = openStore({ home: dir });
    clock = new FakeClock(NOW);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists a canonical event version and defaults legacy JSON safely", () => {
    const runId = id("run");
    const [stored] = store.events.append([event(runId, "report.generated")]);
    expect(stored?.schemaVersion).toBe(CURRENT_EVENT_SCHEMA_VERSION);
    expect(store.db.prepare("SELECT schema_version FROM events WHERE id = ?").get(stored!.id)).toEqual({
      schema_version: CURRENT_EVENT_SCHEMA_VERSION,
    });

    const legacyId = id("evt");
    const legacy = { ...event(id("run"), "report.generated"), id: legacyId, seq: 0 };
    store.db
      .prepare("INSERT INTO events (id, run_id, seq, ts, type, actor_kind, json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(legacy.id, legacy.runId, legacy.seq, legacy.ts, legacy.type, legacy.actor.kind, JSON.stringify(legacy));
    expect(store.events.get(legacyId)?.schemaVersion).toBe(CURRENT_EVENT_SCHEMA_VERSION);
  });

  it("keeps a mission corpus cumulative across runs and rebuilds without erasing peers", () => {
    const missionId = id("msn");
    const runA = id("run");
    const runB = id("run");
    store.events.append([
      { ...event(runA, "run.created"), payload: { run: run(runA, missionId) } },
      { ...event(runB, "run.created"), payload: { run: run(runB, missionId) } },
    ]);
    const service = new MissionAcceptanceService(store, clock);
    const a = service.record({
      missionId,
      sourceRunId: runA,
      requirementRef: "R1",
      kind: "check_scripts",
      summary: "unit check",
      evidenceRefs: [],
      artifactHashes: [],
      metadata: {},
    });
    const b = service.record({
      missionId,
      sourceRunId: runB,
      requirementRef: "R2",
      kind: "runtime_scenario",
      summary: "future browser scenario",
      evidenceRefs: [],
      artifactHashes: [],
      metadata: { implementation: "future" },
    });
    expect(service.get(missionId).entries.map((entry) => entry.id).sort()).toEqual([a.id, b.id].sort());

    store.events.rebuildProjections(runA);
    expect(service.get(missionId).entries.map((entry) => entry.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("rejects a corpus entry whose source run belongs to another mission", () => {
    const missionA = id("msn");
    const missionB = id("msn");
    const runA = id("run");
    store.events.append([{ ...event(runA, "run.created"), payload: { run: run(runA, missionA) } }]);
    const evidence = store.events.append([event(runA, "check.completed")])[0]!;
    const service = new MissionAcceptanceService(store, clock);
    expect(() => service.record({
      missionId: missionB,
      sourceRunId: runA,
      requirementRef: "R1",
      kind: "check_scripts",
      summary: "cross-mission",
      evidenceRefs: [evidence.id],
      artifactHashes: [],
      metadata: {},
    })).toThrow(/belong to the entry mission/);
    expect(service.get(missionB).entries).toEqual([]);
  });

  it("records only independently validated, causal waivers and matches exact scope", () => {
    const runId = id("run");
    const base = {
      runId,
      missionId: id("msn"),
      taskId: id("task"),
      requirementId: "R1",
      baseCheckpointHash: "a".repeat(40),
      pathScope: ["checks/protected.ts"],
      findingKind: "modified",
      justification: "validated replacement",
      causeEventId: id("evt"),
      issuedBy: { kind: "supervisor" as const },
      validatedBy: { kind: "reviewer" as const, role: "validator" },
    };
    const evidence = store.events.append([{
      ...event(runId, "finding.validated", { kind: "reviewer", role: "validator" }),
      payload: waiverScope(base),
    }])[0]!;
    base.causeEventId = evidence.id;
    const service = new ProtectedChangeWaiverService(store, clock);
    const waiver = service.record(base);
    expect(service.isValidated(waiver)).toBe(true);
    expect(service.isValidated({ ...waiver, causeEventId: id("evt") })).toBe(false);
    expect(store.events.effects(evidence.id)[0]?.type).toBe("protected_change.waiver_recorded");
    const scope = {
      runId: base.runId,
      missionId: base.missionId,
      taskId: base.taskId,
      requirementId: base.requirementId,
      baseCheckpointHash: base.baseCheckpointHash,
      relativePath: "checks/protected.ts",
      findingKind: base.findingKind,
    };
    expect(matchesProtectedChangeWaiver(waiver, scope)).toBe(true);
    expect(matchesProtectedChangeWaiver(waiver, { ...scope, relativePath: "checks/protected.ts.extra" })).toBe(false);
    expect(() => service.record({ ...base, id: id("waiv"), issuedBy: { kind: "worker" } })).toThrow(/workers cannot/);
  });
});
