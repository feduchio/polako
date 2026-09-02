import type { PolishConfig } from "../domain/config.js";
import type { Run, RunPhase } from "../domain/run.js";
import type { Scheduler } from "../scheduler/index.js";
import type { Clock } from "../shared/clock.js";
import type { Store } from "../store/index.js";

export interface PhaseContext {
  run: Run;
  store: Store;
  scheduler: Scheduler;
  clock: Clock;
  config: PolishConfig;
}

/** Result of one phase-driver invocation. */
export type PhaseDriverResult =
  | { status: "waiting" }
  | { status: "complete"; nextPhase: RunPhase };

export type PhaseDriver = (ctx: PhaseContext) => PhaseDriverResult | Promise<PhaseDriverResult>;

export interface EngineOptions {
  store: Store;
  clock: Clock;
  scheduler: Scheduler;
  config: PolishConfig;
}
