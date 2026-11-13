import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CARDS_REGISTERED_EVENT, registerCards, type Card } from "../cards/index.js";
import type { BaselineSnapshot } from "../domain/checks.js";
import { defaultConfig } from "../domain/config.js";
import type { Run } from "../domain/run.js";
import type { ProjectProfile } from "../project/profile.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { cancelUnreachableCards, cardRegistration, interpretationFromCards, tasksFromCards, withCardInterpretation, withCardPlanning } from "./cardDrivers.js";
import { transitionTask } from "./taskTransition.js";
import type { PhaseContext, PhaseDriver } from "./types.js";

const BASE = "a".repeat(40);

function card(cardId: string, depends: string[] = [], files = ["src/**/*.ts"]): Card {
  return { id: cardId, title: `Title ${cardId}`, depends, files, goal: `Goal of ${cardId}.`, acceptance: [`${cardId} holds`, `${cardId} is tested`] };
}

const PROFILE: ProjectProfile = {
  projectPath: "/repo",
  alias: null,
  packageManager: "pnpm",
  framework: "vitest",
  checks: [{ name: "test", kind: "test", command: ["pnpm", "test"], mandatory: true }],
  manifestHashes: {},
  scriptsHash: "0".repeat(64),
  discoveredAt: 0,
};

