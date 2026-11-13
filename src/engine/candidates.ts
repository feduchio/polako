import { BRAND } from "../shared/brand.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CandidateWorker, CandidateWorkerFactory, WorkerOutcome } from "../agents/types.js";
import type { AcceptanceArtifact, MissionAcceptanceCorpus } from "../domain/acceptance.js";
import type { ArtifactRef, ModelRef } from "../domain/common.js";
import type { BaselineSnapshot } from "../domain/checks.js";
import { DEFAULT_INSTALL_DEPENDENCIES, DEFAULT_INSTALL_TIMEOUT_MS } from "../domain/config.js";
import type { ProtectedChangeScope, ProtectedChangeWaiver } from "../domain/protectedChangeWaiver.js";
import { pathsNamedByAcceptance, type Task } from "../domain/task.js";
import type { CheckOutputPersister, DependencyPreparation, EnsureDependenciesResult, GateResult } from "../project/checkRunner.js";
import { ensureProjectDependencies, runIndependentGates } from "../project/checkRunner.js";
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
  /**
   * The operator's setting for preparing a gate checkout, which is a fresh worktree and so needs
   * the project's dependencies for the same reason the baseline does.
   *
   * Omitting it does **not** skip preparation — `runChecks` prepares with defaults either way.
   * This field only carries the configured values, so losing it loses the setting, not the step.
   * Finding 54.
   */
  prepareDependencies?: { enabled: boolean; timeoutMs: number; cacheDir?: string };
  /** Fired before the install command runs, so a crash mid-install still leaves a record. */
  onDependencyInstallStart?: (info: { command: readonly string[]; timeoutMs: number }) => void;
  onDependencyInstall?: (result: EnsureDependenciesResult) => void;
}

