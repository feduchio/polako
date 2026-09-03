import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../domain/config.js";
import { RunEngine } from "../engine/engine.js";
import { isStubDriver } from "../engine/stubs.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { FakeClock } from "../shared/clock.js";
import { openStore, type Store } from "../store/index.js";
import { Scheduler } from "../scheduler/index.js";
import { Git } from "../sandbox/git.js";
import { WorktreeSandbox } from "../sandbox/worktree.js";
import {
  PRODUCTION_DRIVER_PHASES,
  buildProductionDeps,
  installProductionDrivers,
  promoteEligibleTasksToReady,
} from "./composition.js";
import { createTaskFromRequirement } from "../domain/task.js";
import { id } from "../shared/ids.js";
import type { PhaseContext } from "../engine/types.js";

describe("production composition", () => {
  let dir: string;
  let store: Store;
  let clock: FakeClock;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polish-composition-"));
    store = openStore({ artifactsDir: join(dir, "artifacts") });
    clock = new FakeClock(1_700_000_000_000);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("installs non-stub drivers for DISCOVERING_PROJECT through CONVERGENCE_CHECK", () => {
    const provider = new ScriptedProvider("scripted", [
      { name: "worker", capabilities: FAKE_CAPABILITIES.frontier },
      { name: "planner", capabilities: FAKE_CAPABILITIES.strong },
      { name: "judge", capabilities: FAKE_CAPABILITIES.strong },
    ]);
    const config = defaultConfig();
    const sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: config.lanes, leaseMs: 60_000 });
    const engine = new RunEngine({ store, clock, scheduler: sched, config, assertProjectClean: () => undefined }, false);
    const deps = buildProductionDeps({
      store,
      clock,
      config,
      home: join(dir, "home"),
      providers: [provider],
      resolveSandbox: (ctx) => new WorktreeSandbox(ctx.run.projectPath, join(dir, "worktrees", ctx.run.id), config.sandbox),
    });
    installProductionDrivers(engine, deps);

    for (const phase of PRODUCTION_DRIVER_PHASES) {
      const driver = engine.getRegisteredDriver(phase);
      expect(driver, `missing driver for ${phase}`).toBeDefined();
      expect(isStubDriver(driver!), `${phase} must not use stubDriverFor`).toBe(false);
    }
  });

  it("promotes PENDING tasks with satisfied dependencies to READY", () => {
    const runId = id("run", clock.now());
    const interpretationId = id("interp", clock.now());
    const task = createTaskFromRequirement(interpretationId, "R1", {
      id: id("task", clock.now()),
      runId,
      title: "Fix bug",
      description: "WHAT: fix",
      kind: "bugfix",
      acceptance: ["tests pass"],
      complexity: "normal",
      baseCheckpointHash: "a".repeat(40),
      now: clock.now(),
    });
    store.events.append([
      {
        id: id("evt", clock.now()),
        runId,
        ts: clock.now(),
        type: "task.created",
        payload: { task },
        causedBy: [],
        actor: { kind: "supervisor", role: "council" },
        artifacts: [],
      },
    ]);
    const ctx = {
      run: {
        id: runId,
        missionId: id("msn", clock.now()),
        projectPath: "/repo",
        runBranch: "polish/run",
        phase: "PLANNING",
        control: "RUNNING",
        currentCheckpointHash: "a".repeat(40),
        baselineId: null,
        interpretationId,
        createdAt: clock.now(),
        updatedAt: clock.now(),
        terminalReason: null,
      },
      store,
      scheduler: new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 60_000 }),
      clock,
      config: defaultConfig(),
    } satisfies PhaseContext;
    promoteEligibleTasksToReady(ctx);
    const updated = store.repos.tasks.get(task.id)!;
    expect(updated.state).toBe("READY");
  });
});

describe("DISCOVERING_PROJECT and BASELINING drivers", () => {
  let dir: string;
  let repoDir: string;
  let store: Store;
  let clock: FakeClock;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "polish-discovery-"));
    repoDir = join(dir, "repo");
    mkdirSync(repoDir);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node -e \"process.exit(0)\"" } }));
    const git = await Git.init(repoDir);
    await git.commitAll("init");
    store = openStore({ artifactsDir: join(dir, "artifacts") });
    clock = new FakeClock(1_700_000_000_000);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists project.discovered and baseline.snapshotted", async () => {
    const provider = new ScriptedProvider("scripted", [{ name: "worker", capabilities: FAKE_CAPABILITIES.frontier }]);
    const config = defaultConfig();
    const sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: config.lanes, leaseMs: 60_000 });
    const engine = new RunEngine({ store, clock, scheduler: sched, config, assertProjectClean: () => undefined }, false);
    const deps = buildProductionDeps({
      store,
      clock,
      config,
      home: join(dir, "home"),
      providers: [provider],
      resolveSandbox: (ctx) => new WorktreeSandbox(ctx.run.projectPath, join(dir, "worktrees", ctx.run.id), config.sandbox),
    });
    installProductionDrivers(engine, deps);
    const run = engine.createRun({ projectPath: repoDir });
    const head = await new Git(repoDir).revParse("HEAD");
    engine.setCurrentCheckpoint(run.id, head);
    await engine.tickRun(run.id);
    await engine.tickRun(run.id);
    expect(store.events.list(run.id, { types: ["project.discovered"] })).toHaveLength(1);
    await engine.tickRun(run.id);
    expect(store.events.list(run.id, { types: ["baseline.snapshotted"] })).toHaveLength(1);
    expect(store.repos.baselines.listByRun(run.id)).toHaveLength(1);
  });
});
