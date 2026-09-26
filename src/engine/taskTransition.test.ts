import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commitFindingStatus } from "../domain/finding.js";
import { defaultConfig } from "../domain/config.js";
import { createTaskFromRequirement } from "../domain/task.js";
import { RunEngine } from "./engine.js";
import { Scheduler } from "../scheduler/index.js";
import { FakeClock } from "../shared/clock.js";
import { PolishError } from "../shared/errors.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { SYSTEM_ACTOR } from "../domain/common.js";
import { transitionTask } from "./taskTransition.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("transitionTask", () => {
  it("rejects a stale GATED written after BLOCKED, and an attempts regression", () => {
    const { store, clock, runId, task } = blockedTask();
    const stale = { ...task, state: "GATED" as const, attempts: 2, updatedAt: clock.now() };
    expect(() => transitionTask(store, clock, runId, stale)).toThrow(PolishError);
    try {
      transitionTask(store, clock, runId, stale);
    } catch (error) {
      expect(error).toBeInstanceOf(PolishError);
      expect((error as PolishError).code).toBe("INVALID_TRANSITION");
    }
    expect(() => transitionTask(store, clock, runId, { ...task, attempts: 1 })).toThrow(/attempts would regress/);
    const ready = transitionTask(store, clock, runId, { ...task, state: "READY", updatedAt: clock.now() });
    expect(ready.state).toBe("READY");
    expect(store.repos.tasks.get(task.id)?.attempts).toBe(2);
    store.close();
  });

  it("names a task that does not exist as NOT_FOUND", () => {
    const { store, clock, runId, task } = blockedTask();
    const missing = { ...task, id: id("task", clock.now() + 1), state: "READY" as const };
    expect(() => transitionTask(store, clock, runId, missing)).toThrow(PolishError);
    try {
      transitionTask(store, clock, runId, missing);
    } catch (error) {
      expect((error as PolishError).code).toBe("NOT_FOUND");
    }
    store.close();
  });
});

describe("commitFindingStatus", () => {
  it("rejects a finding that skips validation", () => {
    expect(() => { commitFindingStatus("RAW", "RESOLVED", "finding"); }).toThrow(/not allowed/);
    expect(() => { commitFindingStatus("VALIDATING", "VALID", "finding"); }).not.toThrow();
  });
});

function blockedTask(): { store: Store; clock: FakeClock; runId: string; task: ReturnType<typeof createTaskFromRequirement> } {
  const dir = mkdtempSync(join(tmpdir(), "polish-task-transition-"));
  dirs.push(dir);
  const store = openStore({ artifactsDir: join(dir, "artifacts") });
  const clock = new FakeClock(1_700_000_000_000);
  const engine = new RunEngine({
    store,
    clock,
    scheduler: new Scheduler(store, clock, { workerId: "w", laneLimits: defaultConfig().lanes, leaseMs: 60_000 }),
    config: defaultConfig(),
    assertProjectClean: () => undefined,
  }, false);
  const run = engine.createRun({ projectPath: dir });
  const task = createTaskFromRequirement(id("interp", clock.now()), "R1", {
    id: id("task", clock.now()),
    runId: run.id,
    title: "Fix",
    description: "Fix it",
    kind: "bugfix",
    acceptance: ["holds"],
    complexity: "normal",
    baseCheckpointHash: "a".repeat(40),
    now: clock.now(),
  });
  const blocked = { ...task, state: "BLOCKED" as const, attempts: 2 };
  store.events.append([{
    id: id("evt", clock.now()),
    runId: run.id,
    ts: clock.now(),
    type: "task.created",
    payload: { task: blocked },
    causedBy: [],
    actor: SYSTEM_ACTOR,
    artifacts: [],
  }]);
  return { store, clock, runId: run.id, task: blocked };
}
