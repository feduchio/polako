import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PolishConfig } from "../domain/config.js";
import type { PhaseDriver } from "../engine/types.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { Git } from "../sandbox/git.js";
import { FakeClock } from "../shared/clock.js";
import { DaemonService } from "./service.js";

const dirs: string[] = [];
const services: DaemonService[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) await service.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * B-selfhost-7: a run's `--runtime` mode must reach only that run. These drive the real
 * `handle("run", …)` entry point, because the defect lived in `createRun`.
 */
describe("B-selfhost-7 per-run runtime mode", () => {
  it("leaves the loaded config object untouched when runs request other modes", async () => {
    const fixture = await daemonFixture({ configuredMode: "off" });
    const observed = observeCreatedPhase(fixture.service);

    await fixture.createRun("required");
    await fixture.createRun("auto");

    expect(fixture.service.getConfig().runtimeValidation.mode).toBe("off");
    expect(observed.modes()).not.toContain("off");
  });

  it("keeps one config instance shared by getConfig and production composition", async () => {
    const fixture = await daemonFixture({ configuredMode: "off" });
    const before = fixture.service.getConfig();
    expect(before).toBe(fixture.service.productionComposition().config);

    observeCreatedPhase(fixture.service);
    await fixture.createRun("required");

    expect(fixture.service.getConfig()).toBe(before);
    expect(fixture.service.getConfig()).toBe(fixture.service.productionComposition().config);
  });

  /**
   * Replaces the source grep this file used to carry. A regex over `.runtimeValidation =` is
   * evaded by `config["runtimeValidation"].mode = x` and by `Object.assign`, so it never
   * established what it claimed. `withRuntimeValidationMode` copying unconditionally is what
   * makes the property true; the behavioural checks around this one are what observe it.
   */
  it("hands out a fresh config even when the run's mode equals the configured one", async () => {
    const fixture = await daemonFixture({ configuredMode: "auto" });
    const observed = observeCreatedPhase(fixture.service);

    const runId = await fixture.createRun("auto");

    const base = fixture.service.getConfig();
    const runConfig = observed.configFor(runId);
    expect(runConfig.runtimeValidation.mode).toBe("auto");
    expect(runConfig).not.toBe(base);
    expect(runConfig.runtimeValidation).not.toBe(base.runtimeValidation);
  });

  it("gives each run its own mode at the PhaseContext boundary", async () => {
    const fixture = await daemonFixture({ configuredMode: "off" });
    const observed = observeCreatedPhase(fixture.service);

    const quiet = await fixture.createRun("off");
    const strict = await fixture.createRun("required");

    // Creating `strict` ticks every active run, so `quiet` is driven again here.
    expect(observed.modesFor(quiet).length).toBeGreaterThan(1);
    expect(new Set(observed.modesFor(quiet))).toEqual(new Set(["off"]));
    expect(new Set(observed.modesFor(strict))).toEqual(new Set(["required"]));
  });

  it("isolates concurrent runs across an await boundary inside one engine tick", async () => {
    const fixture = await daemonFixture({ configuredMode: "off" });
    const before = new Map<string, string>();
    const after = new Map<string, string>();
    let armed = false;
    let arrived = 0;
    let release = (): void => undefined;
    const bothArrived = new Promise<void>((resolve) => {
      release = resolve;
    });

    const probe: PhaseDriver = async (ctx) => {
      if (!armed) return { status: "waiting" };
      before.set(ctx.run.id, ctx.config.runtimeValidation.mode);
      arrived += 1;
      if (arrived === 2) release();
      await bothArrived;
      after.set(ctx.run.id, ctx.config.runtimeValidation.mode);
      return { status: "waiting" };
    };
    fixture.service.engine.registerPhase("CREATED", probe);

    const quiet = await fixture.createRun("off");
    const strict = await fixture.createRun("required");

    armed = true;
    await fixture.service.engine.tick();

    expect(before.get(quiet)).toBe("off");
    expect(after.get(quiet)).toBe("off");
    expect(before.get(strict)).toBe("required");
    expect(after.get(strict)).toBe("required");
  });

  it("does not change an active run's mode when a later run is created", async () => {
    const fixture = await daemonFixture({ configuredMode: "off" });
    const observed = observeCreatedPhase(fixture.service);

    const first = await fixture.createRun("off");
    await fixture.service.engine.tick();
    await fixture.createRun("required");
    await fixture.service.engine.tick();

    expect(new Set(observed.modesFor(first))).toEqual(new Set(["off"]));
    expect(observed.modesFor(first).length).toBeGreaterThan(1);
  });

  it("derives a run config that differs from the loaded config only in the mode", async () => {
    const fixture = await daemonFixture({ configuredMode: "off", configuredLevel: "full" });
    const observed = observeCreatedPhase(fixture.service);

    const runId = await fixture.createRun("required");

    const runConfig = observed.configFor(runId);
    const base = fixture.service.getConfig();
    expect(runConfig.runtimeValidation).toEqual({ mode: "required", level: "full" });
    expect({ ...runConfig, runtimeValidation: base.runtimeValidation }).toEqual(base);
  });

  /**
   * Finding 17. An omitted `--runtime` used to become `"auto"` at two independent boundaries,
   * before anything could tell it had been omitted, so `polish.toml` could never take effect.
   */
  it("resolves an omitted runtime argument to the configured mode", async () => {
    const fixture = await daemonFixture({ configuredMode: "required" });
    const observed = observeCreatedPhase(fixture.service);

    const runId = await fixture.createRun(undefined);

    expect(observed.modesFor(runId)).toEqual(["required"]);
  });

  it("lets an explicit runtime argument override the configured mode", async () => {
    const fixture = await daemonFixture({ configuredMode: "required" });
    const observed = observeCreatedPhase(fixture.service);

    const runId = await fixture.createRun("off");

    expect(observed.modesFor(runId)).toEqual(["off"]);
    expect(fixture.service.getConfig().runtimeValidation.mode).toBe("required");
  });

  /**
   * A run's mode is a property of the run, resolved once at creation and persisted. Reading it
   * from the configuration on every resolution would move a run that is already going.
   */
  it("freezes an unspecified mode at creation, so editing polish.toml cannot move the run", async () => {
    const fixture = await daemonFixture({ configuredMode: "required" });
    observeCreatedPhase(fixture.service);
    const runId = await fixture.createRun(undefined);
    await fixture.service.close();
    services.splice(services.indexOf(fixture.service), 1);

    writeFileSync(join(fixture.home, "polish.toml"), `[runtimeValidation]\nmode = "off"\nlevel = "smoke"\n`);
    const restarted = new DaemonService({
      home: fixture.home,
      clock: new FakeClock(1_700_000_100_000),
      providers: [scriptedProvider()],
      tickMs: 1,
    });
    services.push(restarted);
    const observed = observeCreatedPhase(restarted);
    await restarted.engine.tick();

    expect(restarted.getConfig().runtimeValidation.mode).toBe("off");
    expect(observed.modesFor(runId)).toEqual(["required"]);
  });

  it("rejects an invalid runtime before creating a run or touching the config", async () => {
    const fixture = await daemonFixture({ configuredMode: "off" });

    await expect(fixture.createRun("sometimes")).rejects.toThrow(/runtime must be one of/);
    expect(fixture.service.getConfig().runtimeValidation.mode).toBe("off");
    await expect(fixture.service.handle("status", {})).resolves.toEqual([]);
  });

  it("resolves a run's mode on a tick that lands before its metadata is written", async () => {
    const fixture = await daemonFixture({ configuredMode: "off" });
    const observed = observeCreatedPhase(fixture.service);
    // `createRun` makes the run tickable, then awaits git before persisting metadata. Drive
    // the engine from inside that await, which is where a background timer tick would land.
    let tickedDuringCreate = false;
    // `…Once` so the nested call below dispatches to the real method, and `afterEach`
    // restores the prototype even if the tick throws.
    vi.spyOn(Git.prototype, "createBranch").mockImplementationOnce(async function (
      this: Git,
      ...args: Parameters<Git["createBranch"]>
    ) {
      tickedDuringCreate = true;
      await fixture.service.engine.tick();
      return this.createBranch(...args);
    });

    const runId = await fixture.createRun("required");

    expect(tickedDuringCreate).toBe(true);
    expect(observed.modesFor(runId).length).toBeGreaterThan(1);
    expect(new Set(observed.modesFor(runId))).toEqual(new Set(["required"]));
  });

  it("still resolves a run's own mode after a daemon restart", async () => {
    const fixture = await daemonFixture({ configuredMode: "off" });
    observeCreatedPhase(fixture.service);
    const runId = await fixture.createRun("required");

    await fixture.service.close();
    services.splice(services.indexOf(fixture.service), 1);

    const restarted = new DaemonService({
      home: fixture.home,
      clock: new FakeClock(1_700_000_100_000),
      providers: [scriptedProvider()],
      tickMs: 1,
    });
    services.push(restarted);
    const observed = observeCreatedPhase(restarted);
    await restarted.engine.tick();

    expect(observed.modesFor(runId)).toEqual(["required"]);
    expect(restarted.getConfig().runtimeValidation.mode).toBe("off");
  });
});

