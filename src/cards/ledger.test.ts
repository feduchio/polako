import { describe, expect, it } from "vitest";
import type { Event } from "../domain/event.js";
import type { Task } from "../domain/task.js";
import { projectCardLedger, renderCardLedger } from "./ledger.js";
import { CARDS_REGISTERED_EVENT, type Card } from "./types.js";

let seq = 0;
const T0 = 1_700_000_000_000;
const MIN = 60_000;

function event(type: string, ts: number, payload: Record<string, unknown>): Event {
  seq += 1;
  return { id: `evt_${String(seq)}`, runId: "run_x", seq, ts, type, payload, causedBy: [], actor: { kind: "system" }, artifacts: [], schemaVersion: 1 } as unknown as Event;
}

function card(id: string, depends: string[] = []): Card {
  return { id, title: `Title ${id}`, depends, files: [`${id.toLowerCase()}/*.ts`], goal: "g", acceptance: ["a"] };
}

function task(id: string, cardId: string, state: Task["state"], dependsOn: string[] = [], attempts = 1): Task {
  return { id, cardId, state, dependsOn, attempts } as unknown as Task;
}

const candidate = (taskId: string, gateFailures: { reason: string; detail: string }[] = []) => ({
  taskId,
  model: { provider: "local", model: "ornith" },
  gateReport: gateFailures.length === 0 ? null : { failures: gateFailures },
  error: null,
});

const execution = (id: string, hash: string, independence?: string) => ({
  id, checkpointHash: hash, completed: true, requestedModel: { provider: "local", model: "gpt-oss" }, ...(independence === undefined ? {} : { independence }),
});

