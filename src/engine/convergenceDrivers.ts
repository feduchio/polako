import { corpusRuntimeEvidenceAllowsDone } from "../domain/acceptance.js";
import { emptyFindingCounts, type Checkpoint } from "../domain/checkpoint.js";
import type { ModelRef } from "../domain/common.js";
import { SYSTEM_ACTOR } from "../domain/common.js";
import { PATHOLOGY_DECISION_VERSION } from "../domain/convergence.js";
import type { Run } from "../domain/run.js";
import { currentReviewRoundIndex } from "../domain/review.js";
import {
  assertCodeChangeMissionMayComplete,
  ConvergenceController,
  createRollbackCheckpoint,
  type EnsembleOption,
  type MissionCompletionEvidence,
} from "../convergence/index.js";
import {
  budgetIsExhausted,
  buildPathologySample,
  decisionEvent,
  decisionState,
  detectorEvents,
  effectLifecycleEvent,
  ensembleChangeCount,
  findDecision,
  findSample,
  listDecisions,
  listSamples,
  executablePersistedRollbackTarget,
  resolveObservationBoundary,
  runDetectors,
  sampleEvent,
  selectEligibleEnsemble,
  selectStrategy,
  type PathologyDecision,
} from "../convergence/pathology/index.js";
import type { RunHead } from "./integration.js";
import { GitBranchRunHead, runOnIntegrationLane } from "./integration.js";
import { emitFinalReport, emitNeedsHumanReport } from "../report/emit.js";
import type { TerminalReason } from "../domain/run.js";
import type { PhaseContext, PhaseDriver, PhaseDriverResult } from "./types.js";
import { id } from "../shared/ids.js";

export interface ConvergenceDriverOptions {
  controller?: ConvergenceController;
  resolveRunHead?: (ctx: PhaseContext) => RunHead;
  resolveEnsembleAlternatives?: (ctx: PhaseContext) => EnsembleOption[];
  cliBudget?: { budgetTokens?: number | null; budgetUsd?: number | null };
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

    if (acceptedB6Done(ctx, controller, hash)) {
      emitFinalReport(ctx);
      return { status: "complete", nextPhase: "DONE" };
    }

    const latestEvents = ctx.store.events.list(ctx.run.id);
    const unexecuted = listDecisions(latestEvents, ctx.run.id).find((decision) => {
      const state = decisionState(latestEvents, ctx.run.id, decision.boundaryEventId);
      return state !== null && state !== "effect_completed";
    });
    if (unexecuted !== undefined) {
      return executePersistedDecision(ctx, unexecuted, options, hash);
    }

    const boundary = resolveObservationBoundary(latestEvents, ctx.config.review.reviewersPerRound);
    if (boundary == null) return b6ContinueOrRecover(ctx, controller, options, hash);
    const completedStops = listDecisions(latestEvents, ctx.run.id).filter(
      (decision) =>
        decision.action === "BUDGET_STOP" && decisionState(latestEvents, ctx.run.id, decision.boundaryEventId) === "effect_completed",
    );
    if (completedStops.length > 0) return budgetStopResult();

    const completedForBoundary = findDecision(latestEvents, ctx.run.id, boundary.id);
    if (completedForBoundary !== null && decisionState(latestEvents, ctx.run.id, boundary.id) === "effect_completed") {
      return b6ContinueOrRecover(ctx, controller, options, hash);
    }

    let sample = findSample(latestEvents, ctx.run.id, boundary.id);
    if (sample === null) {
      sample = buildPathologySample({
        events: latestEvents,
        boundary,
        config: ctx.config,
        cliBudget: options.cliBudget,
      });
      ctx.store.events.append([sampleEvent(sample, ctx.clock.now(), [boundary.id])]);
    }

