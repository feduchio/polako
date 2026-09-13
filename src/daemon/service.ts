import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { withRuntimeValidationMode, type PolishConfig } from "../domain/config.js";
import { createMission } from "../domain/mission.js";
import type { NewEvent } from "../domain/event.js";
import type { Run } from "../domain/run.js";
import { RunEngine } from "../engine/index.js";
import type { ProviderAdapter } from "../broker/types.js";
import {
  buildFinalReportInput,
  buildNeedsHumanReportInput,
  renderFinalReport,
  renderNeedsHumanReport,
} from "../report/index.js";
import type { RuntimeCapabilityMode } from "../runtime/index.js";
import { Git } from "../sandbox/git.js";
import { Scheduler } from "../scheduler/index.js";
import { systemClock, type Clock } from "../shared/clock.js";
import { PolishError } from "../shared/errors.js";
import { id } from "../shared/ids.js";
import { openStore, type Store } from "../store/index.js";
import {
  renderReviewerBenchmark,
  runReviewerBenchmark,
  selectBenchmarkReviewers,
} from "../review/benchmarkRunner.js";
import { applyRunBranch } from "./apply.js";
import { loadPolishConfig } from "./configLoad.js";
import {
  applyRunBudgetOverrides,
  buildProductionDeps,
  hasNoRunBudget,
  type RunBudgetLimits,
  installProductionDrivers,
  parseRuntimeMode,
  type ProductionDeps,
} from "./composition.js";
import type { RpcHandler } from "./protocol.js";
import type { FacadeRunMetadata } from "./types.js";

export type { FacadeRunMetadata } from "./types.js";

interface ProjectRecord {
  name: string;
  path: string;
}

export interface DaemonServiceOptions {
  home: string;
  tickMs?: number;
  clock?: Clock;
  providers?: ProviderAdapter[];
  /** Override default convergence rounds (tests). */
  requiredCleanRounds?: number;
  /** Inject production deps for tests; otherwise built from home/store/clock/config. */
  productionDeps?: ProductionDeps;
}

export class DaemonService implements RpcHandler {
  readonly store: Store;
  readonly scheduler: Scheduler;
  readonly engine: RunEngine;
  readonly clock: Clock;
  private readonly home: string;
  private readonly tickMs: number;
  private readonly config: PolishConfig;
  private readonly productionDeps: ProductionDeps;
  /** Requested runtime mode per run; facade metadata is the durable source. */
  private readonly runtimeModes = new Map<string, RuntimeCapabilityMode>();
  /** Requested budget overrides per run; facade metadata is the durable source. */
  private readonly runBudgets = new Map<string, RunBudgetLimits>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(options: DaemonServiceOptions) {
    this.home = options.home;
    this.tickMs = options.tickMs ?? 50;
    this.clock = options.clock ?? systemClock;
    mkdirSync(this.home, { recursive: true });
    this.store = openStore({ home: this.home });
    this.config = loadPolishConfig(this.home);
    if (options.requiredCleanRounds !== undefined) {
      this.config.convergence.requiredCleanRounds = options.requiredCleanRounds;
    }
    this.scheduler = new Scheduler(this.store, this.clock, {
      workerId: `polishd-${process.pid}`,
      laneLimits: this.config.lanes,
      leaseMs: 60_000,
    });
    this.productionDeps = options.productionDeps ?? buildProductionDeps({
      store: this.store,
      clock: this.clock,
      config: this.config,
      home: this.home,
      resolveRunBudget: (runId) => this.runBudget(runId),
      ...(options.providers === undefined ? {} : { providers: options.providers }),
    });
    this.engine = new RunEngine({
      store: this.store,
      clock: this.clock,
      scheduler: this.scheduler,
      config: this.config,
      resolveRunConfig: (run) => this.runConfig(run.id),
    }, false);
    installProductionDrivers(this.engine, this.productionDeps);
    this.engine.recover();
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
    this.timer.unref();
  }

  /** Loaded polish.toml (or defaults when the file is absent). */
  getConfig(): PolishConfig {
    return this.config;
  }

  /** Production broker/catalog wiring for diagnostics and daemon-level tests. */
  productionComposition(): ProductionDeps {
    return this.productionDeps;
  }

  async close(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.scheduler.settle();
    this.store.close();
  }