describe("projectCardLedger", () => {
  it("is null for a mission run", () => {
    expect(projectCardLedger([event("run.created", T0, {})], T0)).toBeNull();
  });

  it("reports result, commit, minutes, swap seconds, review independence and the rejecting reviewer per card", () => {
    seq = 0;
    const events: Event[] = [
      event(CARDS_REGISTERED_EVENT, T0, { registration: { cards: [card("A"), card("B", ["A"]), card("C", ["B"]), card("D")], brief: "", briefSource: null, droppedDependencies: [] } }),
      event("task.created", T0, { task: task("t_a", "A", "PENDING") }),
      event("task.created", T0, { task: task("t_b", "B", "PENDING", ["t_a"]) }),
      event("task.created", T0, { task: task("t_c", "C", "PENDING", ["t_b"]) }),
      event("task.created", T0, { task: task("t_d", "D", "PENDING") }),
      // A: accepted after 12 minutes, with 18.4 s of swapping inside the window
      event("candidate.created", T0 + MIN, { candidate: candidate("t_a") }),
      event("local.model_swap", T0 + 2 * MIN, { from: null, to: "ornith", ms: 18_400 }),
      event("checkpoint.created", T0 + 13 * MIN, { checkpoint: { commitHash: "aaaaaaaa11112222", taskId: "t_a", source: "integration" } }),
      event("task.state_changed", T0 + 13 * MIN, { task: task("t_a", "A", "INTEGRATED") }),
      event("local.model_swap", T0 + 14 * MIN, { from: "ornith", to: "gpt-oss", ms: 9_000 }),
      // B: integrated, reviewed in isolation, a reviewer's blocking finding on the covering checkpoint
      event("candidate.created", T0 + 15 * MIN, { candidate: candidate("t_b") }),
      event("checkpoint.created", T0 + 20 * MIN, { checkpoint: { commitHash: "bbbbbbbb33334444", taskId: "t_b", source: "integration" } }),
      event("task.state_changed", T0 + 20 * MIN, { task: task("t_b", "B", "INTEGRATED") }),
      event("review.finished", T0 + 21 * MIN, { execution: execution("rv1", "bbbbbbbb33334444") }),
      event("review.finished", T0 + 22 * MIN, { execution: execution("rv2", "bbbbbbbb33334444", "same-model-isolated") }),
      event("finding.raised", T0 + 22 * MIN, { finding: { checkpointHash: "bbbbbbbb33334444", blocking: true, claim: "off-by-one in placeTower", evidence: [{ path: "b/place.ts" }], reportedBy: { model: { provider: "local", model: "gpt-oss" } } } }),
      // C never started: its dependency B... is fine, so it is merely waiting
      // D: blocked after its gates rejected it for a scope violation
      event("candidate.gated", T0 + 5 * MIN, { candidate: candidate("t_d", [{ reason: "scope_violation", detail: "package.json: not allowed by the task card's files" }]) }),
      event("task.state_changed", T0 + 9 * MIN, { task: task("t_d", "D", "BLOCKED", [], 5) }),
    ];
    const rows = projectCardLedger(events, T0 + 30 * MIN) ?? [];
    const byCard = Object.fromEntries(rows.map((row) => [row.card, row]));

    expect(byCard["A"]).toMatchObject({ result: "accepted", commit: "aaaaaaaa", minutes: 12, swapSeconds: 18.4, rejectedBy: null });
    // A's checkpoint was never reviewed itself; B's later review covers it
    expect(byCard["A"]?.reviewIndependence).toBe("same-model-isolated");
    expect(byCard["A"]?.rejectedBy).toBeNull();
    expect(byCard["B"]).toMatchObject({
      result: "accepted",
      commit: "bbbbbbbb",
      minutes: 5,
      swapSeconds: 0,
      reviewIndependence: "same-model-isolated",
      rejectedBy: { by: "local:gpt-oss", first: "off-by-one in placeTower" },
    });
    expect(byCard["C"]).toMatchObject({ result: "waiting", commit: null, minutes: null, reviewIndependence: null });
    expect(byCard["D"]).toMatchObject({ result: "failed", note: "blocked after 5 attempt(s)", rejectedBy: { by: "gate", first: "scope_violation: package.json: not allowed by the task card's files" } });
  });

  it("calls a READY card waiting, not running: only one card runs at a time", () => {
    seq = 0;
    const events: Event[] = [
      event(CARDS_REGISTERED_EVENT, T0, { registration: { cards: [card("A"), card("B")], brief: "", briefSource: null, droppedDependencies: [] } }),
      event("task.created", T0, { task: task("t_a", "A", "READY") }),
      event("task.created", T0, { task: task("t_b", "B", "READY") }),
      event("task.state_changed", T0 + MIN, { task: task("t_a", "A", "RUNNING") }),
    ];
    expect((projectCardLedger(events, T0 + 2 * MIN) ?? []).map((row) => [row.card, row.result])).toEqual([["A", "running"], ["B", "waiting"]]);
  });

  it("calls a card skipped when its dependency failed", () => {
    seq = 0;
    const events: Event[] = [
      event(CARDS_REGISTERED_EVENT, T0, { registration: { cards: [card("A"), card("B", ["A"])], brief: "", briefSource: null, droppedDependencies: [] } }),
      event("task.created", T0, { task: task("t_a", "A", "PENDING") }),
      event("task.created", T0, { task: task("t_b", "B", "PENDING", ["t_a"]) }),
      event("task.state_changed", T0 + MIN, { task: task("t_a", "A", "BLOCKED", [], 5) }),
      event("task.state_changed", T0 + MIN, { task: task("t_b", "B", "CANCELLED", ["t_a"]) }),
    ];
    const rows = projectCardLedger(events, T0 + 2 * MIN) ?? [];
    expect(rows[1]).toMatchObject({ card: "B", result: "skipped", note: "skipped: A did not pass" });
  });

  it("renders one aligned line per card", () => {
    const lines = renderCardLedger([
      { card: "N01", title: "t", result: "accepted", state: "INTEGRATED", commit: "abcd1234", minutes: 4.5, swapSeconds: 18.4, reviewIndependence: "lineage", rejectedBy: null, note: "" },
      { card: "N02", title: "t", result: "failed", state: "BLOCKED", commit: null, minutes: null, swapSeconds: 0, reviewIndependence: null, rejectedBy: { by: "gate", first: "scope_violation: x" }, note: "blocked after 5 attempt(s)" },
    ]);
    expect(lines[0]).toBe("N01   accepted  abcd1234 4.5 min   swap 18.4s lineage");
    expect(lines[1]).toContain("failed");
    expect(lines[1]).toContain("rejected by gate: scope_violation: x blocked after 5 attempt(s)");
  });
});

describe("per-card state in `polako status`", () => {
  it("adds a CARDS section for a card run and nothing for a mission run", async () => {
    const { projectRunStatus } = await import("../observe/project.js");
    const { renderRunStatus } = await import("../observe/render.js");
    seq = 0;
    const run = { id: "run_x", projectPath: "/repo", phase: "EXECUTING", control: "RUNNING", currentCheckpointHash: null, baselineId: null, createdAt: T0, updatedAt: T0 } as never;
    const cardEvents: Event[] = [
      event(CARDS_REGISTERED_EVENT, T0, { registration: { cards: [card("N01")], brief: "", briefSource: null, droppedDependencies: [] } }),
      event("task.created", T0, { task: task("t_1", "N01", "RUNNING") }),
      event("candidate.created", T0 + MIN, { candidate: candidate("t_1") }),
    ];
    const text = renderRunStatus(projectRunStatus(run, cardEvents, T0 + 3 * MIN));
    expect(text).toContain("CARDS\nN01   running");
    expect(text).toContain("2 min");
    expect(renderRunStatus(projectRunStatus(run, [event("run.created", T0, {})], T0))).not.toContain("CARDS");
  });
});