    if (sample.budget.usageConflict) {
      const decision = buildDecision(ctx, sample, {
        action: "NEEDS_HUMAN",
        reason: "conflicting duplicate model.call usage",
        findings: [],
        targetCheckpointHash: null,
        targetEnsemble: null,
        targetReviewRoundIndex: null,
      });
      persistDecision(ctx, decision, [sample.boundaryEventId]);
      return executePersistedDecision(ctx, decision, options, hash);
    }

    if (budgetIsExhausted(sample.budget)) {
      const decision = buildDecision(ctx, sample, {
        action: "BUDGET_STOP",
        reason: `budget exhausted: ${sample.budget.exhaustedDimensions.join(",")}`,
        findings: [],
        targetCheckpointHash: null,
        targetEnsemble: null,
        targetReviewRoundIndex: null,
      });
      persistDecision(ctx, decision, [sample.boundaryEventId]);
      return executePersistedDecision(ctx, decision, options, hash);
    }

    const samples = listSamples(ctx.store.events.list(ctx.run.id), ctx.run.id);
    const findings = runDetectors({
      samples,
      knobs: ctx.config.convergence,
      doneEligible: false,
    });
    const decisions = listDecisions(ctx.store.events.list(ctx.run.id), ctx.run.id);
    const current = ctx.store.repos.checkpoints.listByRun(ctx.run.id).find((checkpoint) => checkpoint.commitHash === hash) ?? syntheticCheckpoint(ctx, hash);
    const prior = ctx.store.repos.checkpoints.listByRun(ctx.run.id).filter((checkpoint) => checkpoint.id !== current.id);
    const nextRound = currentReviewRoundIndex(
      ctx.store.repos.reviewExecutions.listByRun(ctx.run.id),
      ctx.config.review.reviewersPerRound,
      hash,
    );
    const selected = selectStrategy({
      findings,
      ensembleChangesByPathology: {
        finding_oscillation: ensembleChangeCount(decisions, "finding_oscillation"),
        checkpoint_oscillation: ensembleChangeCount(decisions, "checkpoint_oscillation"),
        no_progress: ensembleChangeCount(decisions, "no_progress"),
        disagreement_not_shrinking: ensembleChangeCount(decisions, "disagreement_not_shrinking"),
        task_graph_growth_from_nonblocking: ensembleChangeCount(decisions, "task_graph_growth_from_nonblocking"),
      },
      maxEnsembleChangesPerPathology: ctx.config.convergence.maxEnsembleChangesPerPathology,
      eligibleEnsemble: resolveEligibleEnsemble(ctx, options, hash, nextRound),
      current,
      priorCheckpoints: prior,
      nextReviewRoundIndex: nextRound,
    });

    if (selected.action === null) {
      return b6ContinueOrRecover(ctx, controller, options, hash);
    }

    const decision = buildDecision(ctx, sample, {
      action: selected.action,
      reason: selected.reason,
      findings,
      targetCheckpointHash:
        selected.action === "CHANGE_ENSEMBLE" ? hash : selected.targetCheckpoint?.commitHash ?? null,
      targetEnsemble: selected.targetEnsemble,
      targetReviewRoundIndex: selected.targetReviewRoundIndex,
    });
    persistDecision(ctx, decision, [sample.boundaryEventId]);
    return executePersistedDecision(ctx, decision, options, hash);
  };
}

function acceptedB6Done(ctx: PhaseContext, controller: ConvergenceController, hash: string): boolean {
  if (!runtimeEvidenceAllowsDone(ctx, hash)) return false;
  return acceptedB6Decision(ctx, controller, hash).action === "DONE";
}

function acceptedB6Decision(ctx: PhaseContext, controller: ConvergenceController, hash: string) {
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
  return controller.decide({
    current,
    priorCheckpoints: prior,
    cleanRounds: ctx.store.repos.cleanRounds.listByRun(ctx.run.id),
    requiredCleanRounds: ctx.config.convergence.requiredCleanRounds,
    openBlockingFindings: openBlocking,
    investigationExhausted,
    consecutiveNoProgress: 0,
    simplifyAfterNoProgress: ctx.config.convergence.noProgressAttempts,
    simplificationAvailable: true,
  });
}

