import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelCallRecord } from "../broker/broker.js";
import type { ProviderAdapter, CompletionRequest, CompletionResponse, ModelInfo, ProviderHealth } from "../broker/types.js";
import { isBudgetError } from "../broker/quota.js";
import type { PathologyBudgetSnapshot, PathologySample } from "../convergence/pathology/types.js";
import { id } from "../shared/ids.js";
import { FAKE_CAPABILITIES, ScriptedProvider } from "../providers/scripted.js";
import { Git } from "../sandbox/git.js";
import { FakeClock } from "../shared/clock.js";
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
 * B-selfhost-8: `--budget-tokens` / `--budget-usd` were validated, persisted and ignored.
 * Enforcement lives in `BudgetTracker.assertWithin`, reached only through a real broker
 * call, so these drive `handle("run", …)` and then `broker.complete(...)`.
 */
describe("B-selfhost-8 per-run budget overrides", () => {
  it("binds a token override that the loaded configuration would have allowed", async () => {
    const fixture = await daemonFixture({ maxRunTokens: null });
    const runId = await fixture.createRun({ budgetTokens: 30 });

    await callTimes(fixture, runId, 3);
    const error = await budgetErrorOf(fixture.call(runId));
    expect(error.details).toMatchObject({ budget: "run_tokens", limit: 30 });
  });

  it("binds a USD override on priced calls", async () => {
    const fixture = await daemonFixture({ maxRunUsd: null, costUsd: 0.5 });
    const runId = await fixture.createRun({ budgetUsd: 1.25 });

    await callTimes(fixture, runId, 3);
    const error = await budgetErrorOf(fixture.call(runId));
    expect(error.details).toMatchObject({ budget: "run_usd", limit: 1.25 });
  });

  it("enforces both flags on one run, each at its own threshold", async () => {
    const fixture = await daemonFixture({ maxRunTokens: null, maxRunUsd: null, costUsd: 0.5 });
    const tokenBound = await fixture.createRun({ budgetTokens: 30, budgetUsd: 1000 });
    const usdBound = await fixture.createRun({ budgetTokens: 1_000_000, budgetUsd: 1 });

    await callTimes(fixture, tokenBound, 3);
    expect((await budgetErrorOf(fixture.call(tokenBound))).details).toMatchObject({ budget: "run_tokens", limit: 30 });

    await callTimes(fixture, usdBound, 2);
    expect((await budgetErrorOf(fixture.call(usdBound))).details).toMatchObject({ budget: "run_usd", limit: 1 });
  });

  it("does not leak an override onto a run created earlier", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 50 });
    const earlier = await fixture.createRun({});
    await fixture.createRun({ budgetTokens: 20 });

    await callTimes(fixture, earlier, 5);
    expect((await budgetErrorOf(fixture.call(earlier))).details).toMatchObject({ limit: 50 });
  });

  it("does not leak an override onto a run created later", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 50 });
    await fixture.createRun({ budgetTokens: 20 });
    const later = await fixture.createRun({});

    await callTimes(fixture, later, 5);
    expect((await budgetErrorOf(fixture.call(later))).details).toMatchObject({ limit: 50 });
  });

  it("keeps each run on its own limit while another run's call is in flight", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 50 });
    const parked = await fixture.createRun({ budgetTokens: 100 });
    const small = await fixture.createRun({ budgetTokens: 20 });

    await callTimes(fixture, small, 2);
    fixture.gate.parkRun(parked);
    const inFlight = fixture.call(parked);
    await fixture.gate.arrived;

    // `parked` is suspended inside the provider, past its own assertWithin.
    expect((await budgetErrorOf(fixture.call(small))).details).toMatchObject({ limit: 20 });
    const third = await fixture.createRun({ budgetTokens: 30 });
    await callTimes(fixture, third, 3);
    expect((await budgetErrorOf(fixture.call(third))).details).toMatchObject({ limit: 30 });

    fixture.gate.release();
    await expect(inFlight).resolves.toBeDefined();
    await callTimes(fixture, parked, 9);
    expect((await budgetErrorOf(fixture.call(parked))).details).toMatchObject({ limit: 100 });
  });

  it("leaves the daemon-wide limits in force for later runs without overrides", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 50 });
    const overridden = await fixture.createRun({ budgetTokens: 20 });
    await callTimes(fixture, overridden, 2);
    await budgetErrorOf(fixture.call(overridden));

    expect(fixture.service.getConfig().budget).toEqual({
      maxRunUsd: null,
      maxRunTokens: 50,
      maxTaskTokens: null,
      maxRunWallClockMinutes: null,
    });
    const plain = await fixture.createRun({});
    await callTimes(fixture, plain, 5);
    expect((await budgetErrorOf(fixture.call(plain))).details).toMatchObject({ limit: 50 });
  });

  it("never assigns a budget or limits field in non-test source", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(fileURLToPath(new URL("../", import.meta.url)))) {
      if (file.endsWith(".test.ts")) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        if (/\.(budget|limits)(\.\w+)?\s*=(?!=)/.test(line)) offenders.push(`${file}:${index + 1}`);
      }
    }
    expect(offenders).toEqual([]);
    const quota = readFileSync(fileURLToPath(new URL("../broker/quota.ts", import.meta.url)), "utf8");
    expect(quota).toContain("private readonly limits: BudgetLimits");
  });

  it("treats a null configured limit as unlimited when a run has no override", async () => {
    const fixture = await daemonFixture({ maxRunTokens: null });
    const runId = await fixture.createRun({});
    for (let i = 0; i < 40; i += 1) await expect(fixture.call(runId)).resolves.toBeDefined();
  });

  it("lets an override raise a finite configured cap", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 50 });
    const raised = await fixture.createRun({ budgetTokens: 100 });
    const plain = await fixture.createRun({});

    // Past the configured cap and still running: the override raised it, it did not clamp.
    await callTimes(fixture, raised, 6);
    await callTimes(fixture, plain, 5);
    expect((await budgetErrorOf(fixture.call(plain))).details).toMatchObject({ limit: 50 });

    await callTimes(fixture, raised, 4);
    expect((await budgetErrorOf(fixture.call(raised))).details).toMatchObject({ limit: 100 });
  });

  it("keeps the configured per-task cap for a run that overrides run tokens", async () => {
    const fixture = await daemonFixture({ maxRunTokens: null, maxTaskTokens: 30 });
    const runId = await fixture.createRun({ budgetTokens: 1_000_000 });

    await callTimes(fixture, runId, 3, "task_1");
    const error = await budgetErrorOf(fixture.call(runId, "task_1"));
    expect(error.details).toMatchObject({ budget: "task_tokens", limit: 30 });
  });

  it("rejects invalid budgets before a run exists and leaves no residue", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 50 });

    for (const budgetTokens of [0, -1, 1.5]) {
      await expect(fixture.createRun({ budgetTokens })).rejects.toThrow(/budgetTokens must be a positive integer/);
    }
    for (const budgetUsd of [0, -1]) {
      await expect(fixture.createRun({ budgetUsd })).rejects.toThrow(/budgetUsd must be a positive number/);
    }

    await expect(fixture.service.handle("status", {})).resolves.toEqual([]);
    expect(fixture.service.getConfig().budget.maxRunTokens).toBe(50);
    const runId = await fixture.createRun({});
    await callTimes(fixture, runId, 5);
    expect((await budgetErrorOf(fixture.call(runId))).details).toMatchObject({ limit: 50 });
  });

  it("still enforces each run's own override after a daemon restart", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 50 });
    const tight = await fixture.createRun({ budgetTokens: 1 });
    const loose = await fixture.createRun({ budgetTokens: 10_000 });
    await fixture.service.close();
    services.splice(services.indexOf(fixture.service), 1);

    // Both touch orders, each over its own restart: a resolver keyed by anything but the run,
    // or one caching the last override it saw, survives only one of the two.
    for (const looseFirst of [true, false]) {
      const restarted = fixture.restart();
      if (looseFirst) await callTimes(restarted, loose, 8);
      await callTimes(restarted, tight, 1);
      expect((await budgetErrorOf(restarted.call(tight))).details).toMatchObject({ limit: 1 });
      if (!looseFirst) await callTimes(restarted, loose, 8);
      await expect(restarted.call(loose)).resolves.toBeDefined();
      await restarted.service.close();
      services.splice(services.indexOf(restarted.service), 1);
    }
  });

  it("has the override in force on a tick that lands before metadata is written", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 50 });
    const observed: number[] = [];
    fixture.service.engine.registerPhase("CREATED", (ctx) => {
      observed.push(ctx.config.budget.maxRunTokens ?? -1);
      return { status: "waiting" };
    });
    let ticked = false;
    vi.spyOn(Git.prototype, "createBranch").mockImplementationOnce(async function (
      this: Git,
      ...args: Parameters<Git["createBranch"]>
    ) {
      ticked = true;
      await fixture.service.engine.tick();
      return this.createBranch(...args);
    });

    await fixture.createRun({ budgetTokens: 20 });

    expect(ticked).toBe(true);
    expect(observed.length).toBeGreaterThan(0);
    expect(new Set(observed)).toEqual(new Set([20]));
  });

  it("reports the same limits to C2 that the broker enforces, and records them as applied", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 50 });
    const overridden = await fixture.createRun({ budgetTokens: 30 });
    const plain = await fixture.createRun({});
    // USD-only: pins the USD half of the agreement, and pins that a partial override leaves
    // the other dimension at its configured value rather than clearing it.
    const usdOnly = await fixture.createRun({ budgetUsd: 2 });

    await driveToConvergence(fixture, overridden);
    await driveToConvergence(fixture, plain);
    await driveToConvergence(fixture, usdOnly);

    // Every dimension, not a subset: MC5 makes only two of the four overridable, and C2 decides
    // exhaustion from all of them, so a widened override would be a decision defect here.
    const overriddenBudget = persistedSampleBudget(fixture, overridden);
    expect(overriddenBudget.limits).toEqual({ maxRunTokens: 30, maxRunUsd: null, maxTaskTokens: null, maxRunWallClockMinutes: null });
    expect(overriddenBudget.unusedCliMetadata).toEqual({ budgetTokens: 30, budgetUsd: null, applied: true });

    const plainBudget = persistedSampleBudget(fixture, plain);
    expect(plainBudget.limits).toEqual({ maxRunTokens: 50, maxRunUsd: null, maxTaskTokens: null, maxRunWallClockMinutes: null });
    expect(plainBudget.unusedCliMetadata).toEqual({ budgetTokens: null, budgetUsd: null, applied: false });

    const usdOnlyBudget = persistedSampleBudget(fixture, usdOnly);
    expect(usdOnlyBudget.limits).toEqual({ maxRunUsd: 2, maxRunTokens: 50, maxTaskTokens: null, maxRunWallClockMinutes: null });
    expect(usdOnlyBudget.unusedCliMetadata).toEqual({ budgetTokens: null, budgetUsd: 2, applied: true });
  });

  it("carries a fractional USD budget across a restart", async () => {
    // The persisted-budget guard must not demand an integer here: USD budgets are not, and
    // rejecting one downgrades a valid run to the daemon-wide limit without saying so.
    const fixture = await daemonFixture({ maxRunUsd: null, costUsd: 0.5 });
    const runId = await fixture.createRun({ budgetUsd: 1.25 });
    await fixture.service.close();
    services.splice(services.indexOf(fixture.service), 1);

    const restarted = fixture.restart();
    await callTimes(restarted, runId, 3);
    expect((await budgetErrorOf(restarted.call(runId))).details).toMatchObject({ budget: "run_usd", limit: 1.25 });
  });

  it("falls back to the daemon-wide limit when a run's persisted budget is corrupt", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 50 });
    const corrupt = await fixture.createRun({ budgetTokens: 10_000 });
    await fixture.service.close();
    services.splice(services.indexOf(fixture.service), 1);

    const facade = join(fixture.home, "runs", corrupt, "facade.json");
    const metadata = JSON.parse(readFileSync(facade, "utf8")) as Record<string, unknown>;
    expect(metadata["budgetTokens"]).toBe(10_000);

    // "lots" reaches the guard as a NaN comparison and never fires, so the run would carry no
    // cap at all; the rest would bind a nonsense cap of their own. Every one must give way to
    // the daemon's, and none of these can be written by `handle("run", …)` in the first place.
    for (const budgetTokens of ["lots", 0, -5, 1.5, null]) {
      writeFileSync(facade, JSON.stringify({ ...metadata, budgetTokens }));
      const restarted = fixture.restart();
      await callTimes(restarted, corrupt, 5);
      expect((await budgetErrorOf(restarted.call(corrupt))).details).toMatchObject({ limit: 50 });
      await restarted.service.close();
      services.splice(services.indexOf(restarted.service), 1);
    }

    // Unreadable, not merely wrong: the fallback must survive a file that does not parse.
    writeFileSync(facade, "{ not json");
    const restarted = fixture.restart();
    await callTimes(restarted, corrupt, 5);
    expect((await budgetErrorOf(restarted.call(corrupt))).details).toMatchObject({ limit: 50 });
  });

  it("leaves the loaded config instance shared and untouched", async () => {
    const fixture = await daemonFixture({ maxRunTokens: 50 });
    const before = fixture.service.getConfig();
    const runId = await fixture.createRun({ budgetTokens: 20 });
    await fixture.call(runId);

    expect(fixture.service.getConfig()).toBe(before);
    expect(fixture.service.getConfig()).toBe(fixture.service.productionComposition().config);
    expect(before.budget.maxRunTokens).toBe(50);
  });
});

