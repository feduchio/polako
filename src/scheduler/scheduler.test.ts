import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../domain/config.js";
import type { Run, RunControl } from "../domain/run.js";
import { FakeClock, flushMicrotasks } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { Scheduler, type JobContext } from "./scheduler.js";

const NOW = 1_700_000_000_000;

function makeRun(store: Store, clock: FakeClock): Run {
  const runId = id("run", clock.now());
  const run: Run = {
    id: runId,
    missionId: id("msn", clock.now()),
    projectPath: "/tmp/p",
    runBranch: `polish/${runId}`,
    phase: "EXECUTING",
    control: "RUNNING",
    currentCheckpointHash: null,
    baselineId: null,
    interpretationId: null,
    createdAt: clock.now(),
    updatedAt: clock.now(),
    terminalReason: null,
  };
  store.events.append([
    { id: id("evt", clock.now()), runId, ts: clock.now(), type: "run.created", payload: { run }, causedBy: [], actor: { kind: "system" }, artifacts: [] },
  ]);
  return run;
}

function setControl(store: Store, run: Run, control: RunControl): void {
  store.events.append([
    {
      id: id("evt"),
      runId: run.id,
      ts: NOW,
      type: "run.control_changed",
      payload: { run: { ...run, control } },
      causedBy: [],
      actor: { kind: "user" },
      artifacts: [],
    },
  ]);
}