export type CandidateResultStatus =
  | "implemented"
  | "passed"
  | "failed_gates"
  | "worker_failed"
  | "interrupted"
  | "no_changes"
  /** No diff, the worker claimed its acceptance already holds, and the engine's gates on the base agreed. */
  | "no_change_verified"
  /** The worker asked for the task to be split; nothing is committed and nothing is gated. */
  | "needs_split"
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
  const branch = `${input.branchPrefix ?? `${BRAND.branchPrefix}/${input.runId}/candidates`}/${candidateId}`;
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
    // A worker's own worktree is the fourth sandbox, and finding 54 prepared only the three that
    // run project checks. An unprepared one cannot run the project's test command, so a worker
    // that writes a test sees a module-resolution error instead of a verdict and keeps going until
    // its token allowance is gone. Preparation is not fatal here: the gate checkout prepares
    // itself, so a worker can still produce a candidate. The result is reported so a failure to
    // prepare is on the record rather than inferred from the worker's confusion.
    await prepareWorkerCheckout(candidate, input.gates, input.signal);
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
    if (workerOutcome.split !== undefined) {
      return result({
        candidateId,
        index,
        model,
        branch,
        baseCheckpoint: input.baseCheckpoint,
        status: "needs_split",
        workerOutcome,
        error: `needs_split: ${workerOutcome.split.reason}`,
      });
    }

    const committed = await candidate.commitAll(`polish: candidate ${candidateId}`);
    headCommit = committed ?? await candidate.headCommit();
    if (headCommit === input.baseCheckpoint) {
      if (workerOutcome.noChange === undefined) {
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
      gate = await input.sandbox.create({
        id: `${candidateId}-gate`,
        baseCommit: input.baseCheckpoint,
        policy: input.policy,
        ...(input.projectEnv === undefined ? {} : { projectEnv: input.projectEnv }),
      });
      const gateResult = await runGates({
        runId: input.runId,
        commitHash: input.baseCheckpoint,
        sandbox: gate,
        gates: input.gates,
        ...(input.corpus === undefined ? {} : { corpus: input.corpus }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      const verdict = noChangeVerdict(gateResult, input.gates.profile) ??
        (hasAcceptance(input.task) ? await acceptanceOnBase(input.task, gate, input.policy, input.signal) : null);
      return {
        id: candidateId,
        index,
        model,
        branch,
        baseCheckpoint: input.baseCheckpoint,
        headCommit: input.baseCheckpoint,
        status: verdict === null ? "no_change_verified" : "no_changes",
        diffSummary,
        gateResult,
        evidenceRefs: collectEvidence(workerOutcome, gateResult),
        workerOutcome,
        error: verdict,
      };
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

/**
 * Whether gates on the unchanged base prove a no-change claim; null if they do, else why not.
 *
 * `passed` alone is not enough: it is judged against the baseline, and a check that failed there
 * and still fails here is not a regression. For "nothing needed changing" every check has to pass
 * outright, and there has to be at least one — no checks is no evidence.
 */
export function noChangeVerdict(gate: GateResult, profile: ProjectProfile): string | null {
  if (!gate.passed) return "gates on the unchanged base did not pass";
  const mandatory = new Set(profile.checks.filter((check) => check.mandatory).map((check) => check.name));
  const ran = gate.checks.filter((check) => check.status !== "skipped");
  if (ran.length === 0) return "no check ran on the unchanged base, so nothing shows the acceptance holds";
  const failing = gate.checks.filter((check) =>
    check.status === "skipped" ? mandatory.has(check.name) : check.status !== "pass");
  if (failing.length > 0) {
    return `checks do not pass on the unchanged base: ${failing.map((check) => `${check.name}=${check.status}`).join(", ")}`;
  }
  return null;
}

const ACCEPTANCE_CHECK_TIMEOUT_MS = 120_000;

function hasAcceptance(task: unknown): task is Pick<Task, "acceptance" | "acceptanceChecks"> {
  return typeof task === "object" && task !== null && Array.isArray((task as { acceptance?: unknown }).acceptance);
}

/**
 * Whether the task's own acceptance holds on the unchanged base; null if it does, else why not.
 * Passing gates show the project still works, not that this task's criterion was already met: a
 * mission to add a file ended `no_change_required` with the file absent (council round 4, S8).
 */
export async function acceptanceOnBase(
  task: Pick<Task, "acceptance" | "acceptanceChecks">,
  checkout: SandboxHandle,
  policy: CommandPolicy,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  const present = (path: string) => existsSync(resolve(checkout.path, path));
  for (const path of pathsNamedByAcceptance(task.acceptance)) {
    if (!present(path)) return `the task's acceptance names ${path}, which is absent on the unchanged base`;
  }
  for (const check of task.acceptanceChecks ?? []) {
    if (check.kind !== "command" && !present(check.path)) return `acceptance check ${check.kind} ${check.path}: absent on the unchanged base`;
    if (check.kind === "file_exists") continue;
    const argv = check.kind === "command" ? check.argv : policy.testFileCommand(check.path);
    if (argv === null) return `acceptance check ${check.kind}: the project has no command that runs one test file`;
    const refused = policy.check(argv);
    if (refused !== null) return `acceptance check \`${argv.join(" ")}\` is refused by the command policy: ${refused}`;
    const result = await checkout.run(argv, { timeoutMs: ACCEPTANCE_CHECK_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) });
    if (result.exitCode !== 0) return `acceptance check \`${argv.join(" ")}\` exits ${String(result.exitCode)} on the unchanged base`;
  }
  return null;
}

/**
 * Re-exported where the gate paths already look for it. It is defined in `project/checkRunner.ts`
 * because that is what throws it — `runChecks` refuses there, so a gate checkout, an integration
 * workspace and a baseline all get the same refusal without engine having to agree to it.
 */
export { EnvironmentNotReadyError } from "../project/checkRunner.js";

/**
 * Prepare the checkout a worker is handed. Same command definition and same operator settings as
 * a gate checkout, because it is the same kind of fresh worktree; it differs only in that nothing
 * downstream refuses when it is not ready, so the result is reported instead of thrown.
 */
export async function prepareWorkerCheckout(
  checkout: SandboxHandle,
  gates: CandidateGates,
  signal: AbortSignal | undefined,
): Promise<void> {
  try {
    const result = await ensureProjectDependencies(checkout, gates.profile, {
      enabled: gates.prepareDependencies?.enabled ?? DEFAULT_INSTALL_DEPENDENCIES,
      timeoutMs: gates.prepareDependencies?.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
      ...(gates.onDependencyInstallStart === undefined ? {} : { onStart: gates.onDependencyInstallStart }),
      ...(gates.prepareDependencies?.cacheDir === undefined ? {} : { cacheDir: gates.prepareDependencies.cacheDir }),
    });
    gates.onDependencyInstall?.(result);
  } catch (error) {
    gates.onDependencyInstall?.({ attempted: true, ready: false, detail: errorToString(error) });
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
  const prepareDependencies: DependencyPreparation = {
    ...input.gates.prepareDependencies,
    ...(input.gates.onDependencyInstallStart === undefined ? {} : { onStart: input.gates.onDependencyInstallStart }),
    ...(input.gates.onDependencyInstall === undefined ? {} : { onResult: input.gates.onDependencyInstall }),
  };
  return runIndependentGates({
    prepareDependencies,
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