interface Fixture {
  service: DaemonService;
  home: string;
  repoDir: string;
  gate: Gate;
  createRun: (budget: { budgetTokens?: number; budgetUsd?: number }) => Promise<string>;
  call: (runId: string, taskId?: string) => Promise<ModelCallRecord>;
  restart: () => Fixture;
}

interface Gate {
  parkRun: (runId: string) => void;
  arrived: Promise<void>;
  release: () => void;
}

/**
 * Puts a real daemon run into CONVERGENCE_CHECK with an observation boundary, then drives the
 * engine so the sample comes from the registered production driver rather than a hand-built one.
 */
async function driveToConvergence(fixture: Fixture, runId: string): Promise<void> {
  const store = fixture.service.productionComposition().store;
  const now = fixture.service.productionComposition().clock.now();
  const run = store.repos.runs.get(runId)!;
  const system = { kind: "system" as const };
  // No coding tasks, so the anti-fake DONE gate passes and the driver reaches the sample;
  // no clean rounds, so it does not short-circuit to DONE either.
  store.events.append([
    {
      id: id("evt", now + 4),
      runId,
      ts: now + 4,
      type: "run.phase_changed",
      payload: { run: { ...run, phase: "CONVERGENCE_CHECK", updatedAt: now + 4 } },
      causedBy: [],
      actor: system,
      artifacts: [],
    },
    {
      id: id("evt", now + 5),
      runId,
      ts: now + 5,
      type: "budget.evaluated",
      payload: { kind: "wall_clock", dueAt: now, observedAt: now + 5 },
      causedBy: [],
      actor: system,
      artifacts: [],
    },
  ]);
  await fixture.service.engine.tickRun(runId);
}

