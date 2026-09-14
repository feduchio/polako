import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { budgetSnapshotFromUsage, foldModelCallUsage } from "../convergence/pathology/index.js";
import { BudgetTracker, type BudgetSnapshot } from "../broker/quota.js";
import type { Run } from "../domain/run.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { Git } from "../sandbox/git.js";
import { FakeClock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import { PolishError } from "../shared/errors.js";
import { DaemonService } from "./service.js";

const dirs: string[] = [];
const services: DaemonService[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) await service.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Finding 12's spend half. `ModelBroker.restore` folded a run's `model.call` events back into the
 * budget tracker and had no production caller, so a restarted daemon believed every run had spent
 * nothing and a run could spend its whole budget again after each restart.
 */
describe("P1.3 spend restored across a daemon restart", () => {
  it("reports non-zero spend for a run recovered over the same store", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 1_000 });
    const runId = await fixture.createRun({});
    await fixture.call(runId);
    await fixture.call(runId);
    const spentBefore = fixture.spendOf(runId).runTokens;
    expect(spentBefore).toBeGreaterThan(0);

    const restarted = await fixture.restart();
    expect(restarted.spendOf(runId).runTokens).toBe(spentBefore);
  });

  it("makes the restored spend bind: the next call over the cap is rejected", async () => {
    // The cap is derived from what a call actually costs, so the check does not depend on the
    // scripted provider's token count staying what it is today.
    const probe = await daemonFixture({ maxRunTokens: 1_000_000 });
    const probeRun = await probe.createRun({});
    await probe.call(probeRun);
    const perCall = probe.spendOf(probeRun).runTokens;
    expect(perCall).toBeGreaterThan(0);

    const fixture = await daemonFixture({ maxRunTokens: perCall * 2 });
    const runId = await fixture.createRun({});
    await fixture.call(runId);
    await fixture.call(runId);

    // The cap is exactly spent before the restart. Without restoration the counter is zero and
    // this resolves; restoring a number nothing enforces would satisfy the check above, not this.
    const restarted = await fixture.restart();
    await expect(restarted.call(runId)).rejects.toThrow(PolishError);
  });

  it("does not restore a run that has reached a terminal phase", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 1_000 });
    const runId = await fixture.createRun({});
    await fixture.call(runId);
    fixture.setPhase(runId, "DONE");

    const restarted = await fixture.restart();
    expect(restarted.spendOf(runId).runTokens).toBe(0);
  });

  /** P1.12 makes STOPPED resumable, so its already-spent budget must survive restart too. */
  it("restores a stopped run that can later resume", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 1_000 });
    const runId = await fixture.createRun({});
    await fixture.call(runId);
    fixture.setControl(runId, "STOPPED");

    const restarted = await fixture.restart();
    expect(restarted.spendOf(runId).runTokens).toBe(15);
  });

  it("restores a snapshot equal to the fold of the run's own model.call events", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 1_000 });
    const runId = await fixture.createRun({});
    await fixture.call(runId, "task_0000000000abcdefghjkmn");
    await fixture.call(runId);

    const restarted = await fixture.restart();
    const expected = budgetSnapshotFromUsage(
      foldModelCallUsage(restarted.service.store.events.list(runId, { types: ["model.call"] })),
    );
    expect(restarted.snapshotOf(runId)).toEqual(expected);
  });

  /**
   * The whole path, not one hop of it: a `model.call` event carrying a prototype-colliding task id
   * has to survive the fold, `budgetSnapshotFromUsage`, `restore` and `record` and still be capped.
   * Each hop copies `perTask` differently, and `Object.assign` — the natural alternative to a
   * spread — loses the key silently at any one of them.
   */
  it("carries a prototype-colliding task id from the event log through to enforcement", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 1_000 });
    const runId = await fixture.createRun({});
    await fixture.call(runId, "__proto__");
    await fixture.call(runId, "__proto__");
    const spent = fixture.spendOf(runId).runTokens;

    const restarted = await fixture.restart();
    expect(Object.entries(restarted.snapshotOf(runId).perTask)).toEqual([["__proto__", spent]]);
  });

  it("is idempotent: restoring twice leaves the same snapshot", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 1_000 });
    const runId = await fixture.createRun({});
    await fixture.call(runId);

    const restarted = await fixture.restart();
    const once = restarted.snapshotOf(runId);
    restarted.service.productionComposition().broker.restore(runId);
    expect(restarted.snapshotOf(runId)).toEqual(once);
  });
});