describe("Scheduler", () => {
  let dir: string;
  let store: Store;
  let clock: FakeClock;
  let sched: Scheduler;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polish-sched-"));
    store = openStore({ artifactsDir: join(dir, "artifacts") });
    clock = new FakeClock(NOW);
    sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 1000 });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs a job to completion and records the result through events", async () => {
    const run = makeRun(store, clock);
    sched.register("echo", async (ctx) => ({ got: ctx.job.payload["x"] }));
    const job = sched.enqueue({ runId: run.id, type: "echo", lane: "local.shell", payload: { x: 1 } });
    expect(store.repos.jobs.get(job.id)?.state).toBe("READY");
    const dispatched = sched.tick();
    expect(dispatched.map((j) => j.id)).toEqual([job.id]);
    await sched.settle();
    const done = store.repos.jobs.get(job.id)!;
    expect(done.state).toBe("SUCCEEDED");
    expect(done.result).toEqual({ got: 1 });
    expect(done.leaseOwner).toBeNull();
    expect(store.events.list(run.id, { types: ["job.state_changed"] }).map((e) => (e.payload["job"] as { state: string }).state)).toEqual([
      "RUNNING",
      "SUCCEEDED",
    ]);
  });

  it("respects lane capacity and priority; integration lane is strictly serial", async () => {
    const run = makeRun(store, clock);
    const started: string[] = [];
    const release = new Map<string, () => void>();
    sched.register("slow", (ctx: JobContext) => {
      started.push(ctx.job.payload["name"] as string);
      return new Promise<undefined>((resolve) => release.set(ctx.job.payload["name"] as string, () => { resolve(undefined); }));
    });
    sched.enqueue({ runId: run.id, type: "slow", lane: "integration", payload: { name: "low" }, priority: 0 });
    sched.enqueue({ runId: run.id, type: "slow", lane: "integration", payload: { name: "high" }, priority: 10 });
    sched.enqueue({ runId: run.id, type: "slow", lane: "local.test", payload: { name: "t1" } });
    sched.enqueue({ runId: run.id, type: "slow", lane: "local.test", payload: { name: "t2" } });
    sched.enqueue({ runId: run.id, type: "slow", lane: "local.test", payload: { name: "t3" } });

    sched.tick();
    expect(started).toEqual(["high", "t1", "t2"]);
    expect(sched.inFlightCount()).toBe(3);

    release.get("high")!();
    await flushMicrotasks();
    sched.tick();
    expect(started).toEqual(["high", "t1", "t2", "low"]);
    for (const r of release.values()) r();
    await sched.settle();
    sched.tick();
    expect(started).toEqual(["high", "t1", "t2", "low", "t3"]);
    release.get("t3")!();
    await sched.settle();
    expect(sched.inFlightCount()).toBe(0);
  });

  it("promotes dependents when deps succeed and cascades cancellation when deps fail", async () => {
    const run = makeRun(store, clock);
    sched.register("ok", async () => ({}));
    sched.register("boom", async () => {
      throw new Error("boom");
    });
    const a = sched.enqueue({ runId: run.id, type: "ok", lane: "local.shell" });
    const b = sched.enqueue({ runId: run.id, type: "ok", lane: "local.shell", dependsOn: [a.id] });
    const f = sched.enqueue({ runId: run.id, type: "boom", lane: "local.shell" });
    const g = sched.enqueue({ runId: run.id, type: "ok", lane: "local.shell", dependsOn: [f.id] });
    const h = sched.enqueue({ runId: run.id, type: "ok", lane: "local.shell", dependsOn: [g.id] });
    expect(store.repos.jobs.get(b.id)?.state).toBe("PENDING");

    sched.tick();
    await sched.settle();
    sched.tick();
    await sched.settle();
    sched.tick();
    expect(store.repos.jobs.get(b.id)?.state).toBe("SUCCEEDED");
    expect(store.repos.jobs.get(f.id)?.state).toBe("FAILED");
    expect(store.repos.jobs.get(g.id)?.state).toBe("CANCELLED");
    expect(store.repos.jobs.get(h.id)?.state).toBe("CANCELLED");
  });

  it("retries up to maxAttempts then fails", async () => {
    const run = makeRun(store, clock);
    let calls = 0;
    sched.register("flaky", async () => {
      calls++;
      if (calls < 3) throw new Error(`fail ${calls}`);
      return { calls };
    });
    const j = sched.enqueue({ runId: run.id, type: "flaky", lane: "local.shell", maxAttempts: 3 });
    for (let i = 0; i < 3; i++) {
      sched.tick();
      await sched.settle();
    }
    const done = store.repos.jobs.get(j.id)!;
    expect(done.state).toBe("SUCCEEDED");
    expect(done.attempts).toBe(3);

    calls = -10;
    const k = sched.enqueue({ runId: run.id, type: "flaky", lane: "local.shell", maxAttempts: 2 });
    for (let i = 0; i < 3; i++) {
      sched.tick();
      await sched.settle();
    }
    expect(store.repos.jobs.get(k.id)?.state).toBe("FAILED");
    expect(store.repos.jobs.get(k.id)?.error).toMatch(/fail/);
  });

  it("pause stops dispatch but lets in-flight jobs drain; stop aborts them", async () => {
    const run = makeRun(store, clock);
    const aborted: string[] = [];
    const release = new Map<string, () => void>();
    sched.register("wait", (ctx: JobContext) => {
      const name = ctx.job.payload["name"] as string;
      return new Promise<undefined>((resolve, reject) => {
        release.set(name, () => { resolve(undefined); });
        ctx.signal.addEventListener("abort", () => {
          aborted.push(name);
          reject(ctx.signal.reason as Error);
        });
      });
    });
    sched.enqueue({ runId: run.id, type: "wait", lane: "local.build", payload: { name: "a" } });
    const b = sched.enqueue({ runId: run.id, type: "wait", lane: "local.build", payload: { name: "b" } });
    sched.tick();
    expect(sched.inFlightCount(run.id)).toBe(1);

    setControl(store, { ...run }, "PAUSE_REQUESTED");
    sched.tick();
    expect(sched.inFlightCount(run.id)).toBe(1);
    expect(store.repos.jobs.get(b.id)?.state).toBe("READY");
    release.get("a")!();
    await sched.settle(run.id);
    expect(aborted).toEqual([]);

    setControl(store, { ...run }, "RUNNING");
    sched.tick();
    expect(sched.inFlightCount(run.id)).toBe(1);
    const c = sched.enqueue({ runId: run.id, type: "wait", lane: "local.build", payload: { name: "c" } });

    setControl(store, { ...run }, "STOP_REQUESTED");
    sched.tick();
    await sched.settle();
    expect(aborted).toEqual(["b"]);
    expect(store.repos.jobs.get(b.id)?.state).toBe("CANCELLED");
    expect(store.repos.jobs.get(c.id)?.state).toBe("CANCELLED");
  });

  it("recovers jobs left RUNNING by a dead worker and reclaims expired leases", async () => {
    const run = makeRun(store, clock);
    sched.register("noop", async () => ({}));
    const j = sched.enqueue({ runId: run.id, type: "noop", lane: "local.shell", maxAttempts: 2 });
    // simulate a previous process: mark RUNNING with a foreign lease without any in-flight promise
    store.events.append([
      {
        id: id("evt"),
        runId: run.id,
        ts: NOW,
        type: "job.state_changed",
        payload: { job: { ...j, state: "RUNNING", attempts: 1, leaseOwner: "dead-worker", leaseUntil: NOW + 5000 } },
        causedBy: [],
        actor: { kind: "system" },
        artifacts: [],
      },
    ]);
    const other = new Scheduler(store, clock, { workerId: "w2", laneLimits: defaultConfig().lanes, leaseMs: 1000 });
    other.register("noop", async () => ({}));
    const reclaimed = other.recover();
    expect(reclaimed.map((x) => x.id)).toEqual([j.id]);
    expect(store.repos.jobs.get(j.id)?.state).toBe("READY");
    other.tick();
    await other.settle();
    expect(store.repos.jobs.get(j.id)?.state).toBe("SUCCEEDED");
    expect(store.repos.jobs.get(j.id)?.attempts).toBe(2);
  });

  it("an expired lease with no in-flight owner is returned to READY on tick, or FAILED when attempts are exhausted", async () => {
    const run = makeRun(store, clock);
    sched.register("noop", async () => ({}));
    const a = sched.enqueue({ runId: run.id, type: "noop", lane: "local.shell", maxAttempts: 2 });
    const b = sched.enqueue({ runId: run.id, type: "noop", lane: "local.shell", maxAttempts: 1 });
    for (const j of [a, b]) {
      store.events.append([
        {
          id: id("evt"),
          runId: run.id,
          ts: NOW,
          type: "job.state_changed",
          payload: { job: { ...j, state: "RUNNING", attempts: 1, leaseOwner: "w1", leaseUntil: NOW + 100 } },
          causedBy: [],
          actor: { kind: "system" },
          artifacts: [],
        },
      ]);
    }
    await clock.advance(500);
    setControl(store, run, "PAUSED"); // prevent re-dispatch in this tick so we can observe the reclaim
    sched.tick();
    expect(store.repos.jobs.get(a.id)?.state).toBe("READY");
    expect(store.repos.jobs.get(b.id)?.state).toBe("FAILED");
  });

  it("heartbeat extends the lease of a running job", async () => {
    const run = makeRun(store, clock);
    let ctxRef: JobContext | null = null;
    let release: () => void = () => undefined;
    sched.register("long", (ctx) => {
      ctxRef = ctx;
      return new Promise<undefined>((r) => (release = () => { r(undefined); }));
    });
    const j = sched.enqueue({ runId: run.id, type: "long", lane: "local.shell" });
    sched.tick();
    expect(store.repos.jobs.get(j.id)?.leaseUntil).toBe(NOW + 1000);
    await clock.advance(700);
    ctxRef!.heartbeat();
    expect(store.repos.jobs.get(j.id)?.leaseUntil).toBe(NOW + 1700);
    release();
    await sched.settle();
  });

  it("jobs without a registered handler fail instead of hanging", () => {
    const run = makeRun(store, clock);
    const j = sched.enqueue({ runId: run.id, type: "unknown", lane: "local.shell" });
    sched.tick();
    expect(store.repos.jobs.get(j.id)?.state).toBe("FAILED");
  });

  it("a synchronously throwing handler does not leave a phantom in-flight entry (settle terminates)", async () => {
    const run = makeRun(store, clock);
    sched.register("boom", () => {
      throw new Error("sync");
    });
    const j = sched.enqueue({ runId: run.id, type: "boom", lane: "local.shell", maxAttempts: 1 });
    sched.tick();
    await flushMicrotasks();
    expect(store.repos.jobs.get(j.id)?.state).toBe("FAILED");
    expect(sched.inFlightCount()).toBe(0);
    await sched.settle();
  });

  function persistRunning(run: Run, j: ReturnType<Scheduler["enqueue"]>, patch: { attempts: number; leaseOwner: string; leaseUntil: number }): void {
    store.events.append([
      {
        id: id("evt"),
        runId: run.id,
        ts: NOW,
        type: "job.state_changed",
        payload: { job: { ...j, state: "RUNNING", ...patch } },
        causedBy: [],
        actor: { kind: "system" },
        artifacts: [],
      },
    ]);
  }

  it("recover() reclaims orphaned jobs even with a fresh lease under the same workerId, and fails those with exhausted attempts", async () => {
    const run = makeRun(store, clock);
    sched.register("noop", async () => ({}));
    const a = sched.enqueue({ runId: run.id, type: "noop", lane: "local.shell", maxAttempts: 2 });
    const b = sched.enqueue({ runId: run.id, type: "noop", lane: "local.shell", maxAttempts: 1 });
    persistRunning(run, a, { attempts: 1, leaseOwner: "w1", leaseUntil: NOW + 10_000 }); // same id, fresh lease
    persistRunning(run, b, { attempts: 1, leaseOwner: "other", leaseUntil: NOW + 10_000 }); // foreign, exhausted

    const restarted = new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 1000 });
    restarted.register("noop", async () => ({}));
    const reclaimed = restarted.recover().map((x) => [x.id, x.state]);
    expect(reclaimed).toEqual([
      [a.id, "READY"],
      [b.id, "FAILED"],
    ]);
    restarted.tick();
    await restarted.settle();
    expect(store.repos.jobs.get(a.id)).toMatchObject({ state: "SUCCEEDED", attempts: 2 });
    expect(store.repos.jobs.get(b.id)).toMatchObject({ state: "FAILED", attempts: 1 });
  });

  it("jobs of a non-existent run are never dispatched", () => {
    expect(() => sched.enqueue({ runId: id("run"), type: "noop", lane: "local.shell" })).toThrow(/not found/);
    // a job whose run projection vanished after creation
    const run = makeRun(store, clock);
    let calls = 0;
    sched.register("noop", async () => {
      calls++;
      return {};
    });
    const j = sched.enqueue({ runId: run.id, type: "noop", lane: "local.shell" });
    store.db.prepare("DELETE FROM runs WHERE id = ?").run(run.id);
    sched.tick();
    expect(calls).toBe(0);
    expect(store.repos.jobs.get(j.id)?.state).toBe("FAILED");
  });

  it("dispatch order is total: priority, then creation time, then creation order within the same millisecond", async () => {
    const run = makeRun(store, clock);
    const order: string[] = [];
    sched.register("rec", async (ctx) => {
      order.push(ctx.job.payload["n"] as string);
      return {};
    });
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) ids.push(sched.enqueue({ runId: run.id, type: "rec", lane: "llm.default", payload: { n: `j${i}` } }).id);
    // ids are random within one FakeClock millisecond, so lexical order would not reproduce creation order
    expect([...ids].sort()).not.toEqual(ids);
    const listed = store.repos.jobs.listByState(["READY"]).map((j) => j.id);
    expect(listed).toEqual(ids);
    store.events.rebuildProjections(run.id);
    expect(store.repos.jobs.listByState(["READY"]).map((j) => j.id)).toEqual(ids);
  });

  it("a failing terminal write is reported through onPersistError instead of an unhandled rejection", async () => {
    const run = makeRun(store, clock);
    const errors: unknown[] = [];
    const s = new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 1000, onPersistError: (e) => errors.push(e) });
    let release: () => void = () => undefined;
    s.register("long", () => new Promise<undefined>((r) => (release = () => { r(undefined); })));
    const j = s.enqueue({ runId: run.id, type: "long", lane: "local.shell" });
    s.tick();
    const original = store.events.append.bind(store.events);
    store.events.append = () => {
      throw new Error("terminal write failed");
    };
    release();
    await s.settle();
    store.events.append = original;
    expect(errors).toHaveLength(1);
    expect(store.repos.jobs.get(j.id)?.state).toBe("RUNNING");
    expect(s.inFlightCount()).toBe(0);
    // lease expiry reclaims it later
    await clock.advance(2000);
    s.tick();
    expect(store.repos.jobs.get(j.id)?.state).toBe("FAILED");
  });
});
