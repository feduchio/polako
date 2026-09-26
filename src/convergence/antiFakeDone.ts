import type { Candidate } from "../domain/candidate.js";
import type { Checkpoint } from "../domain/checkpoint.js";
import type { CleanRound } from "../domain/convergence.js";
import type { ReviewExecution } from "../domain/review.js";
import type { Task } from "../domain/task.js";
import { cleanRoundsHaveReviewProof } from "./record.js";

const DEFAULT_MAX_ATTEMPTS = 5;

const ACCEPTABLE_TERMINALS_FOR_DONE = new Set<Task["state"]>(["INTEGRATED", "REJECTED", "CANCELLED", "SATISFIED"]);

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

export function isAcceptableTerminalForDone(task: Task, tasks: readonly Task[] = []): boolean {
  if (task.state === "SPLIT") return tasks.some((part) => part.splitFrom === task.id);
  return ACCEPTABLE_TERMINALS_FOR_DONE.has(task.state);
}

/** Coding work that was actually attempted as one change: a split task's work is its subtasks'. */
function isOwnCodingWork(task: Task): boolean {
  return isCodingTask(task) && task.state !== "SPLIT";
}

export function isIncompleteCodingTask(task: Task, tasks: readonly Task[] = []): boolean {
  return isCodingTask(task) && !isAcceptableTerminalForDone(task, tasks);
}

export function isExhaustedCodingTask(task: Task, maxAttempts: number): boolean {
  return isCodingTask(task) && (
    task.state === "BLOCKED" ||
    (task.state === "INTEGRATION_FAILED" && task.attempts >= maxAttempts)
  );
}

export function isContinuableCodingWork(task: Task, maxAttempts: number, tasks: readonly Task[] = []): boolean {
  return isIncompleteCodingTask(task, tasks) && !isExhaustedCodingTask(task, maxAttempts);
}

export function hasContinuableCodingWork(tasks: readonly Task[], maxAttempts: number): boolean {
  return tasks.some((task) => isContinuableCodingWork(task, maxAttempts, tasks));
}

/**
 * Routing for remaining incomplete coding work after a successful integrate or at anti-fake.
 * `null` means every coding task is an acceptable DONE terminal.
 */
export function incompleteCodingWorkTerminal(
  tasks: readonly Task[],
  maxAttempts: number,
): "PLANNING" | "FAILED" | null {
  const incompletes = tasks.filter((task) => isIncompleteCodingTask(task, tasks));
  if (incompletes.length === 0) return null;
  return incompletes.some((task) => isContinuableCodingWork(task, maxAttempts, tasks)) ? "PLANNING" : "FAILED";
}

const CANDIDATE_WORKER_STATES = new Set<Candidate["state"]>([
  "IMPLEMENTED",
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

  const codingTasks = evidence.tasks.filter(isOwnCodingWork);
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

  if (missionSatisfiedWithoutChange(evidence.tasks)) return assertNoChangeProven(evidence, codingTasks);

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

/** Every coding task ended SATISFIED: its acceptance was shown to hold on its base, with no diff. */
export function missionSatisfiedWithoutChange(tasks: readonly Task[]): boolean {
  const coding = tasks.filter(isOwnCodingWork);
  return coding.length > 0 && coding.every((task) => task.state === "SATISFIED");
}

/**
 * The one way a change-required mission may end on its baseline: each coding task has a candidate
 * whose gates, run by the engine on that task's unchanged base, passed; the run never moved off the
 * baseline; and the unchanged code was still reviewed to the same standard as a diff would be.
 */
function assertNoChangeProven(evidence: MissionCompletionEvidence, codingTasks: readonly Task[]): MissionMayCompleteResult {
  for (const task of codingTasks) {
    const proof = evidence.candidates.some((candidate) =>
      candidate.taskId === task.id &&
      candidate.gateReport?.passed === true &&
      candidate.gateReport.gatedCommit === task.baseCheckpointHash);
    if (!proof) return fail(`no-change task ${task.id} has no passing gates on its base`);
  }
  if (evidence.checkpoints.some((checkpoint) => checkpoint.source === "integration")) {
    return fail("no-change mission has integrated code changes");
  }
  if (
    evidence.currentCheckpointHash !== null &&
    evidence.baselineCommitHash !== null &&
    evidence.currentCheckpointHash !== evidence.baselineCommitHash
  ) {
    return fail("no-change mission moved off its baseline checkpoint");
  }
  if (!evidence.reviewExecutions.some((execution) => execution.completed)) {
    return fail("no-change mission has no actual review executions");
  }
  if (
    evidence.currentCheckpointHash !== null &&
    !cleanRoundsHaveReviewProof(evidence.cleanRounds, evidence.currentCheckpointHash, evidence.reviewExecutions, evidence.requiredReviewers)
  ) {
    return fail("clean rounds lack completed review proof");
  }
  return { ok: true };
}

function fail(reason: string, terminal: "FAILED" | "NEEDS_HUMAN" | "PLANNING" = "FAILED"): MissionMayCompleteResult {
  return { ok: false, reason, terminal };
}
