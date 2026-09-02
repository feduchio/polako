import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasConverged, type CleanRound } from "../domain/convergence.js";
import { defaultConfig } from "../domain/config.js";
import { SYSTEM_ACTOR } from "../domain/common.js";
import type { RunPhase } from "../domain/run.js";
import { FakeClock, flushMicrotasks } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { Scheduler } from "../scheduler/index.js";
import { RunEngine } from "./engine.js";

const NOW = 1_700_000_000_000;

describe("RunEngine", () => {
  let dir: string;
  let store: Store;
  let clock: FakeClock;
  let sched: Scheduler;
  let engine: RunEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polish-engine-"));
    store = openStore({ artifactsDir: join(dir, "artifacts") });
    clock = new FakeClock(NOW);
    sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 60_000 });
    engine = new RunEngine({ store, clock, scheduler: sched, config: defaultConfig() });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function advanceTo(runId: string, phase: RunPhase): Promise<void> {
    for (let i = 0; i < 40; i++) {
      const run = store.repos.runs.get(runId)!;
      if (run.phase === phase) return;
      await engine.tickRun(runId);
    }
    throw new Error(`did not reach ${phase}; stuck at ${store.repos.runs.get(runId)?.phase}`);
  }

  function recordCleanRounds(runId: string, checkpointHash: string, count: number): void {
    for (let i = 1; i <= count; i++) {
      const cleanRound: CleanRound = {
        id: id("cr", clock.now() + i),
        runId,
        checkpointHash,
        roundIndex: i,
        axes: ["correctness"],
        ensemble: [{ provider: "scripted", model: "m1" }],
        rawFindings: 0,
        validatedBlocking: 0,
        novel: true,
        createdAt: clock.now(),
      };
      store.events.append([
        {
          id: id("evt", clock.now() + i),
          runId,
          ts: clock.now(),
          type: "clean_round.recorded",
          payload: { cleanRound },
          causedBy: [],
          actor: SYSTEM_ACTOR,
          artifacts: [],
        },
      ]);
    }
  }

  it("walks stub phases to DONE when enough clean rounds exist for the current checkpoint", async () => {
    const run = engine.createRun({ projectPath: "/tmp/p" });
    expect(run.phase).toBe("CREATED");
    expect(run.control).toBe("RUNNING");

    await advanceTo(run.id, "CONVERGENCE_CHECK");
    expect(store.repos.runs.get(run.id)!.phase).toBe("CONVERGENCE_CHECK");

    const hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    engine.setCurrentCheckpoint(run.id, hash);
    recordCleanRounds(run.id, hash, 3);

    await engine.tickRun(run.id);
    const done = store.repos.runs.get(run.id)!;
    expect(done.phase).toBe("DONE");
    expect(done.terminalReason?.code).toBe("converged");
    expect(store.events.list(run.id, { types: ["run.phase_changed"] }).length).toBeGreaterThan(10);
  });

  it("pause drains in-flight work then quiesces to PAUSED; resume dispatches again", async () => {
    const run = engine.createRun({ projectPath: "/tmp/p" });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    sched.register("hold", async () => {
      await gate;
      return {};
    });
    engine.registerPhase("CREATED", () => {
      sched.enqueue({ runId: run.id, type: "hold", lane: "local.shell" });
      return { status: "waiting" };
    });

    await engine.tickRun(run.id);
    expect(sched.inFlightCount(run.id)).toBe(1);

    engine.control(run.id, "pause");
    expect(store.repos.runs.get(run.id)!.control).toBe("PAUSE_REQUESTED");

    release();
    await flushMicrotasks();
    await engine.tickRun(run.id);
    expect(store.repos.runs.get(run.id)!.control).toBe("PAUSED");
    expect(sched.inFlightCount(run.id)).toBe(0);

    let resumedDispatched = false;
    engine.registerPhase("CREATED", () => {
      resumedDispatched = true;
      return { status: "complete", nextPhase: "DISCOVERING_PROJECT" };
    });
    engine.control(run.id, "resume");
    expect(store.repos.runs.get(run.id)!.control).toBe("RUNNING");
    await engine.tickRun(run.id);
    expect(resumedDispatched).toBe(true);
    expect(store.repos.runs.get(run.id)!.phase).toBe("DISCOVERING_PROJECT");
  });

  it("stop cancels in-flight jobs and terminates as stopped_by_user", async () => {
    const run = engine.createRun({ projectPath: "/tmp/p" });
    sched.register("hold", async (ctx) => {
      await new Promise<void>((resolve, reject) => {
        ctx.signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        }, { once: true });
      });
      return {};
    });
    engine.registerPhase("CREATED", () => {
      sched.enqueue({ runId: run.id, type: "hold", lane: "local.shell" });
      return { status: "waiting" };
    });
    await engine.tickRun(run.id);
    expect(sched.inFlightCount(run.id)).toBe(1);

    engine.control(run.id, "stop");
    expect(store.repos.runs.get(run.id)!.control).toBe("STOP_REQUESTED");
    await flushMicrotasks();
    await engine.tickRun(run.id);

    const stopped = store.repos.runs.get(run.id)!;
    expect(stopped.control).toBe("STOPPED");
    expect(stopped.terminalReason?.code).toBe("stopped_by_user");
    expect(sched.inFlightCount(run.id)).toBe(0);
  });

  it("kill is absorbing and records killed_by_user", () => {
    const run = engine.createRun({ projectPath: "/tmp/p" });
    engine.control(run.id, "kill");
    const killed = store.repos.runs.get(run.id)!;
    expect(killed.control).toBe("KILLED");
    expect(killed.terminalReason?.code).toBe("killed_by_user");
    engine.control(run.id, "kill");
    expect(store.repos.runs.get(run.id)!.control).toBe("KILLED");
  });

  it("kill after DONE still appends killed_by_user termination", async () => {
    const run = engine.createRun({ projectPath: "/tmp/p" });
    await advanceTo(run.id, "CONVERGENCE_CHECK");
    const hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    engine.setCurrentCheckpoint(run.id, hash);
    recordCleanRounds(run.id, hash, 3);
    await engine.tickRun(run.id);
    expect(store.repos.runs.get(run.id)!.phase).toBe("DONE");
    expect(store.repos.runs.get(run.id)!.terminalReason?.code).toBe("converged");

    engine.control(run.id, "kill");
    const killed = store.repos.runs.get(run.id)!;
    expect(killed.control).toBe("KILLED");
    expect(killed.terminalReason?.code).toBe("killed_by_user");
    const reasons = store.events
      .list(run.id, { types: ["run.terminated"] })
      .map((e) => (e.payload["run"] as { terminalReason: { code: string } }).terminalReason.code);
    expect(reasons).toContain("killed_by_user");
  });

  it("stop after DONE settles to STOPPED with stopped_by_user", async () => {
    const run = engine.createRun({ projectPath: "/tmp/p" });
    await advanceTo(run.id, "CONVERGENCE_CHECK");
    const hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    engine.setCurrentCheckpoint(run.id, hash);
    recordCleanRounds(run.id, hash, 3);
    await engine.tickRun(run.id);
    expect(store.repos.runs.get(run.id)!.phase).toBe("DONE");

    engine.control(run.id, "stop");
    const stopped = store.repos.runs.get(run.id)!;
    expect(stopped.control).toBe("STOPPED");
    expect(stopped.terminalReason?.code).toBe("stopped_by_user");
  });

  it("tick does not dispatch READY jobs for terminal-phase runs", async () => {
    const run = engine.createRun({ projectPath: "/tmp/p" });
    await advanceTo(run.id, "CONVERGENCE_CHECK");
    const hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    engine.setCurrentCheckpoint(run.id, hash);
    recordCleanRounds(run.id, hash, 3);
    await engine.tickRun(run.id);
    expect(store.repos.runs.get(run.id)!.phase).toBe("DONE");
    expect(store.repos.runs.get(run.id)!.control).toBe("RUNNING");

    let handled = 0;
    sched.register("late", async () => {
      handled += 1;
      return {};
    });
    const job = sched.enqueue({ runId: run.id, type: "late", lane: "local.shell" });
    expect(job.state).toBe("READY");
    await engine.tick();
    expect(handled).toBe(0);
    expect(store.repos.jobs.get(job.id)!.state).toBe("READY");
  });

  it("tick does not let one run's in-flight job starve another active run", async () => {
    const blocked = engine.createRun({ projectPath: "/tmp/a" });
    const free = engine.createRun({ projectPath: "/tmp/b" });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    sched.register("hang", async () => {
      await gate;
      return {};
    });
    let freeDrives = 0;
    engine.registerPhase("CREATED", (ctx) => {
      if (ctx.run.id === blocked.id) {
        if (ctx.store.repos.jobs.listByRun(ctx.run.id).length === 0) {
          ctx.scheduler.enqueue({ runId: ctx.run.id, type: "hang", lane: "local.shell" });
        }
        return { status: "waiting" };
      }
      freeDrives += 1;
      return { status: "complete", nextPhase: "DISCOVERING_PROJECT" };
    });
    engine.registerPhase("DISCOVERING_PROJECT", (ctx) => {
      if (ctx.run.id === free.id) freeDrives += 1;
      return { status: "waiting" };
    });

    await engine.tickRun(blocked.id);
    expect(sched.inFlightCount(blocked.id)).toBe(1);
    expect(freeDrives).toBe(0);

    const tickPromise = engine.tick();
    await Promise.race([tickPromise, flushMicrotasks().then(() => flushMicrotasks())]);
    expect(freeDrives).toBeGreaterThanOrEqual(1);
    expect(store.repos.runs.get(free.id)!.phase).toBe("DISCOVERING_PROJECT");
    release();
    await tickPromise;
  });

  it("applies complete immediately even when the driver left jobs in flight", async () => {
    const run = engine.createRun({ projectPath: "/tmp/p" });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    sched.register("work", async () => {
      await gate;
      return {};
    });
    let driverCalls = 0;
    engine.registerPhase("CREATED", () => {
      driverCalls += 1;
      sched.enqueue({ runId: run.id, type: "work", lane: "local.shell" });
      return { status: "complete", nextPhase: "DISCOVERING_PROJECT" };
    });

    await engine.tickRun(run.id);
    expect(store.repos.runs.get(run.id)!.phase).toBe("DISCOVERING_PROJECT");
    expect(sched.inFlightCount(run.id)).toBe(1);
    expect(driverCalls).toBe(1);
    release();
    await flushMicrotasks();
  });

  it("crash after complete+in-flight keeps the phase advance from events", async () => {
    const run = engine.createRun({ projectPath: "/tmp/p" });
    sched.register("work", async () => {
      await new Promise<void>(() => {
        /* abandoned on simulated crash */
      });
      return {};
    });
    engine.registerPhase("CREATED", () => {
      sched.enqueue({ runId: run.id, type: "work", lane: "local.shell" });
      return { status: "complete", nextPhase: "DISCOVERING_PROJECT" };
    });
    await engine.tickRun(run.id);
    expect(store.repos.runs.get(run.id)!.phase).toBe("DISCOVERING_PROJECT");
    expect(store.events.list(run.id, { types: ["run.phase_changed"] }).length).toBeGreaterThan(0);

    // New process: same SQLite projections, no in-memory engine state.
    const sched2 = new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 60_000 });
    const engine2 = new RunEngine({ store, clock, scheduler: sched2, config: defaultConfig() }, false);
    engine2.registerPhase("DISCOVERING_PROJECT", () => ({ status: "waiting" }));
    engine2.recover();
    expect(store.repos.runs.get(run.id)!.phase).toBe("DISCOVERING_PROJECT");
    await engine2.tickRun(run.id);
    expect(store.repos.runs.get(run.id)!.phase).toBe("DISCOVERING_PROJECT");
  });

  it("draining pause does not prevent sibling active runs from being driven", async () => {
    const pausing = engine.createRun({ projectPath: "/tmp/a" });
    const sibling = engine.createRun({ projectPath: "/tmp/b" });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    sched.register("hang", async () => {
      await gate;
      return {};
    });
    let siblingDrives = 0;
    engine.registerPhase("CREATED", (ctx) => {
      if (ctx.run.id === pausing.id) {
        if (ctx.store.repos.jobs.listByRun(ctx.run.id).length === 0) {
          ctx.scheduler.enqueue({ runId: ctx.run.id, type: "hang", lane: "local.shell" });
        }
        return { status: "waiting" };
      }
      siblingDrives += 1;
      return { status: "complete", nextPhase: "DISCOVERING_PROJECT" };
    });

    await engine.tickRun(pausing.id);
    engine.control(pausing.id, "pause");
    expect(store.repos.runs.get(pausing.id)!.control).toBe("PAUSE_REQUESTED");

    const tickPromise = engine.tick();
    await Promise.race([tickPromise, flushMicrotasks().then(() => flushMicrotasks())]);
    expect(siblingDrives).toBeGreaterThanOrEqual(1);
    expect(store.repos.runs.get(sibling.id)!.phase).toBe("DISCOVERING_PROJECT");
    release();
    await flushMicrotasks();
    await tickPromise;
    expect(store.repos.runs.get(pausing.id)!.control).toBe("PAUSED");
  });
  it("changing checkpoint hash invalidates prior clean rounds for convergence", async () => {
    const run = engine.createRun({ projectPath: "/tmp/p" });
    await advanceTo(run.id, "CONVERGENCE_CHECK");
    const hashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const hashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    engine.setCurrentCheckpoint(run.id, hashA);
    recordCleanRounds(run.id, hashA, 3);
    const rounds = store.repos.cleanRounds.listByRun(run.id);
    expect(hasConverged(rounds, hashA, 3)).toBe(true);

    engine.setCurrentCheckpoint(run.id, hashB);
    const after = store.repos.runs.get(run.id)!;
    expect(after.currentCheckpointHash).toBe(hashB);
    expect(hasConverged(store.repos.cleanRounds.listByRun(run.id), hashB, 3)).toBe(false);
    expect(hasConverged(store.repos.cleanRounds.listByRun(run.id), hashA, 3)).toBe(true);

    await engine.tickRun(run.id);
    expect(store.repos.runs.get(run.id)!.phase).toBe("CONVERGENCE_CHECK");
  });

  it("recovers orphaned RUNNING jobs and continues the phase loop", async () => {
    const run = engine.createRun({ projectPath: "/tmp/p" });
    let attempts = 0;
    sched.register("fragile", async () => {
      await new Promise<void>(() => {
        /* abandoned on simulated crash */
      });
      attempts += 1;
      return { attempts };
    });

    engine.registerPhase("CREATED", (ctx) => {
      if (ctx.store.repos.jobs.listByRun(ctx.run.id).length === 0) {
        ctx.scheduler.enqueue({ runId: ctx.run.id, type: "fragile", lane: "local.shell", maxAttempts: 2 });
        return { status: "waiting" };
      }
      const job = ctx.store.repos.jobs.listByRun(ctx.run.id)[0]!;
      if (job.state === "SUCCEEDED") return { status: "complete", nextPhase: "DISCOVERING_PROJECT" };
      return { status: "waiting" };
    });

    await engine.tickRun(run.id);
    expect(sched.inFlightCount(run.id)).toBe(1);
    const orphan = store.repos.jobs.listByRun(run.id)[0]!;
    expect(orphan.state).toBe("RUNNING");

    const sched2 = new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 60_000 });
    let release2!: () => void;
    const held2 = new Promise<void>((r) => {
      release2 = r;
    });
    sched2.register("fragile", async () => {
      await held2;
      attempts += 1;
      return { attempts };
    });
    const engine2 = new RunEngine({ store, clock, scheduler: sched2, config: defaultConfig() }, false);
    engine2.registerPhase("CREATED", (ctx) => {
      const job = ctx.store.repos.jobs.listByRun(ctx.run.id)[0]!;
      if (job.state === "SUCCEEDED") return { status: "complete", nextPhase: "DISCOVERING_PROJECT" };
      return { status: "waiting" };
    });

    engine2.recover();
    expect(store.repos.jobs.get(orphan.id)?.state).toBe("READY");
    await engine2.tickRun(run.id);
    expect(sched2.inFlightCount(run.id)).toBe(1);
    release2();
    await flushMicrotasks();
    await sched2.settle(run.id);
    await engine2.tickRun(run.id);

    expect(store.repos.jobs.get(orphan.id)?.state).toBe("SUCCEEDED");
    expect(store.repos.runs.get(run.id)!.phase).toBe("DISCOVERING_PROJECT");
    expect(attempts).toBe(1);
  });
});
