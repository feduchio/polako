import type { Candidate } from "../domain/candidate.js";
import type { Checkpoint } from "../domain/checkpoint.js";
import type { CleanRound } from "../domain/convergence.js";
import type { ReviewExecution } from "../domain/review.js";
import type { Task } from "../domain/task.js";
import { cleanRoundsHaveReviewProof } from "./record.js";

export interface MissionCompletionEvidence {
  tasks: readonly Task[];
  candidates: readonly Candidate[];
  checkpoints: readonly Checkpoint[];
  reviewExecutions: readonly ReviewExecution[];
  cleanRounds: readonly CleanRound[];
  baselineCommitHash: string | null;
  currentCheckpointHash: string | null;
  requiredReviewers: number;
}

export type MissionMayCompleteResult = { ok: true } | { ok: false; reason: string; terminal: "FAILED" | "NEEDS_HUMAN" };

/** True when the task graph includes coding work (not investigation-only). */
export function missionRequiresCodeChange(tasks: readonly Task[]): boolean {
  return tasks.some((task) => task.touchesProductCode && task.kind !== "investigation");
}

const CANDIDATE_WORKER_STATES = new Set<Candidate["state"]>([
  "IMPLEMENTING",
  "IMPLEMENTED",
  "GATING",
  "PASSED_GATES",
  "FAILED_GATES",
  "WINNER",
  "LOSER",
]);

/**
 * Anti-fake-DONE gate for change-required missions. Review-only missions may complete without
 * a code diff; change-required missions must show real worker, gate, integration, and review evidence.
 */
export function assertCodeChangeMissionMayComplete(evidence: MissionCompletionEvidence): MissionMayCompleteResult {
  if (!missionRequiresCodeChange(evidence.tasks)) return { ok: true };

  const codingTasks = evidence.tasks.filter((task) => task.touchesProductCode && task.kind !== "investigation");
  if (codingTasks.length === 0) {
    return fail("change-required mission has no planned coding tasks");
  }

  const workerExecutions = evidence.candidates.filter((candidate) => CANDIDATE_WORKER_STATES.has(candidate.state));
  if (workerExecutions.length === 0) {
    return fail("change-required mission has no worker executions");
  }

  const worktrees = evidence.candidates.filter((candidate) => candidate.worktreePath !== null || candidate.headCommit !== null);
  if (worktrees.length === 0) {
    return fail("change-required mission has no candidate worktrees");
  }

  const commits = evidence.candidates.filter((candidate) => candidate.headCommit !== null);
  if (commits.length === 0) {
    return fail("change-required mission has no candidate commits");
  }

  const passedGates = evidence.candidates.filter((candidate) => candidate.gateReport?.passed === true);
  if (passedGates.length === 0) {
    return fail("change-required mission has no successful independent gates");
  }

  const integrated = evidence.checkpoints.filter((checkpoint) => checkpoint.source === "integration");
  if (integrated.length === 0) {
    return fail("change-required mission has no integrated code changes");
  }

  if (
    evidence.currentCheckpointHash !== null &&
    evidence.baselineCommitHash !== null &&
    evidence.currentCheckpointHash === evidence.baselineCommitHash
  ) {
    return fail("final checkpoint equals baseline checkpoint");
  }

  const completedReviews = evidence.reviewExecutions.filter((execution) => execution.completed);
  if (completedReviews.length === 0) {
    return fail("change-required mission has no actual review executions");
  }

  if (
    evidence.currentCheckpointHash !== null &&
    !cleanRoundsHaveReviewProof(
      evidence.cleanRounds,
      evidence.currentCheckpointHash,
      evidence.reviewExecutions,
      evidence.requiredReviewers,
    )
  ) {
    return fail("clean rounds lack completed review proof");
  }

  return { ok: true };
}

function fail(reason: string): MissionMayCompleteResult {
  return { ok: false, reason, terminal: "FAILED" };
}
