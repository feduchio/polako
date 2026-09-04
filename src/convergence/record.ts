import { SYSTEM_ACTOR } from "../domain/common.js";
import { CleanRoundSchema, cleanRoundsFor, isNovelRound, type CleanRound } from "../domain/convergence.js";
import type { NewEvent } from "../domain/event.js";
import type { Finding } from "../domain/finding.js";
import {
  isReviewRoundComplete,
  reviewRoundExecutions,
  type ReviewExecution,
} from "../domain/review.js";
import { id } from "../shared/ids.js";

export interface RecordCleanRoundInput {
  runId: string;
  checkpointHash: string;
  requiredReviewers: number;
  reviewExecutions: readonly ReviewExecution[];
  findings: readonly Finding[];
  existingCleanRounds: readonly CleanRound[];
  reviewRoundIndex?: number;
  now: number;
}

/** Latest review round index with all required reviewers completed for the checkpoint. */
export function latestCompletedReviewRound(
  executions: readonly ReviewExecution[],
  checkpointHash: string,
  required: number,
): number | null {
  const rounds = new Set(
    executions.filter((execution) => execution.checkpointHash === checkpointHash).map((execution) => execution.roundIndex),
  );
  let latest: number | null = null;
  for (const roundIndex of [...rounds].sort((a, b) => a - b)) {
    if (isReviewRoundComplete(executions, checkpointHash, roundIndex, required)) latest = roundIndex;
  }
  return latest;
}

/**
 * Validates proof-of-review and builds a clean round snapshot. Rejects administrative rounds
 * (no review executions, wrong checkpoint, incomplete reviewers, or blocking findings).
 */
export function buildCleanRoundFromReview(input: RecordCleanRoundInput): CleanRound {
  const reviewRoundIndex =
    input.reviewRoundIndex ?? latestCompletedReviewRound(input.reviewExecutions, input.checkpointHash, input.requiredReviewers);
  if (reviewRoundIndex === null) {
    throw new Error("cannot record clean round without completed review executions");
  }

  const roundExecutions = reviewRoundExecutions(input.reviewExecutions, input.checkpointHash, reviewRoundIndex).filter(
    (execution) => execution.completed,
  );
  if (roundExecutions.length === 0) {
    throw new Error("cannot record clean round without completed review executions");
  }
  if (!isReviewRoundComplete(input.reviewExecutions, input.checkpointHash, reviewRoundIndex, input.requiredReviewers)) {
    throw new Error("required reviewers are incomplete for the review round");
  }
  for (const execution of roundExecutions) {
    if (execution.checkpointHash !== input.checkpointHash) {
      throw new Error(
        `review execution checkpoint ${execution.checkpointHash} does not match clean round checkpoint ${input.checkpointHash}`,
      );
    }
  }

  const validatedBlocking = input.findings.filter(
    (finding) =>
      finding.checkpointHash === input.checkpointHash && finding.blocking && finding.status === "VALID",
  ).length;
  if (validatedBlocking > 0) {
    throw new Error("validated blocking findings remain; round is not clean");
  }

  const axes = roundExecutions.map((execution) => execution.axis);
  const ensemble = roundExecutions.map((execution) => execution.requestedModel);
  const rawFindings = roundExecutions.reduce((sum, execution) => sum + execution.findings.length, 0);
  const priorForCheckpoint = cleanRoundsFor(input.existingCleanRounds, input.checkpointHash);
  const roundIndex = (priorForCheckpoint.at(-1)?.roundIndex ?? 0) + 1;

  return CleanRoundSchema.parse({
    id: id("cr", input.now),
    runId: input.runId,
    checkpointHash: input.checkpointHash,
    roundIndex,
    axes,
    ensemble,
    rawFindings,
    validatedBlocking: 0,
    novel: isNovelRound(input.existingCleanRounds, { checkpointHash: input.checkpointHash, axes, ensemble }),
    createdAt: input.now,
  });
}

/** Returns a `clean_round.recorded` event after proof-of-review validation. */
export function recordCleanRoundEvent(input: RecordCleanRoundInput): NewEvent {
  const cleanRound = buildCleanRoundFromReview(input);
  return {
    id: id("evt", input.now),
    runId: input.runId,
    ts: input.now,
    type: "clean_round.recorded",
    payload: { cleanRound },
    causedBy: [],
    actor: SYSTEM_ACTOR,
    artifacts: [],
  };
}

/** True when every clean round on the checkpoint has matching completed review evidence. */
export function cleanRoundsHaveReviewProof(
  cleanRounds: readonly CleanRound[],
  checkpointHash: string,
  reviewExecutions: readonly ReviewExecution[],
  requiredReviewers: number,
): boolean {
  const scoped = cleanRoundsFor(cleanRounds, checkpointHash);
  if (scoped.length === 0) return true;
  const completedRound = latestCompletedReviewRound(reviewExecutions, checkpointHash, requiredReviewers);
  if (completedRound === null) return false;
  return scoped.every(() => {
    const executions = reviewRoundExecutions(reviewExecutions, checkpointHash, completedRound);
    return (
      executions.length >= requiredReviewers &&
      isReviewRoundComplete(reviewExecutions, checkpointHash, completedRound, requiredReviewers)
    );
  });
}