function persistedSampleBudget(fixture: Fixture, runId: string): PathologyBudgetSnapshot {
  const events = fixture.service.productionComposition().store.events.list(runId, { types: ["pathology.sample"] });
  expect(events.length).toBeGreaterThan(0);
  return (events.at(-1)!.payload["sample"] as PathologySample).budget;
}

/** Each scripted call costs 10 tokens, so a threshold is always a whole number of calls. */
async function callTimes(fixture: Fixture, runId: string, times: number, taskId?: string): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await expect(fixture.call(runId, taskId)).resolves.toBeDefined();
  }
}

async function budgetErrorOf(promise: Promise<unknown>): Promise<PolishError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PolishError && isBudgetError(error)) return error;
    throw error;
  }
  throw new Error("expected a budget error");
}

/** Delegates to a scripted provider, but can suspend one run's call inside `complete`. */
class GatedProvider implements ProviderAdapter {
  readonly id: string;
  readonly kind = "scripted";
  readonly concurrency = null;
  private parkedRunId: string | null = null;
  private announce: () => void = () => undefined;
  private open: () => void = () => undefined;
  readonly arrived: Promise<void>;
  private readonly released: Promise<void>;

  constructor(private readonly inner: ScriptedProvider) {
    this.id = inner.id;
    this.arrived = new Promise<void>((resolve) => {
      this.announce = resolve;
    });
    this.released = new Promise<void>((resolve) => {
      this.open = resolve;
    });
  }

