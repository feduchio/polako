import { SYSTEM_ACTOR, type ModelRef } from "../domain/common.js";
import { CleanRoundSchema, cleanRoundsFor, isNovelRound, type CleanRound, type DispositionTally } from "../domain/convergence.js";
import type { NewEvent } from "../domain/event.js";
import type { Finding } from "../domain/finding.js";
import type { ReviewAxis } from "../domain/finding.js";
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
  /** The checkpoint's findings by disposition, recorded on the round. */
  dispositions?: DispositionTally;
  now: number;
}

/** Completed review-swarm round indexes for the checkpoint, ascending. */
export function completedReviewRoundIndexes(
  executions: readonly ReviewExecution[],
  checkpointHash: string,
  required: number,
): number[] {
  const rounds = new Set(
    executions.filter((execution) => execution.checkpointHash === checkpointHash).map((execution) => execution.roundIndex),
  );
  return [...rounds]
    .sort((a, b) => a - b)
    .filter((roundIndex) => isReviewRoundComplete(executions, checkpointHash, roundIndex, required));
}

/** Latest review round index with all required reviewers completed for the checkpoint. */
export function latestCompletedReviewRound(
  executions: readonly ReviewExecution[],
  checkpointHash: string,
  required: number,
): number | null {
  return completedReviewRoundIndexes(executions, checkpointHash, required).at(-1) ?? null;
}

function consumedReviewRoundIndexes(cleanRounds: readonly CleanRound[], checkpointHash: string): Set<number> {
  const consumed = new Set<number>();
  for (const round of cleanRoundsFor(cleanRounds, checkpointHash)) {
    if (round.reviewRoundIndex !== undefined) consumed.add(round.reviewRoundIndex);
  }
  return consumed;
}

/**
 * First completed review round on this checkpoint that no CleanRound already binds, passing over
 * `disqualified` rounds (produced by a reviewer that failed the canary), which can never bind one.
 */
export function nextUnconsumedCompletedReviewRound(
  cleanRounds: readonly CleanRound[],
  executions: readonly ReviewExecution[],
  checkpointHash: string,
  required: number,
  disqualified: ReadonlySet<number> = new Set(),
): number | null {
  const consumed = consumedReviewRoundIndexes(cleanRounds, checkpointHash);
  return completedReviewRoundIndexes(executions, checkpointHash, required)
    .find((roundIndex) => !consumed.has(roundIndex) && !disqualified.has(roundIndex)) ?? null;
}

function completedProofExecutions(
  executions: readonly ReviewExecution[],
  checkpointHash: string,
  reviewRoundIndex: number,
): ReviewExecution[] {
  return reviewRoundExecutions(executions, checkpointHash, reviewRoundIndex).filter((execution) => execution.completed);
}

function proofSlice(executions: readonly ReviewExecution[]): { axes: ReviewAxis[]; ensemble: ModelRef[] } {
  return {
    axes: executions.map((execution) => execution.axis),
    ensemble: executions.map((execution) => execution.requestedModel),
  };
}

function sameProofSlice(
  left: { axes: readonly ReviewAxis[]; ensemble: readonly ModelRef[] },
  right: { axes: readonly ReviewAxis[]; ensemble: readonly ModelRef[] },
): boolean {
  if (left.axes.length !== right.axes.length || left.ensemble.length !== right.ensemble.length) return false;
  for (let index = 0; index < left.axes.length; index += 1) {
    if (left.axes[index] !== right.axes[index]) return false;
  }
  for (let index = 0; index < left.ensemble.length; index += 1) {
    const a = left.ensemble[index];
    const b = right.ensemble[index];
    if (a === undefined || b === undefined) return false;
    if (a.provider !== b.provider || a.model !== b.model) return false;
  }
  return true;
}

/**
 * Validates proof-of-review and builds a clean round snapshot. Rejects administrative rounds
 * (no review executions, wrong checkpoint, incomplete reviewers, or blocking findings).
 */
export function buildCleanRoundFromReview(input: RecordCleanRoundInput): CleanRound {
  const reviewRoundIndex =
    input.reviewRoundIndex ??
    nextUnconsumedCompletedReviewRound(
      input.existingCleanRounds,
      input.reviewExecutions,
      input.checkpointHash,
      input.requiredReviewers,
    );
  if (reviewRoundIndex === null) {
    throw new Error("cannot record clean round without completed review executions");
  }

  if (consumedReviewRoundIndexes(input.existingCleanRounds, input.checkpointHash).has(reviewRoundIndex)) {
    throw new Error(`review round ${reviewRoundIndex} already proves a clean round`);
  }

  const roundExecutions = completedProofExecutions(input.reviewExecutions, input.checkpointHash, reviewRoundIndex);
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

  const { axes, ensemble } = proofSlice(roundExecutions);
  const rawFindings = roundExecutions.reduce((sum, execution) => sum + execution.findings.length, 0);
  const priorForCheckpoint = cleanRoundsFor(input.existingCleanRounds, input.checkpointHash);
  const roundIndex = (priorForCheckpoint.at(-1)?.roundIndex ?? 0) + 1;

  return CleanRoundSchema.parse({
    id: id("cr", input.now),
    runId: input.runId,
    checkpointHash: input.checkpointHash,
    roundIndex,
    reviewRoundIndex,
    axes,
    ensemble,
    rawFindings,
    validatedBlocking: 0,
    novel: isNovelRound(input.existingCleanRounds, { checkpointHash: input.checkpointHash, axes, ensemble }),
    ...(input.dispositions === undefined ? {} : { dispositions: input.dispositions }),
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

  const seen = new Set<number>();
  for (const round of scoped) {
    if (round.reviewRoundIndex === undefined) return false;
    if (seen.has(round.reviewRoundIndex)) return false;
    seen.add(round.reviewRoundIndex);
    if (
      !isReviewRoundComplete(reviewExecutions, checkpointHash, round.reviewRoundIndex, requiredReviewers)
    ) {
      return false;
    }
    const completed = completedProofExecutions(reviewExecutions, checkpointHash, round.reviewRoundIndex);
    if (completed.length < requiredReviewers) return false;
    if (completed.some((execution) => execution.checkpointHash !== checkpointHash)) return false;
    if (!sameProofSlice({ axes: round.axes, ensemble: round.ensemble }, proofSlice(completed))) return false;
  }
  return true;
}