/**
 * Finding 50. `record` wrote `perTask[taskId]` into an object literal, so a task id of `__proto__`
 * assigned the prototype and recorded nothing, and `assertWithin` then compared that object to the
 * cap and got `false`. Latent rather than live: minted ids cannot take these shapes.
 */
describe("BudgetTracker per-task keys that collide with Object.prototype", () => {
  const limits = { maxRunUsd: null, maxRunTokens: null, maxTaskTokens: 15 };
  const usage = { inputTokens: 10, outputTokens: 0, costUsd: null };

  it("records prototype-colliding task ids as own properties", () => {
    const tracker = new BudgetTracker(limits);
    const snapshot = tracker.record("run_1", usage, "__proto__");
    expect(Object.entries(snapshot.perTask)).toEqual([["__proto__", 10]]);
  });

  it("enforces the per-task cap for such ids instead of spending without limit", () => {
    for (const taskId of ["__proto__", "constructor", "toString"]) {
      const tracker = new BudgetTracker(limits);
      tracker.record("run_1", usage, taskId);
      expect(() => { tracker.assertWithin("run_1", taskId); }).not.toThrow();
      tracker.record("run_1", usage, taskId);
      expect(() => { tracker.assertWithin("run_1", taskId); }).toThrow(PolishError);
    }
  });

  /**
   * The snapshot is a view of live enforcement state, and `ModelBroker.budgetSnapshot` makes it
   * public. Handing back the stored object would let any reader zero a run's spend.
   */
  it("cannot be written through to change what assertWithin enforces", () => {
    const tracker = new BudgetTracker({ maxRunUsd: 9, maxRunTokens: 100, maxTaskTokens: null });
    // Two calls: one priced so `runUsd` is non-zero and assigning 0 to it is a real change, one
    // unpriced so `unknownCostCalls` is non-empty. A field left at its zero value cannot be
    // observed by writing its zero value back.
    tracker.record("run_1", { inputTokens: 40, outputTokens: 0, costUsd: 2.5 });
    tracker.record("run_1", { inputTokens: 60, outputTokens: 0, costUsd: null });
    const snapshot = tracker.snapshot("run_1");
    expect(snapshot.runUsd).toBe(2.5);
    snapshot.runTokens = 0;
    snapshot.perTask["smuggled"] = 0;
    snapshot.runUsd = 0;
    snapshot.unknownCostCalls.push("smuggled");
    expect(() => { tracker.assertWithin("run_1"); }).toThrow(PolishError);

    const after = tracker.snapshot("run_1");
    expect(after.runTokens).toBe(100);
    expect(after.runUsd).toBe(2.5);
    expect(Object.keys(after.perTask)).toEqual([]);
    expect(after.unknownCostCalls).toEqual(["unknown:0"]);
  });

  /**
   * `record` returns the object it stores, so the same write-through exists on a second public
   * surface. Fixing one and leaving the other is what MC11's rewrite exists to stop.
   */
  it("cannot be written through via the object record returns either", () => {
    const tracker = new BudgetTracker({ maxRunUsd: 9, maxRunTokens: 100, maxTaskTokens: 40 });
    tracker.record("run_1", { inputTokens: 40, outputTokens: 0, costUsd: 2.5 }, "task_a");
    const returned = tracker.record("run_1", { inputTokens: 60, outputTokens: 0, costUsd: null }, "task_a");
    // The same four fields as above. A partial copy that refreshes the outer object and the array
    // while leaving `perTask` aliased is the plausible half-fix, and it is per-task enforcement
    // that it breaks.
    returned.runTokens = 0;
    returned.runUsd = 0;
    returned.unknownCostCalls.length = 0;
    returned.perTask["task_a"] = 0;
    expect(() => { tracker.assertWithin("run_1"); }).toThrow(PolishError);
    expect(() => { tracker.assertWithin("run_1", "task_a"); }).toThrow(PolishError);

    const after = tracker.snapshot("run_1");
    expect(after.runTokens).toBe(100);
    expect(after.runUsd).toBe(2.5);
    expect(after.perTask["task_a"]).toBe(100);
    expect(after.unknownCostCalls).toEqual(["unknown:0"]);
  });

  it("keeps such ids through a restore, so the fold and the tracker agree", () => {
    const tracker = new BudgetTracker(limits);
    tracker.restore("run_1", { runUsd: 0, runTokens: 20, perTask: Object.fromEntries([["__proto__", 20]]), unknownCostCalls: [] });
    expect(Object.entries(tracker.snapshot("run_1").perTask)).toEqual([["__proto__", 20]]);
    expect(() => { tracker.assertWithin("run_1", "__proto__"); }).toThrow(PolishError);
  });
});