  gate(): Gate {
    return {
      parkRun: (runId) => {
        this.parkedRunId = runId;
      },
      arrived: this.arrived,
      release: () => {
        this.open();
      },
    };
  }

  listModels(): Promise<ModelInfo[]> {
    return this.inner.listModels();
  }

  health(): Promise<ProviderHealth> {
    return this.inner.health();
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (this.parkedRunId === request.metadata.runId) {
      this.parkedRunId = null;
      this.announce();
      await this.released;
    }
    return this.inner.complete(request);
  }
}

async function daemonFixture(options: {
  maxRunTokens?: number | null;
  maxRunUsd?: number | null;
  maxTaskTokens?: number | null;
  costUsd?: number;
}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "polish-b8-budget-"));
  dirs.push(dir);
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "b8-fixture", scripts: {} }));
  const git = await Git.init(repoDir);
  await git.commitAll("init");

  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const limits = [
    options.maxRunTokens === undefined || options.maxRunTokens === null ? [] : [`maxRunTokens = ${options.maxRunTokens}`],
    options.maxRunUsd === undefined || options.maxRunUsd === null ? [] : [`maxRunUsd = ${options.maxRunUsd}`],
    options.maxTaskTokens === undefined || options.maxTaskTokens === null ? [] : [`maxTaskTokens = ${options.maxTaskTokens}`],
  ].flat();
  writeFileSync(join(home, "polish.toml"), `[budget]\n${limits.join("\n")}\n`);

  return buildFixture(dir, home, repoDir, options.costUsd ?? null);
}

