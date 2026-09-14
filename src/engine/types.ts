import type { PolishConfig } from "../domain/config.js";
import type { Run, RunPhase, TerminalReason } from "../domain/run.js";
import type { RepositoryStartPolicy } from "../project/index.js";
import type { Scheduler } from "../scheduler/index.js";
import type { Clock } from "../shared/clock.js";
import type { Store } from "../store/index.js";

export interface PhaseContext {
  run: Run;
  store: Store;
  scheduler: Scheduler;
  clock: Clock;
  config: PolishConfig;
  /** Aborted when stop/kill interrupts the currently executing phase driver. */
  signal?: AbortSignal;
}

/** Result of one phase-driver invocation. */
export type PhaseDriverResult =
  | { status: "waiting" }
  | { status: "complete"; nextPhase: RunPhase; terminalReason?: TerminalReason };

export type PhaseDriver = (ctx: PhaseContext) => PhaseDriverResult | Promise<PhaseDriverResult>;

export interface EngineOptions {
  store: Store;
  clock: Clock;
  scheduler: Scheduler;
  config: PolishConfig;
  /**
   * Per-run view of `config` used to build each `PhaseContext`. Defaults to the shared
   * config. Runs are driven concurrently, so this must derive a new object rather than
   * mutate and restore the shared one.
   */
  resolveRunConfig?: (run: Run) => PolishConfig;
  /** Defaults to the Phase A clean-tree assertion; injectable for non-filesystem tests. */
  assertProjectClean?: (projectPath: string, policy?: RepositoryStartPolicy) => void;
}