describe("card runs: interpretation and plan from the cards", () => {
  let dir: string;
  let store: Store;
  let clock: FakeClock;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polako-card-drivers-"));
    store = openStore({ artifactsDir: join(dir, "artifacts") });
    clock = new FakeClock(1_700_000_000_000);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(cards: readonly Card[] | null, phase: Run["phase"] = "INTERPRETING_MISSION"): PhaseContext {
    const runId = id("run", clock.now());
    const baseline: BaselineSnapshot = { id: id("base", clock.now()), runId, commitHash: BASE, checks: [], configHashes: {}, scriptsHash: "0".repeat(64), toolchain: {}, createdAt: clock.now() };
    const run: Run = {
      id: runId, missionId: id("msn", clock.now()), projectPath: "/repo", runBranch: "polako/x/run", phase, control: "RUNNING",
      currentCheckpointHash: BASE, baselineId: baseline.id, interpretationId: null, createdAt: clock.now(), updatedAt: clock.now(), terminalReason: null,
    };
    const actor = { kind: "system" as const };
    store.events.append([
      { id: id("evt", clock.now()), runId, ts: clock.now(), type: "run.created", payload: { run }, causedBy: [], actor, artifacts: [] },
      { id: id("evt", clock.now() + 1), runId, ts: clock.now() + 1, type: "baseline.snapshotted", payload: { baseline }, causedBy: [], actor, artifacts: [] },
      ...(cards === null ? [] : [{ id: id("evt", clock.now() + 2), runId, ts: clock.now() + 2, type: CARDS_REGISTERED_EVENT, payload: { registration: registerCards(cards, { brief: "Brief." }) }, causedBy: [], actor, artifacts: [] }]),
    ]);
    return { run, store, clock, config: defaultConfig(), scheduler: undefined as never };
  }

  function refresh(ctx: PhaseContext): PhaseContext {
    return { ...ctx, run: store.repos.runs.get(ctx.run.id) ?? ctx.run };
  }

  it("builds a requirement per card, taken verbatim", () => {
    const registration = registerCards([card("N01"), card("N02", ["N01"])], { brief: "Brief." });
    const interpretation = interpretationFromCards(registration, { missionId: id("msn", 1), profile: PROFILE, baselineId: id("base", 1), now: 1 });
    expect(interpretation.requirements.map((r) => [r.ref, r.acceptance])).toEqual([
      ["R1", ["N01 holds", "N01 is tested"]],
      ["R2", ["N02 holds", "N02 is tested"]],
    ]);
    expect(interpretation.requirements[0]?.statement).toContain("Card N01: Title N01. Goal of N01.");
    expect(interpretation.goals).toEqual(["N01: Title N01", "N02: Title N02"]);
    expect(interpretation.definitionOfSuccess).toContain("N02: N02 is tested");
    expect(interpretation.constraints.join(" ")).toContain("Change only the files each card lists");
    expect(interpretation.ambiguities).toEqual([]);
  });

  it("maps depends to task edges, files to scope, acceptance to acceptance, and records the card id", () => {
    const registration = registerCards([card("N01", [], ["a.ts"]), card("N02", ["N01"], ["b.ts", "b.test.ts"])]);
    const interpretation = interpretationFromCards(registration, { missionId: id("msn", 1), profile: PROFILE, baselineId: id("base", 1), now: 1 });
    const [first, second] = tasksFromCards(registration, { runId: id("run", 1), interpretation, baseCheckpointHash: BASE, now: 1 });
    expect(first).toMatchObject({ cardId: "N01", allowedFiles: ["a.ts"], dependsOn: [], acceptance: ["N01 holds", "N01 is tested"], state: "PENDING", origin: { kind: "mission_requirement", requirementRef: "R1" } });
    expect(second).toMatchObject({ cardId: "N02", allowedFiles: ["b.ts", "b.test.ts"], dependsOn: [first?.id], origin: { requirementRef: "R2" } });
    expect(second?.description).toContain("Files you may change (the gate rejects any other changed file): b.ts, b.test.ts");
    expect(second?.acceptanceChecks).toEqual([{ kind: "test_file", path: "b.test.ts" }]);
  });

  it("INTERPRETING_MISSION interprets a card run without the council and leaves a mission run to the fallback", async () => {
    const fallback: PhaseDriver = () => ({ status: "waiting" });
    const driver = withCardInterpretation(fallback, { resolveProfile: () => PROFILE });

    const missionRun = seed(null);
    expect(await driver(missionRun)).toEqual({ status: "waiting" });

    const cardRun = seed([card("N01")]);
    expect(await driver(cardRun)).toEqual({ status: "complete", nextPhase: "DISCOVERING_MODELS" });
    const after = store.repos.runs.get(cardRun.run.id);
    expect(after?.interpretationId).not.toBeNull();
    expect(store.repos.interpretations.get(after?.interpretationId ?? "")?.requirements).toHaveLength(1);
    // once interpreted, the driver does not interpret again
    expect(await driver(refresh(cardRun))).toEqual({ status: "complete", nextPhase: "DISCOVERING_MODELS" });
    expect(store.events.list(cardRun.run.id, { types: ["mission.interpreted"] })).toHaveLength(1);
  });

  it("PLANNING creates the whole DAG from the cards once, then defers to the ordinary planner", async () => {
    let deferred = 0;
    const fallback: PhaseDriver = () => {
      deferred += 1;
      return { status: "complete", nextPhase: "EXECUTING" };
    };
    const interpret = withCardInterpretation(fallback, { resolveProfile: () => PROFILE });
    const plan = withCardPlanning(fallback);
    const ctx = seed([card("N01"), card("N02", ["N01"]), card("N03", ["N02", "N01"])], "INTERPRETING_MISSION");
    await interpret(ctx);
    const planning = refresh(ctx);

    expect(await plan(planning)).toEqual({ status: "complete", nextPhase: "EXECUTING" });
    expect(deferred).toBe(0);
    const tasks = store.repos.tasks.listByRun(ctx.run.id);
    expect(tasks.map((t) => t.cardId).sort()).toEqual(["N01", "N02", "N03"]);
    const byCard = new Map(tasks.map((t) => [t.cardId, t]));
    expect(byCard.get("N03")?.dependsOn.sort()).toEqual([byCard.get("N01")?.id, byCard.get("N02")?.id].sort());
    expect(store.events.list(ctx.run.id, { types: ["task.created"] }).every((event) => (event.payload["task"] as { cardId?: string }).cardId !== undefined)).toBe(true);

    await plan(refresh(planning));
    expect(deferred).toBe(1);
    expect(store.repos.tasks.listByRun(ctx.run.id)).toHaveLength(3);
  });

  it("waits for the interpretation instead of planning without one", async () => {
    const plan = withCardPlanning(() => ({ status: "complete", nextPhase: "EXECUTING" }));
    expect(await plan(seed([card("N01")], "PLANNING"))).toEqual({ status: "waiting" });
  });

  it("cancels cards that wait on a card that can no longer be integrated, transitively", async () => {
    const interpret = withCardInterpretation(() => ({ status: "waiting" }), { resolveProfile: () => PROFILE });
    const plan = withCardPlanning(() => ({ status: "complete", nextPhase: "EXECUTING" }));
    const ctx = seed([card("A"), card("B", ["A"]), card("C", ["B"]), card("D")]);
    await interpret(ctx);
    await plan(refresh(ctx));
    const byCard = () => new Map(store.repos.tasks.listByRun(ctx.run.id).map((t) => [t.cardId, t]));

    expect(cancelUnreachableCards(refresh(ctx))).toEqual([]);

    const a = byCard().get("A");
    if (a === undefined) throw new Error("card A missing");
    for (const state of ["READY", "RUNNING", "BLOCKED"] as const) {
      transitionTask(store, clock, ctx.run.id, { ...(store.repos.tasks.get(a.id) ?? a), state, updatedAt: clock.now() });
    }
    expect(cancelUnreachableCards(refresh(ctx)).sort()).toEqual(["B", "C"]);
    expect([...byCard().entries()].map(([cardId, task]) => [cardId, task.state]).sort()).toEqual([["A", "BLOCKED"], ["B", "CANCELLED"], ["C", "CANCELLED"], ["D", "PENDING"]]);
  });

  it("reads nothing for a mission run", () => {
    expect(cardRegistration(seed(null))).toBeNull();
    expect(cardRegistration(seed([card("N01")]))?.brief).toBe("Brief.");
  });
});
