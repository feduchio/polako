import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AcceptanceArtifact } from "../domain/acceptance.js";
import { createMission } from "../domain/mission.js";
import type { NewEvent } from "../domain/event.js";
import type { Run } from "../domain/run.js";
import type { Task } from "../domain/task.js";
import { sha256Hex } from "../shared/hash.js";
import { id } from "../shared/ids.js";
import { openStore, transaction, getTxManager, type Store } from "./index.js";

const NOW = 1_700_000_000_000;
const HASH = "a".repeat(40);

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

function task(runId: string): Task {
  return {
    id: id("task"),
    runId,
    title: "t",
    description: "d",
    kind: "feature",
    origin: { kind: "mission_requirement", interpretationId: id("mint"), requirementRef: "R1" },
    acceptance: ["a"],
    complexity: "normal",
    baseCheckpointHash: HASH,
    dependsOn: [],
    state: "PENDING",
    attempts: 0,
    touchesProductCode: true,
    selectedCandidateId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function ev(runId: string, type: string, payload: Record<string, unknown>, causedBy: string[] = []): NewEvent {
  return { id: id("evt"), runId, ts: NOW, type, payload, causedBy, actor: { kind: "system" }, artifacts: [] };
}

describe("Store", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polish-store-"));
    store = openStore({ home: dir });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends events with per-run monotonic seq and projects snapshots atomically", () => {
    const runId = id("run");
    const missionId = id("msn");
    const r = run(runId, missionId);
    const [e1] = store.events.append([ev(runId, "run.created", { run: r })]);
    const [e2] = store.events.append([ev(runId, "run.phase_changed", { run: { ...r, phase: "DISCOVERING_PROJECT" } }, [e1!.id])]);
    expect(e1!.seq).toBe(0);
    expect(e2!.seq).toBe(1);
    expect(store.repos.runs.get(runId)?.phase).toBe("DISCOVERING_PROJECT");

    const other = id("run");
    const [o1] = store.events.append([ev(other, "run.created", { run: run(other, id("msn")) })]);
    expect(o1!.seq).toBe(0);
    expect(store.repos.runs.listActive().map((x) => x.id).sort()).toEqual([runId, other].sort());
  });

  it("an invalid snapshot aborts the whole append (no partial events, no partial projections)", () => {
    const runId = id("run");
    const before = store.events.lastSeq(runId);
    expect(() =>
      store.events.append([
        ev(runId, "run.created", { run: run(runId, id("msn")) }),
        ev(runId, "task.created", { task: { ...task(runId), kind: "investigation" } }), // violates kind/origin coupling
      ]),
    ).toThrow();
    expect(store.events.lastSeq(runId)).toBe(before);
    expect(store.repos.runs.get(runId)).toBeNull();
    expect(store.repos.tasks.listByRun(runId)).toEqual([]);
  });

  it("replaying events rebuilds projections identical to live state", () => {
    const runId = id("run");
    const r = run(runId, id("msn"));
    const t = task(runId);
    store.events.append([
      ev(runId, "run.created", { run: r }),
      ev(runId, "task.created", { task: t }),
      ev(runId, "task.state_changed", { task: { ...t, state: "READY", updatedAt: NOW + 1 } }),
      ev(runId, "run.phase_changed", { run: { ...r, phase: "DISCOVERING_PROJECT" } }),
    ]);
    const live = { run: store.repos.runs.get(runId), tasks: store.repos.tasks.listByRun(runId) };

    // corrupt what repositories actually read (json), plus indexed columns, plus delete a row
    store.db.prepare("UPDATE tasks SET state = 'CANCELLED', json = json_set(json, '$.state', 'CANCELLED') WHERE run_id = ?").run(runId);
    store.db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    expect(store.repos.runs.get(runId)).toBeNull();
    expect(store.repos.tasks.listByRun(runId)[0]?.state).toBe("CANCELLED");

    const replayed = store.events.rebuildProjections(runId);
    expect(replayed).toBe(4);
    expect({ run: store.repos.runs.get(runId), tasks: store.repos.tasks.listByRun(runId) }).toEqual(live);
    expect(live.tasks[0]?.state).toBe("READY");
  });

  it("rebuild restores interpretation rows produced by this run and purges stale rows with no backing event", () => {
    const runId = id("run");
    const missionId = id("msn");
    const r = run(runId, missionId);
    const interpretation = {
      id: id("mint"),
      missionId,
      version: 1,
      supersedes: null,
      basedOn: { profileHash: "c".repeat(64), baselineId: id("base") },
      goals: ["g"],
      requirements: [{ ref: "R1", statement: "s", acceptance: ["a"] }],
      constraints: [],
      nonGoals: [],
      definitionOfSuccess: ["d"],
      ambiguities: [],
      createdBy: { kind: "supervisor" },
      createdAt: NOW,
    };
    store.events.append([ev(runId, "run.created", { run: r }), ev(runId, "mission.interpreted", { interpretation })]);
    store.db
      .prepare("UPDATE interpretations SET version = 99, json = json_set(json, '$.version', 99) WHERE id = ?")
      .run(interpretation.id);
    const staleId = id("mint");
    store.db
      .prepare("INSERT INTO interpretations (id, mission_id, version, json) VALUES (?, ?, ?, ?)")
      .run(staleId, missionId, 2, JSON.stringify({ ...interpretation, id: staleId, version: 2 }));
    store.db.prepare("DELETE FROM runs WHERE id = ?").run(runId);

    store.events.rebuildProjections(runId);
    expect(store.repos.runs.get(runId)?.id).toBe(runId);
    expect(store.db.prepare("SELECT version FROM interpretations WHERE id = ?").get(interpretation.id)).toEqual({ version: 1 });
    expect(store.db.prepare("SELECT id FROM interpretations WHERE id = ?").get(staleId)).toBeUndefined();
  });

  it("rebuild purges all mission-scoped rows with no backing event", () => {
    const runId = id("run");
    const missionId = id("msn");
    store.events.append([ev(runId, "run.created", { run: run(runId, missionId) })]);
    const staleInterpretation = {
      id: id("mint"),
      missionId,
      version: 1,
      supersedes: null,
      basedOn: { profileHash: "c".repeat(64), baselineId: id("base") },
      goals: ["g"],
      requirements: [{ ref: "R1", statement: "s", acceptance: ["a"] }],
      constraints: [],
      nonGoals: [],
      definitionOfSuccess: ["d"],
      ambiguities: [],
      createdBy: { kind: "supervisor" },
      createdAt: NOW,
    };
    store.db
      .prepare("INSERT INTO interpretations (id, mission_id, version, json) VALUES (?, ?, ?, ?)")
      .run(staleInterpretation.id, missionId, 1, JSON.stringify(staleInterpretation));
    const staleMissionId = id("msn");
    const staleMission = {
      id: staleMissionId,
      projectPath: "/tmp/stale",
      projectAlias: null,
      text: "stale",
      userConstraints: [],
      userDecisions: [],
      createdAt: NOW,
      hash: "a".repeat(64),
    };
    store.db
      .prepare("INSERT INTO missions (id, hash, json) VALUES (?, ?, ?)")
      .run(staleMissionId, staleMission.hash, JSON.stringify(staleMission));

    store.events.rebuildProjections(runId);
    expect(store.db.prepare("SELECT id FROM interpretations WHERE id = ?").get(staleInterpretation.id)).toBeUndefined();
    expect(store.db.prepare("SELECT id FROM missions WHERE id = ?").get(staleMissionId)).toBeUndefined();
  });

  it("an event may only project entities of its own run", () => {
    const a = id("run");
    const b = id("run");
    expect(() => store.events.append([ev(a, "run.created", { run: run(b, id("msn")) })])).toThrow(/does not match/);
    expect(() => store.events.append([ev(a, "task.created", { task: task(b) })])).toThrow(/does not match/);
    expect(store.repos.runs.get(b)).toBeNull();
    expect(store.events.list(a)).toEqual([]);
  });

  it("mirrors events to runs/<runId>/events.jsonl", () => {
    const runId = id("run");
    store.events.append([ev(runId, "run.created", { run: run(runId, id("msn")) })]);
    const lines = readFileSync(join(dir, "runs", runId, "events.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: "run.created", seq: 0 });
  });

  it("causal chain walks causedBy links backwards and effects forwards", () => {
    const runId = id("run");
    const [a] = store.events.append([ev(runId, "finding.raised", {})]);
    const [b] = store.events.append([ev(runId, "finding.validated", {}, [a!.id])]);
    const [c] = store.events.append([ev(runId, "task.created", {}, [b!.id])]);
    const chain = store.events.causalChain(c!.id).map((e) => e.type);
    expect(chain).toEqual(["task.created", "finding.validated", "finding.raised"]);
    expect(store.events.effects(a!.id).map((e) => e.id)).toEqual([b!.id]);
  });

  it("unknown event types are stored and replayed without projection", () => {
    const runId = id("run");
    store.events.append([ev(runId, "future.event", { anything: 1 })]);
    expect(store.events.list(runId)).toHaveLength(1);
    expect(store.events.rebuildProjections(runId)).toBe(1);
  });

  it("nested transactions join the outer one and roll back together", () => {
    const runId = id("run");
    expect(() => {
      store.transaction(() => {
        store.events.append([ev(runId, "run.created", { run: run(runId, id("msn")) })]);
        store.transaction(() => {
          throw new Error("boom");
        });
      });
    }).toThrow("boom");
    expect(store.repos.runs.get(runId)).toBeNull();
    expect(store.events.list(runId)).toEqual([]);
    expect(existsSync(join(dir, "runs", runId, "events.jsonl"))).toBe(false);
  });

  it("the mirror is written only once the outermost transaction commits", () => {
    const runId = id("run");
    store.transaction(() => {
      store.events.append([ev(runId, "run.created", { run: run(runId, id("msn")) })]);
      expect(existsSync(join(dir, "runs", runId, "events.jsonl"))).toBe(false);
    });
    expect(readFileSync(join(dir, "runs", runId, "events.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("refuses non-contiguous or too-new schema_version histories", () => {
    const other = mkdtempSync(join(tmpdir(), "polish-mig-"));
    try {
      const raw = new DatabaseSync(join(other, "polish.db"));
      raw.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL); INSERT INTO schema_version VALUES (2, 0);");
      raw.close();
      expect(() => openStore({ home: other })).toThrow(/not contiguous/);
      rmSync(join(other, "polish.db"));
      const raw2 = new DatabaseSync(join(other, "polish.db"));
      raw2.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL); INSERT INTO schema_version VALUES (1, 0), (2, 0), (3, 0), (4, 0), (5, 0), (6, 0), (7, 0), (8, 0), (9, 0);");
      raw2.close();
      expect(() => openStore({ home: other })).toThrow(/newer than this build/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("reopening the same home preserves data and applies no duplicate migrations", () => {
    const runId = id("run");
    store.events.append([ev(runId, "run.created", { run: run(runId, id("msn")) })]);
    store.close();
    store = openStore({ home: dir });
    expect(store.repos.runs.get(runId)).not.toBeNull();
    const versions = store.db.prepare("SELECT COUNT(*) AS c FROM schema_version").get() as { c: number };
    expect(versions.c).toBe(1);
  });

  it("mirror failures do not fail append; the mirror is rebuildable from the DB", () => {
    const runId = id("run");
    mkdirSync(join(dir, "runs"), { recursive: true });
    chmodSync(join(dir, "runs"), 0o000);
    expect(() => {
      store.events.append([ev(runId, "run.created", { run: run(runId, id("msn")) })]);
    }).not.toThrow();
    chmodSync(join(dir, "runs"), 0o700);
    expect(store.events.list(runId)).toHaveLength(1);
    expect(existsSync(join(dir, "runs", runId, "events.jsonl"))).toBe(false);
    store.events.rebuildMirror(runId);
    expect(readFileSync(join(dir, "runs", runId, "events.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("queues mirror failures for drain without failing append", () => {
    const runId = id("run");
    mkdirSync(join(dir, "runs"), { recursive: true });
    chmodSync(join(dir, "runs"), 0o000);
    store.events.append([ev(runId, "run.created", { run: run(runId, id("msn")) })]);
    chmodSync(join(dir, "runs"), 0o700);
    expect(getTxManager(store.db).drainMirrorFailures()).toHaveLength(1);
  });

  it("exported transaction() shares the store TxManager so rollback drops mirror hooks", () => {
    const runId = id("run");
    expect(() => {
      transaction(store.db, () => {
        store.events.append([ev(runId, "run.created", { run: run(runId, id("msn")) })]);
        throw new Error("boom");
      });
    }).toThrow("boom");
    expect(store.events.list(runId)).toEqual([]);
    store.events.append([ev(runId, "run.created", { run: run(runId, id("msn")) })]);
    expect(readFileSync(join(dir, "runs", runId, "events.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("rebuild ignores incidental mission keys on unknown event types", () => {
    const runA = id("run");
    const missionId = id("msn");
    const mission = createMission({ id: missionId, projectPath: "/p", text: "t", createdAt: NOW });
    store.events.append([ev(runA, "run.created", { run: run(runA, missionId) }), ev(runA, "mission.recorded", { mission })]);
    const runB = id("run");
    store.events.append([ev(runB, "future.event", { mission: { id: missionId } })]);
    store.events.rebuildProjections(runB);
    expect(store.db.prepare("SELECT id FROM missions WHERE id = ?").get(missionId)).toBeTruthy();
  });

  it("rebuilding one run does not delete another run's interpretation for a shared mission", () => {
    const missionId = id("msn");
    const interp1 = {
      id: id("mint"),
      missionId,
      version: 1,
      supersedes: null,
      basedOn: { profileHash: "c".repeat(64), baselineId: id("base") },
      goals: ["g"],
      requirements: [{ ref: "R1", statement: "s", acceptance: ["a"] }],
      constraints: [],
      nonGoals: [],
      definitionOfSuccess: ["d"],
      ambiguities: [],
      createdBy: { kind: "supervisor" as const },
      createdAt: NOW,
    };
    const interp2 = { ...interp1, id: id("mint"), version: 2, supersedes: interp1.id };
    const runA = id("run");
    const runB = id("run");
    store.events.append([ev(runA, "run.created", { run: run(runA, missionId) }), ev(runA, "mission.interpreted", { interpretation: interp1 })]);
    store.events.append([ev(runB, "run.created", { run: run(runB, missionId) }), ev(runB, "mission.interpreted", { interpretation: interp2 })]);
    store.events.rebuildProjections(runA);
    const versions = (store.db.prepare("SELECT version FROM interpretations WHERE mission_id = ? ORDER BY version").all(missionId) as { version: number }[]).map((x) => x.version);
    expect(versions).toEqual([1, 2]);
  });

  it("rebuild restores shared interpretations produced by another run for the same mission", () => {
    const missionId = id("msn");
    const interp2 = {
      id: id("mint"),
      missionId,
      version: 2,
      supersedes: id("mint"),
      basedOn: { profileHash: "c".repeat(64), baselineId: id("base") },
      goals: ["g"],
      requirements: [{ ref: "R1", statement: "s", acceptance: ["a"] }],
      constraints: [],
      nonGoals: [],
      definitionOfSuccess: ["d"],
      ambiguities: [],
      createdBy: { kind: "supervisor" as const },
      createdAt: NOW,
    };
    const runA = id("run");
    const runB = id("run");
    store.events.append([ev(runB, "run.created", { run: run(runB, missionId) }), ev(runB, "mission.interpreted", { interpretation: interp2 })]);
    const runSnapshot = { ...run(runA, missionId), interpretationId: interp2.id, phase: "INTERPRETING_MISSION" as const };
    store.events.append([ev(runA, "run.created", { run: runSnapshot })]);
    store.db.prepare("DELETE FROM interpretations WHERE id = ?").run(interp2.id);
    store.events.rebuildProjections(runA);
    expect(store.repos.runs.get(runA)?.interpretationId).toBe(interp2.id);
    expect(store.db.prepare("SELECT version FROM interpretations WHERE id = ?").get(interp2.id)).toEqual({ version: 2 });
  });

  it("shared replay preserves live append order when event timestamps are out of order", () => {
    const missionId = id("msn");
    const interpretationId = id("mint");
    const baseInterp = {
      id: interpretationId,
      missionId,
      version: 1,
      supersedes: null,
      basedOn: { profileHash: "c".repeat(64), baselineId: id("base") },
      goals: ["first"],
      requirements: [{ ref: "R1", statement: "s", acceptance: ["a"] }],
      constraints: [],
      nonGoals: [],
      definitionOfSuccess: ["d"],
      ambiguities: [],
      createdBy: { kind: "supervisor" as const },
      createdAt: NOW,
    };
    const runA = id("run");
    const runB = id("run");
    store.events.append([
      ev(runA, "run.created", { run: run(runA, missionId) }),
      { ...ev(runA, "mission.interpreted", { interpretation: baseInterp }), ts: NOW + 200 },
    ]);
    store.events.append([
      ev(runB, "run.created", { run: run(runB, missionId) }),
      {
        ...ev(runB, "mission.interpreted", { interpretation: { ...baseInterp, version: 2, goals: ["last"], supersedes: interpretationId } }),
        ts: NOW + 100,
      },
    ]);
    const liveGoal = JSON.parse((store.db.prepare("SELECT json FROM interpretations WHERE id = ?").get(interpretationId) as { json: string }).json) as { goals: string[] };
    expect(liveGoal.goals).toEqual(["last"]);

    store.db.prepare("DELETE FROM interpretations WHERE id = ?").run(interpretationId);
    store.events.rebuildProjections(runA);
    const replayedGoal = JSON.parse((store.db.prepare("SELECT json FROM interpretations WHERE id = ?").get(interpretationId) as { json: string }).json) as { goals: string[] };
    expect(replayedGoal.goals).toEqual(["last"]);
  });
});

describe("ArtifactStore", () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polish-cas-"));
    store = openStore({ home: dir });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is content-addressed and idempotent", () => {
    const a = store.artifacts.put("hello", "text", "first");
    const b = store.artifacts.put("hello", "text", "second");
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toBe(sha256Hex("hello"));
    expect(store.artifacts.getText(a.sha256)).toBe("hello");
    expect(store.artifacts.meta(a.sha256)?.label).toBe("first");
  });

  it("detects on-disk corruption", () => {
    const a = store.artifacts.put("payload", "text");
    writeFileSync(store.artifacts.pathFor(a.sha256), "tampered");
    expect(() => store.artifacts.getBytes(a.sha256)).toThrow(/corrupted/);
  });

  it("rejects malformed hashes", () => {
    expect(() => store.artifacts.pathFor("../etc/passwd")).toThrow();
  });
});

describe("AcceptanceStorage", () => {
  let dir: string;
  let checkout: string;
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polish-acc-"));
    checkout = mkdtempSync(join(tmpdir(), "polish-checkout-"));
    store = openStore({ home: dir });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  });

  function artifact(relativePath: string, content: string): AcceptanceArtifact {
    return {
      id: id("acc"),
      runId: id("run"),
      taskId: null,
      kind: "regression_test",
      relativePath,
      sha256: store.acceptance.putContent(content, relativePath),
      evidenceFor: null,
      createdAt: NOW,
    };
  }

  it("verify reports missing and modified protected paths; materialize restores them", () => {
    const a = artifact("tests/regression.test.ts", "expect(1).toBe(1)");
    expect(store.acceptance.verify(checkout, [a])).toEqual([{ path: a.relativePath, reason: "missing" }]);
    store.acceptance.materialize(checkout, [a]);
    expect(store.acceptance.verify(checkout, [a])).toEqual([]);
    writeFileSync(join(checkout, a.relativePath), "expect(true).toBe(true) // silenced");
    expect(store.acceptance.verify(checkout, [a])).toEqual([{ path: a.relativePath, reason: "modified" }]);
    store.acceptance.materialize(checkout, [a]);
    expect(readFileSync(join(checkout, a.relativePath), "utf8")).toBe("expect(1).toBe(1)");
  });

  it("refuses paths that escape the checkout lexically", () => {
    for (const bad of ["../outside.ts", "/etc/passwd", "", "."]) {
      const a = artifact(bad || "x", "x");
      const art = { ...a, relativePath: bad };
      expect(() => {
        store.acceptance.materialize(checkout, [art]);
      }).toThrow(/escapes|relative path/);
      expect(() => store.acceptance.verify(checkout, [art])).toThrow(/escapes|relative path/);
    }
  });

  it("refuses paths that escape the checkout through a symlinked directory", () => {
    const outside = mkdtempSync(join(tmpdir(), "polish-outside-"));
    try {
      symlinkSync(outside, join(checkout, "linked"));
      const a = artifact("linked/victim.txt", "owned");
      expect(() => {
        store.acceptance.materialize(checkout, [a]);
      }).toThrow(/symlink/);
      expect(existsSync(join(outside, "victim.txt"))).toBe(false);
      expect(() => store.acceptance.verify(checkout, [a])).toThrow(/symlink/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reports a directory or symlink at a protected path as not_a_file, and materialize replaces it", () => {
    const a = artifact("tests/protected.test.ts", "real");
    mkdirSync(join(checkout, "tests", "protected.test.ts"), { recursive: true });
    expect(store.acceptance.verify(checkout, [a])).toEqual([{ path: a.relativePath, reason: "not_a_file" }]);
    store.acceptance.materialize(checkout, [a]);
    expect(store.acceptance.verify(checkout, [a])).toEqual([]);

    rmSync(join(checkout, a.relativePath));
    writeFileSync(join(checkout, "decoy.ts"), "real");
    symlinkSync(join(checkout, "decoy.ts"), join(checkout, a.relativePath));
    expect(store.acceptance.verify(checkout, [a])).toEqual([{ path: a.relativePath, reason: "not_a_file" }]);
    store.acceptance.materialize(checkout, [a]);
    expect(lstatSync(join(checkout, a.relativePath)).isSymbolicLink()).toBe(false);
    expect(store.acceptance.verify(checkout, [a])).toEqual([]);
  });

  it("does not overwrite external files through a hard link at a protected path", () => {
    const outside = mkdtempSync(join(tmpdir(), "polish-outside-hl-"));
    try {
      writeFileSync(join(outside, "victim.txt"), "original");
      linkSync(join(outside, "victim.txt"), join(checkout, "protected.txt"));
      const a = artifact("protected.txt", "from-cas");
      store.acceptance.materialize(checkout, [a]);
      expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("original");
      expect(readFileSync(join(checkout, "protected.txt"), "utf8")).toBe("from-cas");
      expect(store.acceptance.verify(checkout, [a])).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