function budgetStopResult(): PhaseDriverResult {
  return {
    status: "complete",
    nextPhase: "FAILED",
    terminalReason: {
      code: "budget_exhausted",
      summary: "run budget exhausted",
    },
  };
}

function buildDecision(
  ctx: PhaseContext,
  sample: ReturnType<typeof buildPathologySample>,
  patch: Pick<PathologyDecision, "action" | "reason" | "findings" | "targetCheckpointHash" | "targetEnsemble" | "targetReviewRoundIndex">,
): PathologyDecision {
  return {
    version: 1,
    runId: ctx.run.id,
    boundaryEventId: sample.boundaryEventId,
    decisionVersion: PATHOLOGY_DECISION_VERSION,
    findings: patch.findings,
    action: patch.action,
    reason: patch.reason,
    budget: sample.budget,
    targetCheckpointHash: patch.targetCheckpointHash,
    targetEnsemble: patch.targetEnsemble,
    targetReviewRoundIndex: patch.targetReviewRoundIndex,
    causalEventIds: [sample.boundaryEventId],
  };
}

function persistDecision(ctx: PhaseContext, decision: PathologyDecision, causedBy: string[]): void {
  const now = ctx.clock.now();
  ctx.store.events.append([
    ...detectorEvents(decision, now, causedBy),
    decisionEvent(decision, now, causedBy),
  ]);
}

function resolveEligibleEnsemble(
  ctx: PhaseContext,
  options: ConvergenceDriverOptions,
  hash: string,
  _roundIndex: number,
): ModelRef[] | null {
  const alternatives = options.resolveEnsembleAlternatives?.(ctx) ?? [];
  if (alternatives.length === 0) return null;
  const previous = ctx.store.repos.cleanRounds.listByRun(ctx.run.id);
  const currentEnsemble = ctx.store.repos.reviewExecutions
    .forCheckpoint(ctx.run.id, hash)
    .map((execution) => execution.requestedModel);
  return selectEligibleEnsemble({
    options: alternatives,
    previous,
    checkpointHash: hash,
    axes: ["correctness", "regression", "adversarial"],
    minQualityForRotation: ctx.config.review.minQualityForRotation,
    currentEnsemble,
  });
}

