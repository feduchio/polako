import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../domain/config.js";
import type { Run } from "../domain/run.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import { Scheduler } from "./scheduler.js";

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

describe("scheduler cancel intent replay integrity", () => {
  let dir: string;
  let store: Store;
  let clock: FakeClock;
  let sched: Scheduler;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polish-sched-cancel-"));
    store = openStore({ artifactsDir: join(dir, "artifacts") });
    clock = new FakeClock(NOW);
    sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 1000 });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists cancelRequested through rebuild and prevents redispatch", async () => {
    const run = makeRun(store, clock);
    sched.register("noop", async () => ({}));
    const job = sched.enqueue({ runId: run.id, type: "noop", lane: "local.shell" });
    const snapshot = store.repos.jobs.get(job.id)!;
    store.events.append([{
      id: id("evt", clock.now()),
      runId: run.id,
      ts: clock.now(),
      type: "job.cancel_requested",
      payload: { job: { ...snapshot, cancelRequested: true, updatedAt: clock.now() } },
      causedBy: [],
      actor: { kind: "system" },
      artifacts: [],
    }]);
    expect(store.repos.jobs.get(job.id)?.cancelRequested).toBe(true);

    store.events.rebuildProjections(run.id);
    expect(store.repos.jobs.get(job.id)?.cancelRequested).toBe(true);

    const dispatched = sched.tick();
    expect(dispatched).toEqual([]);
    expect(store.repos.jobs.get(job.id)?.state).toBe("CANCELLED");
    expect(sched.tick()).toEqual([]);
  });
});
