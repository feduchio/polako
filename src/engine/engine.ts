import { SYSTEM_ACTOR } from "../domain/common.js";
import type { NewEvent } from "../domain/event.js";
import {
  applyControlCommand,
  RUN_CONTROL_TABLE,
  RUN_PHASE_TABLE,
  transitionPhase,
  type ControlCommand,
  type Run,
  type RunPhase,
  type TerminalReason,
} from "../domain/run.js";
import { isTerminal } from "../domain/fsm.js";
import type { Scheduler } from "../scheduler/index.js";
import { assertRepositoryClean } from "../project/index.js";
import type { RepositoryStartPolicy } from "../project/index.js";
import type { Clock } from "../shared/clock.js";
import { PolishError } from "../shared/errors.js";
import { id } from "../shared/ids.js";
import type { Store } from "../store/index.js";
import {
  appendDueBudgetEvaluationBoundaries,
  enqueueBudgetDeadlineJob,
  registerBudgetEvaluateHandler,
} from "../convergence/pathology/deadline.js";
import { installStubDrivers } from "./stubs.js";
import type { EngineOptions, PhaseDriver } from "./types.js";

export type { EngineOptions, PhaseContext, PhaseDriver, PhaseDriverResult } from "./types.js";

export interface CreateRunInput extends RepositoryStartPolicy {
  projectPath: string;
  missionId?: string;
  runBranch?: string;
}

/**
 * Orchestrates run phase progression and the user control plane over the scheduler.
 * Phase business logic is pluggable via `registerPhase`; A5 installs stub drivers by default.
 */
export class RunEngine {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;
  private readonly config: EngineOptions["config"];
  private readonly resolveRunConfig: (run: Run) => EngineOptions["config"];
  private readonly assertProjectClean: (projectPath: string, policy?: RepositoryStartPolicy) => void;
  private readonly drivers = new Map<RunPhase, PhaseDriver>();
  private readonly driving = new Set<string>();

  constructor(options: EngineOptions, installStubs = true) {
    this.store = options.store;
    this.clock = options.clock;
    this.scheduler = options.scheduler;
    this.config = options.config;
    this.resolveRunConfig = options.resolveRunConfig ?? (() => this.config);
    this.assertProjectClean = options.assertProjectClean ?? assertRepositoryClean;
    registerBudgetEvaluateHandler(this.scheduler, this.store);
    if (installStubs) {
      installStubDrivers((phase, driver) => {
        this.registerPhase(phase, driver);
      });
    }
  }

  registerPhase(phase: RunPhase, driver: PhaseDriver): void {
    this.drivers.set(phase, driver);
  }

  /** Exposes a registered driver for composition tests (B9). */
  getRegisteredDriver(phase: RunPhase): PhaseDriver | undefined {
    return this.drivers.get(phase);
  }

  createRun(input: CreateRunInput): Run {
    if (input.includeDirty === true || input.syntheticSnapshotRef !== undefined) {
      throw new PolishError(
        "CONFIG_ERROR",
        "includeDirty and synthetic snapshots are unsupported in Phase A; a clean tree is required",
      );
    }
    this.assertProjectClean(input.projectPath);
    const now = this.clock.now();
    const runId = id("run", now);
    const missionId = input.missionId ?? id("msn", now);
    const run: Run = {
      id: runId,
      missionId,
      projectPath: input.projectPath,
      // Must not equal `polish/${runId}` — candidate worktrees use `polish/${runId}/candidates/…` branches.
      runBranch: input.runBranch ?? `polish/${runId}/run`,
      phase: "CREATED",
      control: "RUNNING",
      currentCheckpointHash: null,
      baselineId: null,
      interpretationId: null,
      createdAt: now,
      updatedAt: now,
      terminalReason: null,
    };
    this.append(run.id, "run.created", { run }, SYSTEM_ACTOR);
    enqueueBudgetDeadlineJob({ scheduler: this.scheduler, store: this.store, run, config: this.config });
    return run;
  }