interface Observation {
  modes(): string[];
  modesFor(runId: string): string[];
  configFor(runId: string): PolishConfig;
}

/** Park every run in CREATED and record the config each tick hands it. */
function observeCreatedPhase(service: DaemonService): Observation {
  const seen: { runId: string; config: PolishConfig }[] = [];
  service.engine.registerPhase("CREATED", (ctx) => {
    seen.push({ runId: ctx.run.id, config: ctx.config });
    return { status: "waiting" };
  });
  return {
    modes: () => seen.map((entry) => entry.config.runtimeValidation.mode),
    modesFor: (runId) =>
      seen.filter((entry) => entry.runId === runId).map((entry) => entry.config.runtimeValidation.mode),
    configFor: (runId) => {
      const entry = seen.find((item) => item.runId === runId);
      if (entry === undefined) throw new Error(`no observation for ${runId}`);
      return entry.config;
    },
  };
}

function scriptedProvider(): ScriptedProvider {
  return new ScriptedProvider("scripted", [
    { name: "worker", capabilities: FAKE_CAPABILITIES.frontier },
    { name: "planner", capabilities: FAKE_CAPABILITIES.strong },
    { name: "judge", capabilities: FAKE_CAPABILITIES.strong },
  ]);
}

async function daemonFixture(options: {
  configuredMode: "auto" | "required" | "off";
  configuredLevel?: "smoke" | "affected" | "full";
}): Promise<{ service: DaemonService; home: string; createRun: (runtime: string | undefined) => Promise<string> }> {
  const dir = mkdtempSync(join(tmpdir(), "polish-b7-runtime-mode-"));
  dirs.push(dir);
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "b7-fixture", scripts: {} }));
  const git = await Git.init(repoDir);
  await git.commitAll("init");

  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "polish.toml"),
    `[runtimeValidation]\nmode = "${options.configuredMode}"\nlevel = "${options.configuredLevel ?? "smoke"}"\n`,
  );

  const service = new DaemonService({
    home,
    clock: new FakeClock(1_700_000_000_000),
    providers: [scriptedProvider()],
    tickMs: 1,
  });
  services.push(service);

  return {
    service,
    home,
    createRun: async (runtime) => {
      const run = (await service.handle("run", {
        project: repoDir,
        mission: "noop",
        ...(runtime === undefined ? {} : { runtime }),
      })) as { id: string };
      return run.id;
    },
  };
}

