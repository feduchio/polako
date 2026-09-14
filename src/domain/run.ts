import { z } from "zod";
import type { TransitionTable } from "./fsm.js";
import { assertTransition, canTransition } from "./fsm.js";
import { GitHashSchema, IdSchema, TimestampSchema } from "./common.js";

/**
 * Axis 1: where the pipeline is.
 */
export const RunPhaseSchema = z.enum([
  "CREATED",
  "DISCOVERING_PROJECT",
  "BASELINING",
  "INTERPRETING_MISSION",
  "DISCOVERING_MODELS",
  "PLANNING",
  "EXECUTING",
  "GATING",
  "COMPARING",
  "INTEGRATING",
  "REVIEWING",
  "VALIDATING",
  "CONVERGENCE_CHECK",
  "SIMPLIFYING",
  "DONE",
  "NEEDS_HUMAN",
  "FAILED",
]);
export type RunPhase = z.infer<typeof RunPhaseSchema>;

export const RUN_PHASE_TABLE: TransitionTable<RunPhase> = {
  initial: "CREATED",
  states: RunPhaseSchema.options,
  terminal: ["DONE", "NEEDS_HUMAN", "FAILED"],
  edges: {
    CREATED: ["DISCOVERING_PROJECT", "FAILED"],
    DISCOVERING_PROJECT: ["BASELINING", "NEEDS_HUMAN", "FAILED"],
    BASELINING: ["INTERPRETING_MISSION", "NEEDS_HUMAN", "FAILED"],
    INTERPRETING_MISSION: ["DISCOVERING_MODELS", "NEEDS_HUMAN", "FAILED"],
    DISCOVERING_MODELS: ["PLANNING", "NEEDS_HUMAN", "FAILED"],
    PLANNING: ["EXECUTING", "REVIEWING", "CONVERGENCE_CHECK", "NEEDS_HUMAN", "FAILED"],
    EXECUTING: ["GATING", "PLANNING", "NEEDS_HUMAN", "FAILED"],
    GATING: ["COMPARING", "PLANNING", "FAILED"],
    COMPARING: ["INTEGRATING", "PLANNING", "NEEDS_HUMAN", "FAILED"],
    INTEGRATING: ["REVIEWING", "PLANNING", "FAILED"],
    REVIEWING: ["VALIDATING", "FAILED"],
    VALIDATING: ["PLANNING", "CONVERGENCE_CHECK", "NEEDS_HUMAN", "FAILED"],
    CONVERGENCE_CHECK: ["REVIEWING", "SIMPLIFYING", "PLANNING", "DONE", "NEEDS_HUMAN", "FAILED"],
    /**
     * SIMPLIFYING only *plans* `simplify` tasks. Any code change then goes through the normal
     * EXECUTING -> GATING -> COMPARING -> INTEGRATING pipeline. If nothing worth simplifying
     * is found, no task ran and no code changed, so returning to CONVERGENCE_CHECK is sound.
     */
    SIMPLIFYING: ["EXECUTING", "CONVERGENCE_CHECK", "NEEDS_HUMAN", "FAILED"],
    DONE: [],
    NEEDS_HUMAN: [],
    FAILED: [],
  },
};

/**
 * The only phase during which code on the run branch may change (new checkpoint, including
 * rollback checkpoints, which are performed on the integration lane).
 */
export const CODE_CHANGING_PHASES: readonly RunPhase[] = ["INTEGRATING"];

/**
 * Phases from which REVIEWING may be entered. Never from COMPARING/GATING/EXECUTING: a winning
 * candidate must be integrated (and pass integration gates) before any reviewer sees it.
 * PLANNING -> REVIEWING covers missions with no coding requirements ("review and polish");
 * CONVERGENCE_CHECK -> REVIEWING starts the next clean round on an unchanged checkpoint.
 */
export const REVIEW_ENTRY_PHASES: readonly RunPhase[] = ["INTEGRATING", "PLANNING", "CONVERGENCE_CHECK"];

