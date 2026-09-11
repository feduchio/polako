import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../domain/config.js";
import { FakeClock } from "../shared/clock.js";
import { openStore } from "../store/index.js";
import { Scheduler } from "../scheduler/index.js";
import { BUDGET_EVALUATE_JOB, wallClockDueAt } from "../convergence/pathology/deadline.js";
import { RunEngine } from "./engine.js";

const NOW = 1_700_000_000_000;
const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("C2 wall-clock budget deadline", () => {
  it("persists a deadline job at run creation and fires one evaluation boundary after dueAt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-c2-deadline-"));
    cleanup.push(dir);
    const store = openStore({ artifactsDir: join(dir, "a") });
    const clock = new FakeClock(NOW);
    const config = defaultConfig();
    config.budget.maxRunWallClockMinutes = 2;
    const sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: config.lanes, leaseMs: 60_000 });
    const engine = new RunEngine({ store, clock, scheduler: sched, config, assertProjectClean: () => undefined }, false);
    const run = engine.createRun({ projectPath: dir });
    const jobs = store.repos.jobs.listByRun(run.id).filter((job) => job.type === BUDGET_EVALUATE_JOB);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.dueAt).toBe(wallClockDueAt(run.createdAt, 2));
    sched.tick();
    expect(store.events.list(run.id, { types: ["budget.evaluated"] })).toHaveLength(0);
    await clock.advance(2 * 60_000);
    const dispatched = sched.tick();
    expect(dispatched.some((job) => job.type === BUDGET_EVALUATE_JOB)).toBe(true);
    await sched.settle();
    const evaluations = store.events.list(run.id, { types: ["budget.evaluated"] });
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]?.payload["dueAt"]).toBe(jobs[0]?.dueAt);
    store.close();
  });

  it("resume after the deadline appends one deduplicated evaluation boundary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polish-c2-deadline-resume-"));
    cleanup.push(dir);
    const store = openStore({ artifactsDir: join(dir, "a") });
    const clock = new FakeClock(NOW);
    const config = defaultConfig();
    config.budget.maxRunWallClockMinutes = 1;
    const sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: config.lanes, leaseMs: 60_000 });
    const engine = new RunEngine({ store, clock, scheduler: sched, config, assertProjectClean: () => undefined }, false);
    const run = engine.createRun({ projectPath: dir });
    await clock.advance(61_000);
    engine.recover();
    expect(store.events.list(run.id, { types: ["budget.evaluated"] })).toHaveLength(1);
    engine.recover();
    expect(store.events.list(run.id, { types: ["budget.evaluated"] })).toHaveLength(1);
    store.close();
  });
});
