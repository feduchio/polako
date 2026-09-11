import type { Candidate } from "../domain/candidate.js";
import type { Checkpoint } from "../domain/checkpoint.js";
import type { CleanRound } from "../domain/convergence.js";
import type { ReviewExecution } from "../domain/review.js";
import type { Task } from "../domain/task.js";
import { cleanRoundsHaveReviewProof } from "./record.js";

const DEFAULT_MAX_ATTEMPTS = 5;

const ACCEPTABLE_TERMINALS_FOR_DONE = new Set<Task["state"]>(["INTEGRATED", "REJECTED", "CANCELLED"]);

export interface MissionCompletionEvidence {
  tasks: readonly Task[];
  candidates: readonly Candidate[];
  checkpoints: readonly Checkpoint[];
  reviewExecutions: readonly ReviewExecution[];
  cleanRounds: readonly CleanRound[];
  baselineCommitHash: string | null;
  currentCheckpointHash: string | null;
  requiredReviewers: number;
  /** `config.retry.maxAttempts`; used to distinguish continuable vs exhausted incompletes. */
  maxAttempts?: number;
}

export type MissionMayCompleteResult =
  | { ok: true }
  | { ok: false; reason: string; terminal: "FAILED" | "NEEDS_HUMAN" | "PLANNING" };

/** True when the task graph includes coding work (not investigation-only). */
export function missionRequiresCodeChange(tasks: readonly Task[]): boolean {
  return tasks.some((task) => isCodingTask(task));
}

export function isCodingTask(task: Task): boolean {
  return task.touchesProductCode && task.kind !== "investigation";
}

export function isAcceptableTerminalForDone(task: Task): boolean {
  return ACCEPTABLE_TERMINALS_FOR_DONE.has(task.state);
}

export function isIncompleteCodingTask(task: Task): boolean {
  return isCodingTask(task) && !isAcceptableTerminalForDone(task);
}

export function isExhaustedCodingTask(task: Task, maxAttempts: number): boolean {
  return isCodingTask(task) && (
    task.state === "BLOCKED" ||
    (task.state === "INTEGRATION_FAILED" && task.attempts >= maxAttempts)
  );
}

export function isContinuableCodingWork(task: Task, maxAttempts: number): boolean {
  return isIncompleteCodingTask(task) && !isExhaustedCodingTask(task, maxAttempts);
}

export function hasContinuableCodingWork(tasks: readonly Task[], maxAttempts: number): boolean {
  return tasks.some((task) => isContinuableCodingWork(task, maxAttempts));
}

/**
 * Routing for remaining incomplete coding work after a successful integrate or at anti-fake.
 * `null` means every coding task is an acceptable DONE terminal.
 */
export function incompleteCodingWorkTerminal(
  tasks: readonly Task[],
  maxAttempts: number,
): "PLANNING" | "FAILED" | null {
  const incompletes = tasks.filter(isIncompleteCodingTask);
  if (incompletes.length === 0) return null;
  return incompletes.some((task) => isContinuableCodingWork(task, maxAttempts)) ? "PLANNING" : "FAILED";
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
 * Incomplete coding tasks (including valid_finding) block DONE; continuable incompletes route to PLANNING.
 */
export function assertCodeChangeMissionMayComplete(evidence: MissionCompletionEvidence): MissionMayCompleteResult {
  if (!missionRequiresCodeChange(evidence.tasks)) return { ok: true };

  const codingTasks = evidence.tasks.filter(isCodingTask);
  if (codingTasks.length === 0) {
    return fail("change-required mission has no planned coding tasks");
  }

  const maxAttempts = evidence.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const incompleteTerminal = incompleteCodingWorkTerminal(evidence.tasks, maxAttempts);
  if (incompleteTerminal !== null) {
    return fail(
      incompleteTerminal === "PLANNING"
        ? "incomplete coding tasks remain"
        : "exhausted incomplete coding tasks remain",
      incompleteTerminal,
    );
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

function fail(reason: string, terminal: "FAILED" | "NEEDS_HUMAN" | "PLANNING" = "FAILED"): MissionMayCompleteResult {
  return { ok: false, reason, terminal };
}
