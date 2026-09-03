import { runtimeAllowsDone, type RuntimeEvidence } from "../domain/acceptance.js";
import { emptyFindingCounts, type Checkpoint } from "../domain/checkpoint.js";
import type { Run } from "../domain/run.js";
import {
  assertCodeChangeMissionMayComplete,
  ConvergenceController,
  createRollbackCheckpoint,
  type MissionCompletionEvidence,
} from "../convergence/index.js";
import type { RunHead } from "./integration.js";
import { GitBranchRunHead, runOnIntegrationLane } from "./integration.js";
import { emitFinalReport, emitNeedsHumanReport } from "../report/emit.js";
import type { TerminalReason } from "../domain/run.js";
import type { PhaseContext, PhaseDriver, PhaseDriverResult } from "./types.js";
import { id } from "../shared/ids.js";

export interface ConvergenceDriverOptions {
  controller?: ConvergenceController;
  resolveRunHead?: (ctx: PhaseContext) => RunHead;
}

/**
 * Production CONVERGENCE_CHECK driver: anti-fake-DONE, checkpoint-bound clean rounds,
 * runtime evidence (B12), and dominance-driven rollback before DONE.
 */
export function createConvergenceDriver(options: ConvergenceDriverOptions = {}): PhaseDriver {
  const controller = options.controller ?? new ConvergenceController();
  return async (ctx): Promise<PhaseDriverResult> => {
    const hash = ctx.run.currentCheckpointHash;
    if (hash === null) return { status: "waiting" };

    const evidence = gatherCompletionEvidence(ctx);
    const antiFake = assertCodeChangeMissionMayComplete(evidence);
    if (!antiFake.ok) {
      if (antiFake.terminal === "NEEDS_HUMAN") {
        emitNeedsHumanReport(ctx, humanTerminalReason(antiFake.reason));
      }
      return { status: "complete", nextPhase: antiFake.terminal };
    }

    if (!runtimeEvidenceAllowsDone(ctx, hash)) {
      return { status: "complete", nextPhase: "REVIEWING" };
    }

    const cleanRounds = ctx.store.repos.cleanRounds.listByRun(ctx.run.id);
    const findings = ctx.store.repos.findings.openForCheckpoint(ctx.run.id, hash);
    const openBlocking = findings.filter((finding) => finding.blocking && finding.status === "VALID").length;
    const investigationExhausted = findings.some(
      (finding) =>
        finding.status === "UNCERTAIN" &&
        finding.investigationRounds >= ctx.config.convergence.maxInvestigationRoundsPerFinding,
    );
    const checkpoints = ctx.store.repos.checkpoints.listByRun(ctx.run.id);
    const current = checkpoints.find((checkpoint) => checkpoint.commitHash === hash) ?? syntheticCheckpoint(ctx, hash);
    const prior = checkpoints.filter((checkpoint) => checkpoint.commitHash !== hash);

    const decision = controller.decide({
      current,
      priorCheckpoints: prior,
      cleanRounds,
      requiredCleanRounds: ctx.config.convergence.requiredCleanRounds,
      openBlockingFindings: openBlocking,
      investigationExhausted,
      consecutiveNoProgress: 0,
      simplifyAfterNoProgress: ctx.config.convergence.noProgressAttempts,
      simplificationAvailable: true,
    });

    switch (decision.action) {
      case "DONE":
        emitFinalReport(ctx);
        return { status: "complete", nextPhase: "DONE" };
      case "NEEDS_HUMAN":
        emitNeedsHumanReport(ctx, humanTerminalReason(decision.reason));
        return { status: "complete", nextPhase: "NEEDS_HUMAN" };
      case "SIMPLIFY": {
        const rollbackTo = decision.rollbackTo;
        if (rollbackTo !== null) {
          const runHead = options.resolveRunHead?.(ctx) ?? new GitBranchRunHead(ctx.run.projectPath, ctx.run.runBranch);
          const result = await runOnIntegrationLane(() =>
            createRollbackCheckpoint({
              run: ctx.run,
              current,
              target: rollbackTo,
              runHead,
              now: ctx.clock.now(),
            }),
          );
          if (!result.advanced) {
            emitNeedsHumanReport(ctx, {
              code: "internal_error",
              summary: "dominance rollback could not be applied on the run branch",
              question: "Rollback failed because the run branch head changed. How should the run proceed?",
              options: ["Retry simplification", "Stop the run"],
            });
            return { status: "complete", nextPhase: "NEEDS_HUMAN" };
          }
          ctx.store.events.append(result.events);
        }
        return { status: "complete", nextPhase: "SIMPLIFYING" };
      }
      case "CONTINUE_REVIEW":
        return { status: "complete", nextPhase: "REVIEWING" };
    }
  };
}

export function gatherCompletionEvidence(ctx: PhaseContext): MissionCompletionEvidence {
  const baseline = ctx.store.repos.baselines.listByRun(ctx.run.id)[0];
  return {
    tasks: ctx.store.repos.tasks.listByRun(ctx.run.id),
    candidates: ctx.store.repos.candidates.listByRun(ctx.run.id),
    checkpoints: ctx.store.repos.checkpoints.listByRun(ctx.run.id),
    reviewExecutions: ctx.store.repos.reviewExecutions.listByRun(ctx.run.id),
    cleanRounds: ctx.store.repos.cleanRounds.listByRun(ctx.run.id),
    baselineCommitHash: baseline?.commitHash ?? null,
    currentCheckpointHash: ctx.run.currentCheckpointHash,
    requiredReviewers: ctx.config.review.reviewersPerRound,
  };
}

function runtimeEvidenceAllowsDone(ctx: PhaseContext, checkpointHash: string): boolean {
  const mode = ctx.config.runtimeValidation.mode;
  const corpus = ctx.store.repos.acceptanceCorpus.forMission(ctx.run.missionId);
  const evidences = corpus.entries
    .map((entry) => entry.runtimeEvidence)
    .filter((evidence): evidence is RuntimeEvidence => evidence !== undefined);
  const current = evidences.filter((evidence) => evidence.checkpointHash === checkpointHash);
  if (mode === "required") {
    return current.some((evidence) => runtimeAllowsDone(mode, evidence, checkpointHash));
  }
  if (current.some((evidence) => evidence.status === "failed")) return false;
  return current.length === 0 || current.some((evidence) => runtimeAllowsDone(mode, evidence, checkpointHash));
}

function humanTerminalReason(summary: string): TerminalReason {
  return {
    code: "pathology_detected",
    summary,
    question: summary,
    options: ["Continue review", "Stop the run"],
  };
}

function syntheticCheckpoint(ctx: PhaseContext, hash: string): Checkpoint {
  return {
    id: id("cp", ctx.clock.now()),
    runId: ctx.run.id,
    seq: 0,
    commitHash: hash,
    parentId: null,
    source: "baseline",
    taskId: null,
    evidence: {
      gates: {},
      testsPassed: 0,
      testsFailed: 0,
      testsTotal: 0,
      openValidatedFindings: emptyFindingCounts(),
      diffLinesFromBaseline: 0,
    },
    createdAt: ctx.clock.now(),
  };
}

/** Applies anti-fake-DONE before allowing engine termination at DONE. */
export function assertRunMayComplete(run: Run, evidence: MissionCompletionEvidence): void {
  const result = assertCodeChangeMissionMayComplete(evidence);
  if (!result.ok && run.currentCheckpointHash !== null) {
    throw new Error(`anti-fake-DONE: ${result.reason}`);
  }
}