  /** User control command. Returns the updated run projection. */
  control(runId: string, command: Exclude<ControlCommand, "quiesced" | "stopped">): Run {
    const run = this.requireRun(runId);
    if (isTerminal(RUN_CONTROL_TABLE, run.control) && command !== "kill") {
      return run;
    }
    // kill after STOPPED is a no-op (stays STOPPED)
    const next = applyControlCommand(run.control, command);
    if (next === run.control) return run;
    const updated: Run = {
      ...run,
      control: next,
      updatedAt: this.clock.now(),
      ...(command === "resume" && run.control === "STOPPED" && run.terminalReason?.code === "stopped_by_user"
        ? { terminalReason: null }
        : {}),
    };
    this.append(runId, "run.control_changed", { run: updated }, { kind: "user" });

    if (command === "kill" && next === "KILLED") {
      this.terminate(updated, { code: "killed_by_user", summary: "run killed by user" }, true);
    }

    // Immediate ack when nothing is in flight (including terminal-phase stop/pause).
    if ((next === "STOP_REQUESTED" || next === "PAUSE_REQUESTED") && this.scheduler.inFlightCount(runId) === 0) {
      this.acknowledgeControlSync(runId);
    }

    this.scheduler.tick();
    return this.requireRun(runId);
  }

  /**
   * Update `currentCheckpointHash` on the run (e.g. after integration). Prior clean rounds for
   * other hashes remain stored but are ignored by `hasConverged`.
   */
  setCurrentCheckpoint(runId: string, checkpointHash: string): Run {
    const run = this.requireRun(runId);
    const updated: Run = { ...run, currentCheckpointHash: checkpointHash, updatedAt: this.clock.now() };
    this.append(runId, "run.phase_changed", { run: updated }, SYSTEM_ACTOR);
    return updated;
  }

  /** Reclaim orphaned scheduler jobs; active runs continue from projections on the next tick. */
  recover(): void {
    this.scheduler.recover();
    appendDueBudgetEvaluationBoundaries({ store: this.store, clock: this.clock, config: this.config });
  }

  /**
   * One orchestration round: scheduler dispatch, then concurrent control ack + phase drive.
   * Pause/stop settle for one run must not gate sibling runs.
   */
  async tick(): Promise<void> {
    this.scheduler.tick();
    const settling = this.store.repos.runs
      .listAll()
      .filter(
        (r) =>
          (r.control === "PAUSE_REQUESTED" || r.control === "STOP_REQUESTED") &&
          isTerminal(RUN_PHASE_TABLE, r.phase),
      );
    // Terminal-phase pause/stop are not in listActive; ack them alongside active tickRuns.
    await Promise.all([
      ...settling.map((r) => this.acknowledgeControl(r.id)),
      ...this.store.repos.runs.listActive().map((r) => this.tickRun(r.id)),
    ]);
  }

  /** Drive a single run until its current phase driver waits or the run leaves the active set. */
  async tickRun(runId: string): Promise<void> {
    if (this.driving.has(runId)) return;
    this.driving.add(runId);
    try {
      await this.driveRun(runId);
    } finally {
      this.driving.delete(runId);
    }
  }

  private async driveRun(runId: string): Promise<void> {
    let run = this.store.repos.runs.get(runId);
    if (!run) throw new PolishError("NOT_FOUND", `run ${runId} not found`);
    if (isTerminal(RUN_CONTROL_TABLE, run.control)) return;

    // Only await settle for pause/stop — never for RUNNING (would starve sibling runs in tick).
    if (run.control === "PAUSE_REQUESTED" || run.control === "STOP_REQUESTED") {
      await this.acknowledgeControl(runId);
      run = this.requireRun(runId);
      if (isTerminal(RUN_CONTROL_TABLE, run.control)) return;
    }
    if (run.control !== "RUNNING") return;
    // Terminal phase: no further phase-driver work (control acks already handled above).
    if (isTerminal(RUN_PHASE_TABLE, run.phase)) return;

    const driver = this.drivers.get(run.phase);
    if (!driver) return;

    let result;
    try {
      result = await driver({
        run,
        store: this.store,
        scheduler: this.scheduler,
        clock: this.clock,
        config: this.resolveRunConfig(run),
      });
    } catch (err) {
      const phase = this.requireRun(runId).phase;
      const councilPhase = phase === "INTERPRETING_MISSION" || phase === "PLANNING";
      if (
        councilPhase ||
        (err instanceof PolishError && (err.code === "PROVIDERS_UNAVAILABLE" || err.code === "OUTPUT_CONTRACT"))
      ) {
        if (this.requireRun(runId).control === "RUNNING") this.control(runId, "pause");
      }
      if (err instanceof PolishError && (err.code === "PROVIDERS_UNAVAILABLE" || err.code === "OUTPUT_CONTRACT")) {
        return;
      }
      throw err;
    }
    this.scheduler.tick();
    if (result.status === "waiting") return;
    // Persist the advance immediately (event-sourced); leftover jobs may still finish.
    this.applyPhaseAdvance(runId, result.nextPhase, result.terminalReason);
  }

