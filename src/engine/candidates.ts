import type { CandidateWorker, CandidateWorkerFactory, WorkerOutcome } from "../agents/types.js";
import type { AcceptanceArtifact, MissionAcceptanceCorpus } from "../domain/acceptance.js";
import type { ArtifactRef, ModelRef } from "../domain/common.js";
import type { BaselineSnapshot } from "../domain/checks.js";
import type { ProtectedChangeScope, ProtectedChangeWaiver } from "../domain/protectedChangeWaiver.js";
import type { Task } from "../domain/task.js";
import type { CheckOutputPersister, GateResult } from "../project/checkRunner.js";
import { runIndependentGates } from "../project/checkRunner.js";
import type { ProjectProfile } from "../project/profile.js";
import type { CommandPolicy } from "../sandbox/allowlist.js";
import type { DiffStat } from "../sandbox/git.js";
import type { Sandbox, SandboxHandle } from "../sandbox/worktree.js";
import { errorToString } from "../shared/errors.js";
import { id } from "../shared/ids.js";

export type { CandidateWorker, CandidateWorkerFactory, WorkerOutcome } from "../agents/types.js";

/** Small deterministic worker useful to callers and tests before an AgentRunner is wired. */
export class ScriptedCandidateWorker<TTask = Task> implements CandidateWorker<TTask> {
  readonly model: ModelRef;

  constructor(
    private readonly script: (task: TTask, worktree: SandboxHandle) => WorkerOutcome | Promise<WorkerOutcome>,
    model: ModelRef = { provider: "scripted", model: "scripted-worker" },
  ) {
    this.model = model;
  }

  run(task: TTask, worktree: SandboxHandle): Promise<WorkerOutcome> {
    return Promise.resolve(this.script(task, worktree));
  }
}

export interface CandidateGates {
  profile: ProjectProfile;
  baseline: BaselineSnapshot;
  acceptanceArtifacts: readonly AcceptanceArtifact[];
  /**
   * `artifacts` is already the union of the task's own acceptance artifacts and the mission
   * corpus's admitted executables — `acceptanceArtifactsForGate` builds it once, at the gate
   * deps. These callbacks took a corpus argument and ignored it, which is why a corpus entry was
   * never injected.
   */
  verifyAcceptance: (
    checkoutDir: string,
    artifacts: readonly AcceptanceArtifact[],
  ) => { path: string; reason: string }[];
  materializeAcceptance: (
    checkoutDir: string,
    artifacts: readonly AcceptanceArtifact[],
  ) => void;
  persistOutput?: CheckOutputPersister;
  onCheckStart?: (info: { name: string; command: readonly string[] }) => void;
  protectedChangeWaivers?: readonly ProtectedChangeWaiver[];
  protectedChangeScope?: Omit<ProtectedChangeScope, "relativePath">;
  validateProtectedChangeWaiver?: (waiver: ProtectedChangeWaiver) => boolean;
}

export type CandidateResultStatus =
  | "implemented"
  | "passed"
  | "failed_gates"
  | "worker_failed"
  | "interrupted"
  | "no_changes"
  | "error";

export interface CandidateResult {
  id: string;
  index: number;
  model: ModelRef;
  branch: string;
  baseCheckpoint: string;
  headCommit: string | null;
  status: CandidateResultStatus;
  diffSummary: DiffStat;
  gateResult: GateResult | null;
  evidenceRefs: ArtifactRef[];
  workerOutcome: WorkerOutcome | null;
  error: string | null;
}