interface SpendFixture {
  service: DaemonService;
  home: string;
  createRun: (budget: { budgetTokens?: number; budgetUsd?: number }) => Promise<string>;
  call: (runId: string, taskId?: string) => Promise<unknown>;
  spendOf: (runId: string) => BudgetSnapshot;
  snapshotOf: (runId: string) => BudgetSnapshot;
  setPhase: (runId: string, phase: Run["phase"]) => void;
  setControl: (runId: string, control: Run["control"]) => void;
  restart: () => Promise<SpendFixture>;
}

async function daemonFixture(options: { maxRunTokens: number }): Promise<SpendFixture> {
  const dir = mkdtempSync(join(tmpdir(), "polish-p13-spend-"));
  dirs.push(dir);
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "p13-fixture", scripts: {} }));
  const git = await Git.init(repoDir);
  await git.commitAll("init");
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "polish.toml"), `[budget]\nmaxRunTokens = ${String(options.maxRunTokens)}\n`);
  return build(home, repoDir, options.maxRunTokens);
}

function provider(): ScriptedProvider {
  const scripted = new ScriptedProvider("scripted", [
    { name: "worker", capabilities: { ...FAKE_CAPABILITIES.frontier, inputCostPerM: 0, outputCostPerM: 0 } },
  ]);
  scripted.script("worker", Array.from({ length: 200 }, () => ({ kind: "reply" as const, content: "ok" })));
  return scripted;
}

function build(home: string, repoDir: string, maxRunTokens: number): SpendFixture {
  const service = new DaemonService({ home, clock: new FakeClock(1_700_000_000_000), providers: [provider()], tickMs: 1 });
  services.push(service);
  const deps = service.productionComposition();
  const fixture: SpendFixture = {
    service,
    home,
    createRun: async (budget) => {
      const run = (await service.handle("run", { project: repoDir, mission: "noop", ...budget })) as { id: string };
      return run.id;
    },
    call: async (runId, taskId) =>
      deps.broker.complete({
        model: { provider: "scripted", model: "worker" },
        messages: [{ role: "user", content: "go" }],
        metadata: { runId, purpose: "spend", role: "worker", ...(taskId === undefined ? {} : { taskId }) },
      }),
    spendOf: (runId) => deps.broker.budgetSnapshot(runId),
    snapshotOf: (runId) => deps.broker.budgetSnapshot(runId),
    setPhase: (runId, phase) => {
      const run = service.store.repos.runs.get(runId)!;
      service.store.events.append([{
        id: id("evt", service.clock.now()),
        runId,
        ts: service.clock.now(),
        type: "run.phase_changed",
        payload: { run: { ...run, phase, updatedAt: service.clock.now() } },
        causedBy: [],
        actor: { kind: "system" },
        artifacts: [],
      }]);
    },
    setControl: (runId, control) => {
      const run = service.store.repos.runs.get(runId)!;
      service.store.events.append([{
        id: id("evt", service.clock.now()),
        runId,
        ts: service.clock.now(),
        type: "run.control_changed",
        payload: { run: { ...run, control, updatedAt: service.clock.now() } },
        causedBy: [],
        actor: { kind: "system" },
        artifacts: [],
      }]);
    },
    restart: async () => {
      await service.close();
      services.splice(services.indexOf(service), 1);
      return build(home, repoDir, maxRunTokens);
    },
  };
  return fixture;
}
