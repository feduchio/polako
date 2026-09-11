import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, withRuntimeValidationMode, type PolishConfig } from "../domain/config.js";
import type { Run } from "../domain/run.js";
import { Scheduler } from "../scheduler/index.js";
import { FakeClock } from "../shared/clock.js";
import { openStore, type Store } from "../store/index.js";
import { RunEngine } from "./engine.js";

const NOW = 1_700_000_000_000;

/**
 * B-selfhost-7: the engine seam that gives each run its own config. The daemon supplies the
 * resolver; here it is exercised directly, including the default that every other
 * `RunEngine` construction relies on.
 */
describe("RunEngine resolveRunConfig", () => {
  let dir: string;
  let store: Store;
  let clock: FakeClock;
  let sched: Scheduler;
  let base: PolishConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polish-run-config-"));
    store = openStore({ artifactsDir: join(dir, "artifacts") });
    clock = new FakeClock(NOW);
    sched = new Scheduler(store, clock, { workerId: "w1", laneLimits: defaultConfig().lanes, leaseMs: 60_000 });
    base = defaultConfig();
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function engineWith(resolveRunConfig?: (run: Run) => PolishConfig): RunEngine {
    return new RunEngine(
      {
        store,
        clock,
        scheduler: sched,
        config: base,
        assertProjectClean: () => undefined,
        ...(resolveRunConfig === undefined ? {} : { resolveRunConfig }),
      },
      false,
    );
  }

  it("hands drivers the shared config when no resolver is supplied", async () => {
    const engine = engineWith();
    const seen: PolishConfig[] = [];
    engine.registerPhase("CREATED", (ctx) => {
      seen.push(ctx.config);
      return { status: "waiting" };
    });

    const run = engine.createRun({ projectPath: dir });
    await engine.tickRun(run.id);

    expect(seen).toEqual([base]);
    expect(seen[0]).toBe(base);
  });

  it("asks the resolver for every run it drives and passes the result through", async () => {
    const asked: string[] = [];
    const engine = engineWith((run) => {
      asked.push(run.id);
      return withRuntimeValidationMode(base, run.id.endsWith("a") ? "required" : "off");
    });
    const seen = new Map<string, string>();
    engine.registerPhase("CREATED", (ctx) => {
      seen.set(ctx.run.id, ctx.config.runtimeValidation.mode);
      return { status: "waiting" };
    });

    const run = engine.createRun({ projectPath: dir });
    await engine.tickRun(run.id);

    expect(asked).toEqual([run.id]);
    expect(seen.get(run.id)).toBe(run.id.endsWith("a") ? "required" : "off");
    expect(base.runtimeValidation.mode).toBe(defaultConfig().runtimeValidation.mode);
  });

  it("resolves per drive rather than once per engine", async () => {
    let mode: "auto" | "required" | "off" = "off";
    const engine = engineWith(() => withRuntimeValidationMode(base, mode));
    const seen: string[] = [];
    engine.registerPhase("CREATED", (ctx) => {
      seen.push(ctx.config.runtimeValidation.mode);
      return { status: "waiting" };
    });

    const run = engine.createRun({ projectPath: dir });
    await engine.tickRun(run.id);
    mode = "required";
    await engine.tickRun(run.id);

    expect(seen).toEqual(["off", "required"]);
  });
});
