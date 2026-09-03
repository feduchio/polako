import type { Checkpoint } from "../domain/checkpoint.js";
import { hasConverged, type CleanRound } from "../domain/convergence.js";
import { rollbackTarget } from "./dominance.js";

export type ConvergenceDecision =
  | { action: "CONTINUE_REVIEW"; reason: string }
  | { action: "SIMPLIFY"; reason: string; rollbackTo: Checkpoint | null }
  | { action: "DONE"; reason: string }
  | { action: "NEEDS_HUMAN"; reason: string };

export interface ConvergenceState {
  current: Checkpoint;
  priorCheckpoints: readonly Checkpoint[];
  cleanRounds: readonly CleanRound[];
  requiredCleanRounds: number;
  openBlockingFindings: number;
  investigationExhausted: boolean;
  consecutiveNoProgress: number;
  simplifyAfterNoProgress: number;
  simplificationAvailable?: boolean;
}

export class ConvergenceController {
  decide(state: ConvergenceState): ConvergenceDecision {
    if (!Number.isInteger(state.requiredCleanRounds) || state.requiredCleanRounds < 1) {
      throw new RangeError("requiredCleanRounds must be a positive integer");
    }
    if (state.investigationExhausted) {
      return { action: "NEEDS_HUMAN", reason: "an uncertain finding exhausted its investigation budget" };
    }

    const rollbackTo = rollbackTarget(state.current, state.priorCheckpoints);
    if (rollbackTo !== null) {
      return {
        action: "SIMPLIFY",
        reason: "the current checkpoint is strictly dominated by prior evidence",
        rollbackTo,
      };
    }

    if (
      state.openBlockingFindings === 0 &&
      hasConverged(state.cleanRounds, state.current.commitHash, state.requiredCleanRounds)
    ) {
      return { action: "DONE", reason: "the current checkpoint reached the required clean rounds" };
    }

    if (state.consecutiveNoProgress >= state.simplifyAfterNoProgress) {
      if (state.simplificationAvailable === false) {
        return { action: "NEEDS_HUMAN", reason: "review made no progress and no safe simplification remains" };
      }
      return { action: "SIMPLIFY", reason: "review made no evidence progress", rollbackTo: null };
    }

    return {
      action: "CONTINUE_REVIEW",
      reason:
        state.openBlockingFindings > 0
          ? "validated blocking findings remain open"
          : "more clean rounds are required for the current checkpoint",
    };
  }
}