export interface RunCandidatesParallelInput<TTask = Task> {
  runId: string;
  task: TTask;
  baseCheckpoint: string;
  n: number;
  /**
   * Prefer `workerFactory` so each candidate gets a fresh worker (no shared transcript).
   * `worker` remains for tests; when both are set, `workerFactory` wins.
   */
  worker?: CandidateWorker<TTask>;
  workerFactory?: CandidateWorkerFactory<TTask>;
  sandbox: Sandbox;
  policy: CommandPolicy;
  gates: CandidateGates;
  corpus?: MissionAcceptanceCorpus;
  branchPrefix?: string;
  projectEnv?: Record<string, string>;
  signal?: AbortSignal;
  /** When true, stop after commit; gating runs in a later phase. */
  skipGates?: boolean;
  onWorkerStart?: (info: { candidateId: string; index: number; model: ModelRef }) => void;
}

/**
 * Execute isolated candidates concurrently from one immutable checkpoint, then gate each
 * resulting commit in a separate detached worktree.
 */
export async function runCandidatesParallel<TTask = Task>(
  input: RunCandidatesParallelInput<TTask>,
): Promise<CandidateResult[]> {
  if (!Number.isInteger(input.n) || input.n < 1) {
    throw new RangeError("candidate count must be a positive integer");
  }
  if (input.workerFactory === undefined && input.worker === undefined) {
    throw new RangeError("either workerFactory or worker must be provided");
  }
  return Promise.all(Array.from({ length: input.n }, (_, index) => runOneCandidate(input, index)));
}