async function executePersistedDecision(
  ctx: PhaseContext,
  decision: PathologyDecision,
  options: ConvergenceDriverOptions,
  hash: string,
): Promise<PhaseDriverResult> {
  const state = decisionState(ctx.store.events.list(ctx.run.id), ctx.run.id, decision.boundaryEventId);
  if (state === "effect_completed") {
    return decision.action === "BUDGET_STOP" ? budgetStopResult() : { status: "complete", nextPhase: "REVIEWING" };
  }
  if (state === "decided") {
    ctx.store.events.append([effectLifecycleEvent("pathology.effect_started", decision, ctx.clock.now(), [decision.boundaryEventId])]);
  }

  if (decision.action === "BUDGET_STOP") {
    const failed: Run = {
      ...ctx.run,
      phase: "FAILED",
      terminalReason: { code: "budget_exhausted", summary: decision.reason },
      updatedAt: ctx.clock.now(),
    };
    ctx.store.events.append([
      {
        id: id("evt", ctx.clock.now()),
        runId: ctx.run.id,
        ts: ctx.clock.now(),
        type: "run.phase_changed",
        payload: { run: failed },
        causedBy: [decision.boundaryEventId],
        actor: SYSTEM_ACTOR,
        artifacts: [],
      },
      effectLifecycleEvent("pathology.effect_completed", decision, ctx.clock.now(), [decision.boundaryEventId]),
    ]);
    return budgetStopResult();
  }

  if (decision.action === "NEEDS_HUMAN") {
    emitNeedsHumanReport(ctx, humanTerminalReason(decision.reason));
    ctx.store.events.append([effectLifecycleEvent("pathology.effect_completed", decision, ctx.clock.now(), [decision.boundaryEventId])]);
    return { status: "complete", nextPhase: "NEEDS_HUMAN" };
  }

  if (decision.action === "CHANGE_ENSEMBLE") {
    ctx.store.events.append([effectLifecycleEvent("pathology.effect_completed", decision, ctx.clock.now(), [decision.boundaryEventId])]);
    return { status: "complete", nextPhase: "REVIEWING" };
  }

  if (decision.action === "ROLLBACK") {
    const checkpoints = ctx.store.repos.checkpoints.listByRun(ctx.run.id);
    const current = checkpoints.find((checkpoint) => checkpoint.commitHash === hash) ?? syntheticCheckpoint(ctx, hash);
    const target =
      decision.targetCheckpointHash === null
        ? null
        : checkpoints.find((checkpoint) => checkpoint.commitHash === decision.targetCheckpointHash) ?? null;
    const chosen = executablePersistedRollbackTarget(current, target);
    if (chosen?.runId !== ctx.run.id) {
      emitNeedsHumanReport(ctx, humanTerminalReason("no proven rollback target"));
      ctx.store.events.append([effectLifecycleEvent("pathology.effect_completed", decision, ctx.clock.now(), [decision.boundaryEventId])]);
      return { status: "complete", nextPhase: "NEEDS_HUMAN" };
    }
    const runHead = options.resolveRunHead?.(ctx) ?? new GitBranchRunHead(ctx.run.projectPath, ctx.run.runBranch);
    const result = await runOnIntegrationLane(() =>
      createRollbackCheckpoint({
        run: ctx.run,
        current,
        target: chosen,
        runHead,
        now: ctx.clock.now(),
      }),
    );
    if (!result.advanced) {
      emitNeedsHumanReport(ctx, {
        code: "internal_error",
        summary: "dominance rollback could not be applied on the run branch",
        question: "Rollback failed because the run branch head changed. How should the run proceed?",
        options: ["Retry rollback", "Stop the run"],
      });
      ctx.store.events.append([effectLifecycleEvent("pathology.effect_completed", decision, ctx.clock.now(), [decision.boundaryEventId])]);
      return { status: "complete", nextPhase: "NEEDS_HUMAN" };
    }
    ctx.store.events.append([
      ...result.events,
      effectLifecycleEvent("pathology.effect_completed", decision, ctx.clock.now(), [decision.boundaryEventId]),
    ]);
    const nextPhase = requiresPlanning(ctx) ? "PLANNING" : "REVIEWING";
    return { status: "complete", nextPhase };
  }

  return { status: "complete", nextPhase: "REVIEWING" };
}

function requiresPlanning(ctx: PhaseContext): boolean {
  return ctx.store.repos.tasks.listByRun(ctx.run.id).some(
    (task) =>
      task.state === "PENDING" &&
      (task.kind === "investigation" || task.origin.kind === "valid_finding"),
  );
}

async function b6ContinueOrRecover(
  ctx: PhaseContext,
  controller: ConvergenceController,
  options: ConvergenceDriverOptions,
  hash: string,
): Promise<PhaseDriverResult> {
  if (!runtimeEvidenceAllowsDone(ctx, hash)) {
    return { status: "complete", nextPhase: "REVIEWING" };
  }

  const checkpoints = ctx.store.repos.checkpoints.listByRun(ctx.run.id);
  const current = checkpoints.find((checkpoint) => checkpoint.commitHash === hash) ?? syntheticCheckpoint(ctx, hash);
  const decision = acceptedB6Decision(ctx, controller, hash);

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
    maxAttempts: ctx.config.retry.maxAttempts,
  };
}

function runtimeEvidenceAllowsDone(ctx: PhaseContext, checkpointHash: string): boolean {
  return corpusRuntimeEvidenceAllowsDone(
    ctx.config.runtimeValidation.mode,
    ctx.store.repos.acceptanceCorpus.forMission(ctx.run.missionId),
    checkpointHash,
  );
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
