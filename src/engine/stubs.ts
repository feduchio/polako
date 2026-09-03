import { hasConverged } from "../domain/convergence.js";
import type { RunPhase } from "../domain/run.js";
import type { PhaseDriver, PhaseDriverResult } from "./types.js";

/**
 * Happy-path next phase for A5 stubs. CONVERGENCE_CHECK is handled separately
 * (needs clean-round count). Terminal phases have no outgoing edge here.
 */
export const STUB_NEXT: Partial<Record<RunPhase, RunPhase>> = {
  CREATED: "DISCOVERING_PROJECT",
  DISCOVERING_PROJECT: "BASELINING",
  BASELINING: "INTERPRETING_MISSION",
  INTERPRETING_MISSION: "DISCOVERING_MODELS",
  DISCOVERING_MODELS: "PLANNING",
  PLANNING: "EXECUTING",
  EXECUTING: "GATING",
  GATING: "COMPARING",
  COMPARING: "INTEGRATING",
  INTEGRATING: "REVIEWING",
  REVIEWING: "VALIDATING",
  VALIDATING: "CONVERGENCE_CHECK",
  SIMPLIFYING: "CONVERGENCE_CHECK",
};

const STUB_DRIVER_MARKER = Symbol("polish.stubDriver");

export function isStubDriver(driver: PhaseDriver): boolean {
  return (driver as { [STUB_DRIVER_MARKER]?: boolean })[STUB_DRIVER_MARKER] === true;
}

export function stubDriverFor(phase: RunPhase): PhaseDriver {
  const driver: PhaseDriver = (ctx): PhaseDriverResult => {
    if (phase === "CONVERGENCE_CHECK") {
      const hash = ctx.run.currentCheckpointHash;
      if (hash === null) return { status: "waiting" };
      const rounds = ctx.store.repos.cleanRounds.listByRun(ctx.run.id);
      if (hasConverged(rounds, hash, ctx.config.convergence.requiredCleanRounds)) {
        return { status: "complete", nextPhase: "DONE" };
      }
      return { status: "waiting" };
    }
    const next = STUB_NEXT[phase];
    if (next === undefined) return { status: "waiting" };
    return { status: "complete", nextPhase: next };
  };
  (driver as { [STUB_DRIVER_MARKER]?: boolean })[STUB_DRIVER_MARKER] = true;
  return driver;
}

export function installStubDrivers(register: (phase: RunPhase, driver: PhaseDriver) => void): void {
  for (const phase of Object.keys(STUB_NEXT) as RunPhase[]) {
    register(phase, stubDriverFor(phase));
  }
  register("CONVERGENCE_CHECK", stubDriverFor("CONVERGENCE_CHECK"));
}