async function runOneCandidate<TTask>(
  input: RunCandidatesParallelInput<TTask>,
  index: number,
): Promise<CandidateResult> {
  const candidateId = id("cand");
  const branch = `${input.branchPrefix ?? `polish/${input.runId}/candidates`}/${candidateId}`;
  let candidate: SandboxHandle | null = null;
  let gate: SandboxHandle | null = null;
  let workerOutcome: WorkerOutcome | null = null;
  let headCommit: string | null = null;
  let diffSummary = emptyDiffStat();

  // Resolved before the sandbox: a sandbox failure must still name the model that would have
  // run this candidate, and `Candidate.model` has no nullable form to fall back to.
  const worker = input.workerFactory?.(index) ?? input.worker;
  if (worker === undefined) {
    throw new RangeError("either workerFactory or worker must be provided");
  }
  const model = worker.model;

  try {
    candidate = await input.sandbox.create({
      id: candidateId,
      baseCommit: input.baseCheckpoint,
      branch,
      policy: input.policy,
      ...(input.projectEnv === undefined ? {} : { projectEnv: input.projectEnv }),
    });
    input.onWorkerStart?.({ candidateId, index, model });
    workerOutcome = await worker.run(input.task, candidate);
    if (workerOutcome.status !== "completed") {
      return result({
        candidateId,
        index,
        model,
        branch,
        baseCheckpoint: input.baseCheckpoint,
        status: workerOutcome.status === "interrupted" ? "interrupted" : "worker_failed",
        workerOutcome,
        error: workerOutcome.error ?? null,
      });
    }

    const committed = await candidate.commitAll(`polish: candidate ${candidateId}`);
    headCommit = committed ?? await candidate.headCommit();
    if (headCommit === input.baseCheckpoint) {
      return result({
        candidateId,
        index,
        model,
        branch,
        baseCheckpoint: input.baseCheckpoint,
        status: "no_changes",
        workerOutcome,
      });
    }

    diffSummary = await candidate.git.diffStat(input.baseCheckpoint, headCommit);
    if (input.skipGates === true) {
      return {
        id: candidateId,
        index,
        model,
        branch,
        baseCheckpoint: input.baseCheckpoint,
        headCommit,
        status: "implemented",
        diffSummary,
        gateResult: null,
        evidenceRefs: workerEvidence(workerOutcome),
        workerOutcome,
        error: null,
      };
    }
    gate = await input.sandbox.create({
      id: `${candidateId}-gate`,
      baseCommit: headCommit,
      policy: input.policy,
      ...(input.projectEnv === undefined ? {} : { projectEnv: input.projectEnv }),
    });
    const gateResult = await runGates({
      runId: input.runId,
      commitHash: headCommit,
      sandbox: gate,
      gates: input.gates,
      ...(input.corpus === undefined ? {} : { corpus: input.corpus }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return {
      id: candidateId,
      index,
      model,
      branch,
      baseCheckpoint: input.baseCheckpoint,
      headCommit,
      status: gateResult.passed ? "passed" : "failed_gates",
      diffSummary,
      gateResult,
      evidenceRefs: collectEvidence(workerOutcome, gateResult),
      workerOutcome,
      error: null,
    };
  } catch (error) {
    return {
      id: candidateId,
      index,
      model,
      branch,
      baseCheckpoint: input.baseCheckpoint,
      headCommit,
      status: "error",
      diffSummary,
      gateResult: null,
      evidenceRefs: workerOutcome === null ? [] : workerEvidence(workerOutcome),
      workerOutcome,
      error: errorToString(error),
    };
  } finally {
    await destroyQuietly(gate);
    await destroyQuietly(candidate);
  }
}

export async function runGates(input: {
  runId: string;
  commitHash: string;
  sandbox: SandboxHandle;
  gates: CandidateGates;
  corpus?: MissionAcceptanceCorpus;
  signal?: AbortSignal;
}): Promise<GateResult> {
  return runIndependentGates({
    runId: input.runId,
    commitHash: input.commitHash,
    sandbox: input.sandbox,
    profile: input.gates.profile,
    acceptanceArtifacts: input.gates.acceptanceArtifacts,
    verifyAcceptance: input.gates.verifyAcceptance,
    materializeAcceptance: input.gates.materializeAcceptance,
    baseline: input.gates.baseline,
    ...(input.corpus === undefined ? {} : { acceptanceCorpus: input.corpus }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.gates.persistOutput === undefined ? {} : { persistOutput: input.gates.persistOutput }),
    ...(input.gates.onCheckStart === undefined ? {} : { onCheckStart: input.gates.onCheckStart }),
    ...(input.gates.protectedChangeWaivers === undefined
      ? {}
      : { protectedChangeWaivers: input.gates.protectedChangeWaivers }),
    ...(input.gates.protectedChangeScope === undefined
      ? {}
      : { protectedChangeScope: input.gates.protectedChangeScope }),
    ...(input.gates.validateProtectedChangeWaiver === undefined
      ? {}
      : { validateProtectedChangeWaiver: input.gates.validateProtectedChangeWaiver }),
  });
}

function result(input: {
  candidateId: string;
  index: number;
  model: ModelRef;
  branch: string;
  baseCheckpoint: string;
  status: CandidateResultStatus;
  workerOutcome: WorkerOutcome;
  error?: string | null;
}): CandidateResult {
  return {
    id: input.candidateId,
    index: input.index,
    model: input.model,
    branch: input.branch,
    baseCheckpoint: input.baseCheckpoint,
    headCommit: null,
    status: input.status,
    diffSummary: emptyDiffStat(),
    gateResult: null,
    evidenceRefs: workerEvidence(input.workerOutcome),
    workerOutcome: input.workerOutcome,
    error: input.error ?? null,
  };
}

function workerEvidence(outcome: WorkerOutcome): ArtifactRef[] {
  return [
    ...(outcome.evidenceRefs ?? []),
    ...(outcome.transcriptRef === undefined || outcome.transcriptRef === null ? [] : [outcome.transcriptRef]),
  ];
}

function collectEvidence(outcome: WorkerOutcome, gates: GateResult): ArtifactRef[] {
  return [
    ...workerEvidence(outcome),
    ...gates.checks.flatMap((check) => check.outputRef === null ? [] : [check.outputRef]),
  ];
}

function emptyDiffStat(): DiffStat {
  return { files: 0, insertions: 0, deletions: 0 };
}

async function destroyQuietly(handle: SandboxHandle | null): Promise<void> {
  if (handle === null) return;
  try {
    await handle.destroy();
  } catch {
    // Cleanup must not replace a candidate result.
  }
}