function buildFixture(dir: string, home: string, repoDir: string, costUsd: number | null): Fixture {
  const scripted = new ScriptedProvider(
    "scripted",
    [
      { name: "worker", capabilities: FAKE_CAPABILITIES.frontier },
      { name: "planner", capabilities: FAKE_CAPABILITIES.strong },
    ],
    // 10 tokens per call keeps every threshold in the tests a whole number of calls.
    { fallback: { kind: "reply", content: "ok", usage: { inputTokens: 10, outputTokens: 0, costUsd } } },
  );
  const provider = new GatedProvider(scripted);
  const service = new DaemonService({
    home,
    clock: new FakeClock(1_700_000_000_000),
    providers: [provider],
    tickMs: 1,
  });
  services.push(service);

  const fixture: Fixture = {
    service,
    home,
    repoDir,
    gate: provider.gate(),
    createRun: async (budget) => {
      const run = (await service.handle("run", { project: repoDir, mission: "noop", runtime: "off", ...budget })) as { id: string };
      return run.id;
    },
    call: (runId, taskId) =>
      service.productionComposition().broker.complete({
        model: { provider: "scripted", model: "worker" },
        messages: [{ role: "user", content: "hello" }],
        metadata: { runId, purpose: "test", role: "worker", ...(taskId === undefined ? {} : { taskId }) },
      }),
    restart: () => buildFixture(dir, home, repoDir, costUsd),
  };
  return fixture;
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
