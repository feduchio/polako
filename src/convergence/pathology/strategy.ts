import type { Checkpoint } from "../../domain/checkpoint.js";
import type { C2StrategyAction, Pathology } from "../../domain/convergence.js";
import type { ModelRef } from "../../domain/common.js";
import { rollbackTarget } from "../dominance.js";
import type { DetectorFinding, PathologyDecision } from "./types.js";
import { comparePathology } from "./detectors.js";

const ACTION_PRIORITY: readonly C2StrategyAction[] = ["NEEDS_HUMAN", "ROLLBACK", "CHANGE_ENSEMBLE"];

export function hasFailedGate(checkpoint: Checkpoint): boolean {
  return Object.values(checkpoint.evidence.gates).some((status) => status === "fail" || status === "error" || status === "timeout");
}

/** B6 dominance plus the extra C2 gate filter. */
export function provenC2RollbackTarget(current: Checkpoint, prior: readonly Checkpoint[]): Checkpoint | null {
  const target = rollbackTarget(current, prior);
  if (target === null) return null;
  if (hasFailedGate(target)) return null;
  return target;
}

export interface StrategyContext {
  findings: readonly DetectorFinding[];
  ensembleChangesByPathology: Readonly<Record<Pathology, number>>;
  maxEnsembleChangesPerPathology: number;
  eligibleEnsemble: ModelRef[] | null;
  current: Checkpoint | null;
  priorCheckpoints: readonly Checkpoint[];
  nextReviewRoundIndex: number;
}

export interface SelectedStrategy {
  action: C2StrategyAction | null;
  reason: string;
  owner: DetectorFinding | null;
  targetCheckpoint: Checkpoint | null;
  targetEnsemble: ModelRef[] | null;
  targetReviewRoundIndex: number | null;
}

function intendedAction(kind: Pathology, ctx: StrategyContext, occurrenceHint: "first" | "later"): C2StrategyAction {
  switch (kind) {
    case "finding_oscillation":
      if (ctx.ensembleChangesByPathology.finding_oscillation >= ctx.maxEnsembleChangesPerPathology || ctx.eligibleEnsemble === null) {
        return "NEEDS_HUMAN";
      }
      return "CHANGE_ENSEMBLE";
    case "checkpoint_oscillation":
      return ctx.current !== null && provenC2RollbackTarget(ctx.current, ctx.priorCheckpoints) !== null
        ? "ROLLBACK"
        : "NEEDS_HUMAN";
    case "no_progress":
      if (occurrenceHint === "first" && ctx.ensembleChangesByPathology.no_progress < ctx.maxEnsembleChangesPerPathology && ctx.eligibleEnsemble !== null) {
        return "CHANGE_ENSEMBLE";
      }
      if (ctx.current !== null && provenC2RollbackTarget(ctx.current, ctx.priorCheckpoints) !== null) return "ROLLBACK";
      return "NEEDS_HUMAN";
    case "disagreement_not_shrinking":
      if (ctx.ensembleChangesByPathology.disagreement_not_shrinking >= ctx.maxEnsembleChangesPerPathology || ctx.eligibleEnsemble === null) {
        return "NEEDS_HUMAN";
      }
      return "CHANGE_ENSEMBLE";
    case "task_graph_growth_from_nonblocking":
      return "NEEDS_HUMAN";
  }
}

export function selectStrategy(ctx: StrategyContext): SelectedStrategy {
  if (ctx.findings.length === 0) {
    return {
      action: null,
      reason: "no pathology detected",
      owner: null,
      targetCheckpoint: null,
      targetEnsemble: null,
      targetReviewRoundIndex: null,
    };
  }

  const ranked = ctx.findings
    .map((finding) => {
      const hint: "first" | "later" = ctx.ensembleChangesByPathology[finding.kind] === 0 ? "first" : "later";
      return { finding, action: intendedAction(finding.kind, ctx, hint) };
    })
    .sort((a, b) => {
      const byAction = ACTION_PRIORITY.indexOf(a.action) - ACTION_PRIORITY.indexOf(b.action);
      if (byAction !== 0) return byAction;
      return comparePathology(a.finding.kind, b.finding.kind);
    });

  const chosen = ranked[0];
  if (chosen === undefined) {
    return {
      action: null,
      reason: "no pathology detected",
      owner: null,
      targetCheckpoint: null,
      targetEnsemble: null,
      targetReviewRoundIndex: null,
    };
  }

  const targetCheckpoint =
    chosen.action === "ROLLBACK" && ctx.current !== null ? provenC2RollbackTarget(ctx.current, ctx.priorCheckpoints) : null;
  return {
    action: chosen.action,
    reason: chosen.finding.reason,
    owner: chosen.finding,
    targetCheckpoint,
    targetEnsemble: chosen.action === "CHANGE_ENSEMBLE" ? ctx.eligibleEnsemble : null,
    targetReviewRoundIndex: chosen.action === "CHANGE_ENSEMBLE" ? ctx.nextReviewRoundIndex : null,
  };
}

export function ensembleChangeCount(decisions: readonly PathologyDecision[], kind: Pathology): number {
  return decisions.filter((decision) => decision.action === "CHANGE_ENSEMBLE" && decision.findings.some((finding) => finding.kind === kind)).length;
}
