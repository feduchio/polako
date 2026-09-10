import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PolishConfig } from "../domain/config.js";
import type { PhaseDriver } from "../engine/types.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { Git } from "../sandbox/git.js";
import { FakeClock } from "../shared/clock.js";
import { DaemonService } from "./service.js";

const dirs: string[] = [];
const services: DaemonService[] = [];

afterEach(async () => {
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

  it("never assigns runtimeValidation anywhere in non-test source", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(new URL("../", import.meta.url).pathname)) {
      if (file.endsWith(".test.ts")) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        if (/\.runtimeValidation(\.\w+)?\s*=[^=]/.test(line)) offenders.push(`${file}:${index + 1}`);
      }
    }
    expect(offenders).toEqual([]);
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

  it("resolves an omitted runtime argument to auto rather than the configured mode", async () => {
    const fixture = await daemonFixture({ configuredMode: "off" });
    const observed = observeCreatedPhase(fixture.service);

    const runId = await fixture.createRun(undefined);

    expect(observed.modesFor(runId)).toEqual(["auto"]);
    expect(fixture.service.getConfig().runtimeValidation.mode).toBe("off");
  });

  it("rejects an invalid runtime before creating a run or touching the config", async () => {
    const fixture = await daemonFixture({ configuredMode: "off" });

    await expect(fixture.createRun("sometimes")).rejects.toThrow(/runtime must be one of/);
    expect(fixture.service.getConfig().runtimeValidation.mode).toBe("off");
    await expect(fixture.service.handle("status", {})).resolves.toEqual([]);
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

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}