  private applyPhaseAdvance(runId: string, nextPhase: RunPhase, terminalReason?: TerminalReason): void {
    const run = this.requireRun(runId);
    if (isTerminal(RUN_CONTROL_TABLE, run.control) || run.control !== "RUNNING") return;
    if (isTerminal(RUN_PHASE_TABLE, run.phase)) return;
    const next = {
      ...transitionPhase(run, nextPhase, this.clock.now()),
      ...(terminalReason === undefined ? {} : { terminalReason }),
    };
    this.append(runId, "run.phase_changed", { run: next }, SYSTEM_ACTOR);
    if (nextPhase === "DONE") {
      this.terminate(next, { code: "converged", summary: "required clean rounds reached" });
    }
    if (nextPhase === "FAILED" && terminalReason !== undefined) {
      this.terminate(next, terminalReason);
    }
  }

  private async acknowledgeControl(runId: string): Promise<void> {
    await this.scheduler.settle(runId);
    this.acknowledgeControlSync(runId);
  }

  private acknowledgeControlSync(runId: string): void {
    const run = this.requireRun(runId);
    if (this.scheduler.inFlightCount(runId) > 0) return;

    if (run.control === "PAUSE_REQUESTED") {
      const paused = applyControlCommand(run.control, "quiesced");
      if (paused !== run.control) {
        this.append(runId, "run.control_changed", { run: { ...run, control: paused, updatedAt: this.clock.now() } }, SYSTEM_ACTOR);
      }
      return;
    }

    if (run.control === "STOP_REQUESTED") {
      const stopped = applyControlCommand(run.control, "stopped");
      if (stopped !== run.control) {
        const updated: Run = { ...run, control: stopped, updatedAt: this.clock.now() };
        this.append(runId, "run.control_changed", { run: updated }, SYSTEM_ACTOR);
        this.terminate(updated, { code: "stopped_by_user", summary: "run stopped by user" }, true);
      }
    }
  }

  /** Append `run.terminated`. `force` overwrites a prior reason (e.g. kill after converged). */
  private terminate(run: Run, reason: TerminalReason, force = false): void {
    if (run.terminalReason !== null && !force) return;
    // A terminal run must not leave persistent READY/PENDING jobs that can never dispatch,
    // or RUNNING work that outlives its owning run.
    this.scheduler.cancelRun(run.id, `run terminated: ${reason.code}`);
    const updated: Run = { ...run, terminalReason: reason, updatedAt: this.clock.now() };
    this.append(run.id, "run.terminated", { run: updated }, SYSTEM_ACTOR);
  }

  private requireRun(runId: string): Run {
    const run = this.store.repos.runs.get(runId);
    if (!run) throw new PolishError("NOT_FOUND", `run ${runId} not found`);
    return run;
  }

  private append(runId: string, type: string, payload: Record<string, unknown>, actor: NewEvent["actor"]): void {
    this.store.events.append([
      {
        id: id("evt", this.clock.now()),
        runId,
        ts: this.clock.now(),
        type,
        payload,
        causedBy: [],
        actor,
        artifacts: [],
      },
    ]);
  }
}
