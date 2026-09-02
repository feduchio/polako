import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AcceptanceArtifact } from "../domain/acceptance.js";
import type { NewEvent } from "../domain/event.js";
import type { Run } from "../domain/run.js";
import type { Task } from "../domain/task.js";
import { sha256Hex } from "../shared/hash.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "./index.js";

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

    store.db.prepare("UPDATE tasks SET state = 'CANCELLED' WHERE run_id = ?").run(runId);
    store.db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    expect(store.repos.runs.get(runId)).toBeNull();

    const replayed = store.events.rebuildProjections(runId);
    expect(replayed).toBe(4);
    expect({ run: store.repos.runs.get(runId), tasks: store.repos.tasks.listByRun(runId) }).toEqual(live);
    expect(live.tasks[0]?.state).toBe("READY");
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

  it("refuses paths that escape the checkout", () => {
    const a = artifact("../outside.ts", "x");
    expect(() => {
      store.acceptance.materialize(checkout, [a]);
    }).toThrow(/escapes/);
    expect(() => store.acceptance.verify(checkout, [a])).toThrow(/escapes/);
  });
});