  async handle(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "daemon.ping":
        return { pid: process.pid, home: this.home };
      case "project.add":
        return this.addProject(requiredString(params, "path"), optionalString(params, "name"));
      case "run":
        return this.createRun({
          project: requiredString(params, "project"),
          mission: optionalString(params, "mission") ?? "",
          runtime: optionalString(params, "runtime") ?? "auto",
          budgetTokens: optionalNumber(params, "budgetTokens"),
          budgetUsd: optionalNumber(params, "budgetUsd"),
        });
      case "status":
        return this.status(optionalString(params, "runId"));
      case "log":
        return this.log(requiredString(params, "runId"), optionalNumber(params, "afterSeq") ?? -1);
      case "diff":
        return this.diff(requiredString(params, "runId"));
      case "pause":
      case "resume":
      case "stop":
      case "kill":
        return this.control(requiredString(params, "runId"), method);
      case "answer":
        return this.answer(requiredString(params, "runId"), requiredString(params, "answer"));
      case "apply":
        return this.apply(requiredString(params, "runId"));
      case "benchmark.review":
        return this.runReviewBenchmark(
          optionalNumber(params, "seed") ?? 42,
          params["liveAbort"] === true,
        );
      default:
        throw new PolishError("NOT_FOUND", `unknown RPC method ${method}`);
    }
  }

  private async runReviewBenchmark(seed: number, liveAbort: boolean): Promise<unknown> {
    if (!Number.isInteger(seed)) throw new PolishError("INVALID_ARGUMENT", "benchmark seed must be an integer");
    const catalogs = await Promise.all(this.productionDeps.providers.map(async (provider) => ({
      provider,
      models: await provider.listModels(),
    })));
    const reviewers = selectBenchmarkReviewers(catalogs);
    const report = await runReviewerBenchmark({
      protocols: this.productionDeps.protocols,
      reviewers,
      seed,
      liveAbort,
    });
    const packet = this.store.artifacts.put(
      report.packetJsonl,
      "review_benchmark_packets",
      `review-benchmark:${String(seed)}:packets`,
      this.clock.now(),
    );
    const oracle = this.store.artifacts.put(
      report.oracleJsonl,
      "review_benchmark_oracle",
      `review-benchmark:${String(seed)}:oracle`,
      this.clock.now(),
    );
    const stored = {
      summary: renderReviewerBenchmark(report),
      report,
      artifacts: { packet, oracle },
    };
    const reportArtifact = this.store.artifacts.put(
      JSON.stringify(stored),
      "review_benchmark_report",
      `review-benchmark:${String(seed)}:report`,
      this.clock.now(),
    );
    return {
      summary: stored.summary,
      report,
      artifacts: { packet, oracle, report: reportArtifact },
    };
  }

  private async addProject(path: string, requestedName: string | undefined): Promise<ProjectRecord> {
    const git = new Git(resolve(path));
    if (!(await git.isRepo())) throw new PolishError("CONFIG_ERROR", `${path} is not a git repository`);
    const projectPath = await git.toplevel();
    const name = requestedName ?? basename(projectPath);
    const projects = this.readProjects().filter((project) => project.name !== name);
    const record = { name, path: projectPath };
    projects.push(record);
    writeFileSync(this.projectsPath(), `${JSON.stringify(projects, null, 2)}\n`);
    return record;
  }

  private async createRun(input: {
    project: string;
    mission: string;
    runtime: string;
    budgetTokens: number | undefined;
    budgetUsd: number | undefined;
  }): Promise<Run> {
    const runtime = parseRuntimeMode(input.runtime);
    if (input.budgetTokens !== undefined && (!Number.isInteger(input.budgetTokens) || input.budgetTokens < 1)) {
      throw new PolishError("CONFIG_ERROR", "budgetTokens must be a positive integer");
    }
    if (input.budgetUsd !== undefined && !(input.budgetUsd > 0)) {
      throw new PolishError("CONFIG_ERROR", "budgetUsd must be a positive number");
    }

    const project = this.resolveProject(input.project);
    const git = new Git(project.path);
    const [baselineCommit, targetBranch] = await Promise.all([
      git.revParse("HEAD"),
      git.out(["branch", "--show-current"]),
    ]);
    if (targetBranch === "") throw new PolishError("CONFLICT", "cannot start a run from detached HEAD");

    const run = this.engine.createRun({ projectPath: project.path });
    // Registered before anything can await: `createRun` makes the run tickable, and a timer
    // tick or model call landing before `writeMetadata` must still see this run's own settings.
    this.runtimeModes.set(run.id, runtime);
    this.runBudgets.set(run.id, {
      ...(input.budgetTokens === undefined ? {} : { budgetTokens: input.budgetTokens }),
      ...(input.budgetUsd === undefined ? {} : { budgetUsd: input.budgetUsd }),
    });
    const mission = createMission({
      id: run.missionId,
      projectPath: project.path,
      text: input.mission.trim() === "" ? "Improve the project according to repository context." : input.mission,
      createdAt: this.clock.now(),
    });
    const missionEvent: NewEvent = {
      id: id("evt", this.clock.now()),
      runId: run.id,
      ts: this.clock.now(),
      type: "mission.recorded",
      payload: { mission },
      causedBy: [],
      actor: { kind: "user" },
      artifacts: [],
    };
    this.store.events.append([missionEvent]);

    await git.createBranch(run.runBranch, baselineCommit);
    this.engine.setCurrentCheckpoint(run.id, baselineCommit);
    const runDir = this.runDir(run.id);
    mkdirSync(runDir, { recursive: true });

    const metadata: FacadeRunMetadata = {
      runId: run.id,
      projectPath: project.path,
      mission: input.mission,
      baselineCommit,
      targetBranch,
      runBranch: run.runBranch,
      reportPath: join(runDir, "report.md"),
      appliedAt: null,
      runtime,
      ...(input.budgetTokens === undefined ? {} : { budgetTokens: input.budgetTokens }),
      ...(input.budgetUsd === undefined ? {} : { budgetUsd: input.budgetUsd }),
    };
    this.writeMetadata(metadata);
    await this.tick();
    return this.requireRun(run.id);
  }

  private status(runId: string | undefined): Run | Run[] {
    return runId === undefined ? this.store.repos.runs.listAll() : this.requireRun(runId);
  }

  private log(runId: string, afterSeq: number): unknown[] {
    this.requireRun(runId);
    return this.store.events.list(runId, { afterSeq });
  }

  private async diff(runId: string): Promise<string> {
    const metadata = this.readMetadata(runId);
    return new Git(metadata.projectPath).diff(metadata.baselineCommit, metadata.runBranch);
  }

  private async control(runId: string, command: "pause" | "resume" | "stop" | "kill"): Promise<Run> {
    const run = this.engine.control(runId, command);
    await this.tick();
    return this.store.repos.runs.get(run.id) ?? run;
  }

  private answer(runId: string, answer: string): { accepted: true; runId: string; phase: "NEEDS_HUMAN" } {
    const run = this.requireRun(runId);
    if (run.phase !== "NEEDS_HUMAN") {
      throw new PolishError("CONFLICT", `run ${runId} is ${run.phase}, not NEEDS_HUMAN`);
    }
    appendFileSync(join(this.runDir(runId), "answers.jsonl"), `${JSON.stringify({ at: Date.now(), answer })}\n`);
    return { accepted: true, runId, phase: "NEEDS_HUMAN" };
  }

  private async apply(runId: string): Promise<{ branch: string; commit: string }> {
    const run = this.requireRun(runId);
    if (run.phase !== "DONE") throw new PolishError("CONFLICT", `run ${runId} is ${run.phase}, not DONE`);
    const metadata = this.readMetadata(runId);
    const result = await applyRunBranch({
      projectPath: metadata.projectPath,
      runBranch: metadata.runBranch,
      expectedTargetBranch: metadata.targetBranch,
    });
    this.writeMetadata({ ...metadata, appliedAt: Date.now() });
    return result;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.engine.tick();
      for (const run of this.store.repos.runs.listAll()) {
        if (
          run.phase === "DONE" ||
          run.phase === "NEEDS_HUMAN" ||
          run.phase === "FAILED" ||
          run.control === "STOPPED" ||
          run.control === "KILLED"
        ) {
          this.writeReport(run);
        }
      }
    } catch {
      // Phase drivers pause on unexpected failure. Do not let an unhandled rejection
      // clear the tick lock and silently re-enter INTERPRETING_MISSION.
    } finally {
      this.ticking = false;
    }
  }

  private writeReport(run: Run): void {
    const metadata = this.readMetadata(run.id);
    const generated = this.store.events.list(run.id, { types: ["report.generated"] }).at(-1);
    const artifact = generated?.artifacts[0];
    if (artifact !== undefined) {
      const body = this.store.artifacts.getText(artifact.sha256);
      writeFileSync(metadata.reportPath, body.endsWith("\n") ? body : `${body}\n`);
      return;
    }

    const ctx = { run, store: this.store, clock: this.clock, config: this.runConfig(run.id) };
    if (run.phase === "NEEDS_HUMAN") {
      const reason = run.terminalReason ?? {
        code: "product_decision_required" as const,
        summary: metadata.mission.trim() === "" ? "Human input is required to continue." : metadata.mission,
        question: "How should polish continue this mission?",
        options: ["Continue with the current plan", "Stop the run"],
      };
      writeFileSync(metadata.reportPath, `${renderNeedsHumanReport(buildNeedsHumanReportInput(reason))}\n`);
      return;
    }
    writeFileSync(metadata.reportPath, `${renderFinalReport(buildFinalReportInput(ctx))}\n`);
  }

  private resolveProject(reference: string): ProjectRecord {
    const configured = this.readProjects().find((project) => project.name === reference);
    if (configured !== undefined) return configured;
    const path = resolve(reference);
    if (!existsSync(path)) throw new PolishError("NOT_FOUND", `project ${reference} is not configured`);
    return { name: basename(path), path };
  }

  private requireRun(runId: string): Run {
    const run = this.store.repos.runs.get(runId);
    if (run === null) throw new PolishError("NOT_FOUND", `run ${runId} not found`);
    return run;
  }

  private readProjects(): ProjectRecord[] {
    if (!existsSync(this.projectsPath())) return [];
    return JSON.parse(readFileSync(this.projectsPath(), "utf8")) as ProjectRecord[];
  }

  private projectsPath(): string {
    return join(this.home, "projects.json");
  }

  /**
   * Per-run configuration for `resolveRunConfig`. The requested runtime mode is already
   * persisted in the run's facade metadata, so a run recovered after a daemon restart
   * still resolves its own mode instead of whatever the last run asked for.
   */
  private runConfig(runId: string): PolishConfig {
    let config = this.config;
    const mode = this.runtimeModes.get(runId) ?? this.persistedRuntimeMode(runId);
    if (mode !== null) {
      this.runtimeModes.set(runId, mode);
      config = withRuntimeValidationMode(config, mode);
    }
    const budget = this.runBudget(runId);
    if (!hasNoRunBudget(budget)) config = applyRunBudgetOverrides(config, budget);
    return config;
  }

  /** A run's own budget overrides, so C2 and the broker's tracker resolve the same numbers. */
  private runBudget(runId: string): RunBudgetLimits {
    const cached = this.runBudgets.get(runId);
    if (cached !== undefined) return cached;
    const persisted = this.persistedRunBudget(runId);
    if (persisted === null) return {};
    this.runBudgets.set(runId, persisted);
    return persisted;
  }

  private persistedRunBudget(runId: string): RunBudgetLimits | null {
    if (!existsSync(this.metadataPath(runId))) return null;
    try {
      const metadata = this.readMetadata(runId);
      const tokens = DaemonService.budgetOrUndefined(metadata.budgetTokens, true);
      const usd = DaemonService.budgetOrUndefined(metadata.budgetUsd, false);
      return {
        ...(tokens === undefined ? {} : { budgetTokens: tokens }),
        ...(usd === undefined ? {} : { budgetUsd: usd }),
      };
    } catch {
      return null;
    }
  }

  private persistedRuntimeMode(runId: string): RuntimeCapabilityMode | null {
    if (!existsSync(this.metadataPath(runId))) return null;
    try {
      const runtime = this.readMetadata(runId).runtime;
      return runtime === undefined ? null : parseRuntimeMode(runtime);
    } catch {
      return null;
    }
  }

  private runDir(runId: string): string {
    return join(this.home, "runs", runId);
  }

  private metadataPath(runId: string): string {
    return join(this.runDir(runId), "facade.json");
  }

  /**
   * Facade metadata is read back with an unchecked cast, so a corrupt budget must fall back to
   * the daemon-wide limit. Left as-is it would reach `assertWithin` as a NaN comparison, which
   * is always false: the run would end up with no cap at all.
   */
  private static budgetOrUndefined(value: unknown, integral: boolean): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
    return integral && !Number.isInteger(value) ? undefined : value;
  }

  private readMetadata(runId: string): FacadeRunMetadata {
    return JSON.parse(readFileSync(this.metadataPath(runId), "utf8")) as FacadeRunMetadata;
  }

  private writeMetadata(metadata: FacadeRunMetadata): void {
    mkdirSync(this.runDir(metadata.runId), { recursive: true });
    writeFileSync(this.metadataPath(metadata.runId), `${JSON.stringify(metadata, null, 2)}\n`);
  }
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value === "") throw new PolishError("CONFIG_ERROR", `${key} is required`);
  return value;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new PolishError("CONFIG_ERROR", `${key} must be a string`);
  return value;
}

function optionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PolishError("CONFIG_ERROR", `${key} must be a number`);
  }
  return value;
}