/**
 * Axis 2: user control. Orthogonal to phase — any command is valid from any phase.
 */
export const RunControlSchema = z.enum(["RUNNING", "PAUSE_REQUESTED", "PAUSED", "STOP_REQUESTED", "STOPPED", "KILLED"]);
export type RunControl = z.infer<typeof RunControlSchema>;

export const ControlCommandSchema = z.enum(["pause", "resume", "stop", "kill", "quiesced", "stopped"]);
export type ControlCommand = z.infer<typeof ControlCommandSchema>;

/**
 * `quiesced` and `stopped` are internal acknowledgements from the scheduler
 * (all in-flight jobs finished / cancelled), not user commands.
 */
export function applyControlCommand(current: RunControl, command: ControlCommand): RunControl {
  switch (command) {
    case "kill":
      return current === "STOPPED" ? current : "KILLED";
    case "stop":
      return current === "STOPPED" || current === "KILLED" ? current : "STOP_REQUESTED";
    case "pause":
      if (current === "RUNNING") return "PAUSE_REQUESTED";
      return current;
    case "resume":
      if (current === "PAUSED" || current === "PAUSE_REQUESTED" || current === "STOPPED") return "RUNNING";
      return current;
    case "quiesced":
      if (current === "PAUSE_REQUESTED") return "PAUSED";
      return current;
    case "stopped":
      if (current === "STOP_REQUESTED") return "STOPPED";
      return current;
  }
}

export const RUN_CONTROL_TABLE: TransitionTable<RunControl> = {
  initial: "RUNNING",
  states: RunControlSchema.options,
  terminal: ["KILLED"],
  edges: {
    RUNNING: ["PAUSE_REQUESTED", "STOP_REQUESTED", "KILLED"],
    PAUSE_REQUESTED: ["PAUSED", "RUNNING", "STOP_REQUESTED", "KILLED"],
    PAUSED: ["RUNNING", "STOP_REQUESTED", "KILLED"],
    STOP_REQUESTED: ["STOPPED", "KILLED"],
    STOPPED: ["RUNNING"],
    KILLED: [],
  },
};

/** The scheduler may hand out new jobs only in this control state. */
export function mayDispatchJobs(control: RunControl): boolean {
  return control === "RUNNING";
}

/** In-flight jobs must be cancelled (not merely drained) in these control states. */
export function mustCancelInFlight(control: RunControl): boolean {
  return control === "STOP_REQUESTED" || control === "STOPPED" || control === "KILLED";
}

export const TerminalReasonSchema = z.object({
  code: z.enum([
    "converged",
    "stopped_by_user",
    "killed_by_user",
    "ambiguous_intent",
    "product_decision_required",
    "repeated_failure",
    "pathology_detected",
    "budget_exhausted",
    "providers_unavailable",
    "internal_error",
  ]),
  summary: z.string(),
  question: z.string().optional(),
  options: z.array(z.string()).optional(),
});
export type TerminalReason = z.infer<typeof TerminalReasonSchema>;

export const RunSchema = z.object({
  id: IdSchema,
  missionId: IdSchema,
  projectPath: z.string().min(1),
  runBranch: z.string().min(1),
  phase: RunPhaseSchema,
  control: RunControlSchema,
  currentCheckpointHash: GitHashSchema.nullable(),
  baselineId: IdSchema.nullable(),
  interpretationId: IdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  terminalReason: TerminalReasonSchema.nullable(),
});
export type Run = z.infer<typeof RunSchema>;

export function transitionPhase(run: Run, to: RunPhase, now: number): Run {
  assertTransition(RUN_PHASE_TABLE, `run ${run.id}`, run.phase, to);
  return { ...run, phase: to, updatedAt: now };
}

export function canTransitionPhase(from: RunPhase, to: RunPhase): boolean {
  return canTransition(RUN_PHASE_TABLE, from, to);
}
