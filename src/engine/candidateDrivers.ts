import type { CandidateWorkerFactory } from "../agents/types.js";
import type { MissionAcceptanceCorpus } from "../domain/acceptance.js";
import { runtimeAllowsDone } from "../domain/acceptance.js";
import type { GateReport, Candidate, CandidateState } from "../domain/candidate.js";
import type { GateFailureReason } from "../domain/candidate.js";
import { emptyFindingCounts, type Checkpoint, type EvidenceVector } from "../domain/checkpoint.js";
import { SYSTEM_ACTOR } from "../domain/common.js";
import type { PolishConfig } from "../domain/config.js";
import type { NewEvent } from "../domain/event.js";
import type { GateResult } from "../project/checkRunner.js";
import { createCheckOutputPersister } from "../project/checkRunner.js";
import type { ProjectProfile } from "../project/profile.js";
import { discoverRuntimeValidator } from "../runtime/discovery.js";
import { bindNodeScenario, rerunRuntimeScenarios, templatesFromCorpus } from "../runtime/corpus.js";
import type { RuntimeValidator } from "../runtime/types.js";
import type { CommandPolicy } from "../sandbox/allowlist.js";
import type { Sandbox } from "../sandbox/worktree.js";
import { id } from "../shared/ids.js";
import { ProtectedChangeWaiverService } from "../store/protectedChangeWaivers.js";
import type { Task } from "../domain/task.js";
import {
  runCandidatesParallel,
  runGates,
  type CandidateGates,
  type CandidateResult,
} from "./candidates.js";
import { GitBranchRunHead, integrateWinner, type RunHead } from "./integration.js";
import type { PhaseContext, PhaseDriver } from "./types.js";

export interface CandidateDriverOptions {
  sandbox: Sandbox | ((ctx: PhaseContext) => Sandbox | Promise<Sandbox>);
  policy: CommandPolicy | ((ctx: PhaseContext) => CommandPolicy | Promise<CommandPolicy>);
  workerFactory: (ctx: PhaseContext) => CandidateWorkerFactory;
  resolveProfile?: (ctx: PhaseContext) => ProjectProfile | Promise<ProjectProfile>;
  resolveGates?: (ctx: PhaseContext, task: Task) => CandidateGates | Promise<CandidateGates>;
  resolveRunHead?: (ctx: PhaseContext) => RunHead | Promise<RunHead>;
  runtimeValidators?: readonly RuntimeValidator[] | ((ctx: PhaseContext) => readonly RuntimeValidator[]);
  resolveCorpus?: (ctx: PhaseContext) => MissionAcceptanceCorpus | undefined | Promise<MissionAcceptanceCorpus | undefined>;
}

/** Test helper: mark the first passed candidate as the integration winner. Not a production tournament. */
export function pickFirstPassedCandidate(ctx: PhaseContext, taskId: string): Candidate | null {
  const passed = ctx.store.repos.candidates
    .listByTask(taskId)
    .filter((candidate) => candidate.state === "PASSED_GATES");
  return passed[0] ?? null;
}

/** Test helper: persist winner selection for INTEGRATING without implementing B3 tournament metrics. */
export function seedWinnerForTests(ctx: PhaseContext, taskId: string, candidateId: string): void {
  const task = ctx.store.repos.tasks.get(taskId);
  const candidate = ctx.store.repos.candidates.get(candidateId);
  if (task === null || candidate?.taskId !== taskId) return;
  const now = ctx.clock.now();
  const winner: Candidate = { ...candidate, state: "WINNER", updatedAt: now };
  const selected: Task = {
    ...task,
    state: "QUEUED_FOR_INTEGRATION",
    selectedCandidateId: candidateId,
    updatedAt: now,
  };
  appendCandidateEvents(ctx, [winner], "candidate.state_changed");
  appendTaskEvent(ctx, selected);
}

/** Production EXECUTING driver: parallel isolated worktrees from the task base checkpoint. */
export function createExecutingDriver(options: CandidateDriverOptions): PhaseDriver {
  return async (ctx) => {
    const task = activeCodingTask(ctx);
    if (task === null) return { status: "waiting" };
    const existing = ctx.store.repos.candidates.listByTask(task.id);
    if (existing.some((candidate) => candidate.state === "IMPLEMENTED")) {
      return { status: "complete", nextPhase: "GATING" };
    }
    const inflight = existing.filter((candidate) =>
      candidate.state === "CREATED" ||
      candidate.state === "IMPLEMENTING" ||
      candidate.state === "GATING" ||
      candidate.state === "INTERRUPTED",
    );
    if (inflight.length > 0) return { status: "waiting" };

    const running = task.state === "READY"
      ? patchTask(ctx, { ...task, state: "RUNNING", attempts: task.attempts + 1, updatedAt: ctx.clock.now() })
      : task;
    if (running.state !== "RUNNING") return { status: "waiting" };

    const baseCheckpoint = running.baseCheckpointHash;
    const n = candidateCount(ctx.config, running.complexity);
    const sandbox = await resolveValue(options.sandbox, ctx);
    const policy = await resolveValue(options.policy, ctx);
    const workerFactory = options.workerFactory(ctx);
    const gates = await resolveGates(ctx, options, running);
    const corpus = await resolveCorpus(ctx, options);
    const results = await runCandidatesParallel({
      runId: ctx.run.id,
      task: running,
      baseCheckpoint,
      n,
      workerFactory,
      sandbox,
      policy,
      skipGates: true,
      gates,
      ...(corpus === undefined ? {} : { corpus }),
    });

    const candidates = results.map((result, index) => toCandidate(ctx, running, result, index));
    appendCandidateEvents(ctx, candidates, "candidate.created");
    for (const candidate of candidates) {
      appendCandidateEvents(ctx, [candidate], "candidate.state_changed");
    }
    appendTaskEvent(ctx, { ...running, state: "GATED", updatedAt: ctx.clock.now() });
    return { status: "complete", nextPhase: "GATING" };
  };
}

/** Production GATING driver: independent gates on clean evaluation checkouts. */
export function createGatingDriver(options: CandidateDriverOptions): PhaseDriver {
  return async (ctx) => {
    const task = gatedTask(ctx);
    if (task === null) return { status: "waiting" };
    const pending = ctx.store.repos.candidates
      .listByTask(task.id)
      .filter((candidate) => candidate.state === "IMPLEMENTED");
    if (pending.length === 0) {
      const survivors = passedCandidates(ctx, task.id);
      if (survivors.length === 0) return handleZeroSurvivors(ctx, task);
      return { status: "complete", nextPhase: "COMPARING" };
    }

    const sandbox = await resolveValue(options.sandbox, ctx);
    const policy = await resolveValue(options.policy, ctx);
    const gates = await resolveGates(ctx, options, task);
    const corpus = await resolveCorpus(ctx, options);
    const gated: Candidate[] = [];
    for (const candidate of pending) {
      const headCommit = candidate.headCommit;
      if (headCommit === null) continue;
      const checkout = await sandbox.create({
        id: `${candidate.id}-gate`,
        baseCommit: headCommit,
        policy,
      });
      try {
        const gateResult = await runGates({
          runId: ctx.run.id,
          commitHash: headCommit,
          sandbox: checkout,
          gates,
          ...(corpus === undefined ? {} : { corpus }),
        });
        gated.push(applyGateResult(ctx, candidate, headCommit, gateResult));
      } finally {
        await checkout.destroy().catch(() => undefined);
      }
    }
    appendCandidateEvents(ctx, gated, "candidate.gated");
    const survivors = passedCandidates(ctx, task.id);
    if (survivors.length === 0) return handleZeroSurvivors(ctx, task);
    return { status: "complete", nextPhase: "COMPARING" };
  };
}

/** Production INTEGRATING driver: serial temporary workspace, gates, checkpoint CAS. */
export function createIntegratingDriver(options: CandidateDriverOptions): PhaseDriver {
  return async (ctx) => {
    const task = integrationTask(ctx);
    if (task?.selectedCandidateId == null) return { status: "waiting" };
    const winner = ctx.store.repos.candidates.get(task.selectedCandidateId);
    if (winner?.headCommit == null) return { status: "waiting" };

    const integrating = patchTask(ctx, { ...task, state: "INTEGRATING", updatedAt: ctx.clock.now() });
    const startedId = appendIntegrationEvent(ctx, "integration.started", {
      taskId: integrating.id,
      candidateId: winner.id,
      winnerCommit: winner.headCommit,
      runHead: ctx.run.currentCheckpointHash,
    });

    const sandbox = await resolveValue(options.sandbox, ctx);
    const policy = await resolveValue(options.policy, ctx);
    const gates = await resolveGates(ctx, options, integrating);
    const corpus = await resolveCorpus(ctx, options);
    const runHead = await (options.resolveRunHead ?? defaultRunHead)(ctx);
    const result = await integrateWinner({
      runId: ctx.run.id,
      winnerCommit: winner.headCommit,
      sandbox,
      policy,
      gates,
      runHead,
      ...(corpus === undefined ? {} : { corpus }),
      afterGates: ({ commitHash, workspace }) =>
        validateRuntimeIfNeeded(ctx, options, commitHash, workspace.path),
    });

    const integrated = result.advanced && result.status === "integrated";
    appendIntegrationEvent(ctx, "integration.finished", {
      taskId: integrating.id,
      candidateId: winner.id,
      status: integrated ? "pass" : result.status,
      advanced: integrated,
      previousHead: result.previousHead,
      integratedCommit: result.integratedCommit,
    }, [startedId]);

    if (!integrated) {
      const failed = patchTask(ctx, {
        ...integrating,
        state: "INTEGRATION_FAILED",
        updatedAt: ctx.clock.now(),
      });
      const retry = failed.attempts < ctx.config.retry.maxAttempts;
      return { status: "complete", nextPhase: retry ? "PLANNING" : "FAILED" };
    }

    const integratedCommit = result.integratedCommit;
    const gateResult = result.gateResult;
    if (integratedCommit === null || gateResult === null) {
      return { status: "complete", nextPhase: "FAILED" };
    }

    const checkpoint = createCheckpoint(ctx, integrating, integratedCommit, gateResult, result.previousHead);
    appendCheckpoint(ctx, checkpoint);
    appendRunCheckpoint(ctx, checkpoint.commitHash);
    appendTaskEvent(ctx, {
      ...integrating,
      state: "INTEGRATED",
      baseCheckpointHash: checkpoint.commitHash,
      updatedAt: ctx.clock.now(),
    });
    return { status: "complete", nextPhase: "REVIEWING" };
  };
}

function activeCodingTask(ctx: PhaseContext): Task | null {
  const tasks = ctx.store.repos.tasks
    .listByRun(ctx.run.id)
    .filter((task) => task.touchesProductCode && !terminalTask(task));
  const running = tasks.find((task) => task.state === "RUNNING");
  if (running !== undefined) return running;
  return tasks.find((task) => task.state === "READY" && dependenciesMet(ctx, task)) ?? null;
}

function gatedTask(ctx: PhaseContext): Task | null {
  return ctx.store.repos.tasks.listByRun(ctx.run.id).find((task) => task.state === "GATED") ?? null;
}

function integrationTask(ctx: PhaseContext): Task | null {
  return ctx.store.repos.tasks
    .listByRun(ctx.run.id)
    .find((task) => task.state === "QUEUED_FOR_INTEGRATION" || task.state === "SELECTED") ?? null;
}

function terminalTask(task: Task): boolean {
  return task.state === "INTEGRATED" || task.state === "REJECTED" || task.state === "CANCELLED";
}

function dependenciesMet(ctx: PhaseContext, task: Task): boolean {
  if (task.dependsOn.length === 0) return true;
  return task.dependsOn.every((dependencyId) => ctx.store.repos.tasks.get(dependencyId)?.state === "INTEGRATED");
}

function candidateCount(config: PolishConfig, complexity: Task["complexity"]): number {
  return config.candidates[complexity];
}

function passedCandidates(ctx: PhaseContext, taskId: string): Candidate[] {
  return ctx.store.repos.candidates.listByTask(taskId).filter((candidate) => candidate.state === "PASSED_GATES");
}

function handleZeroSurvivors(ctx: PhaseContext, task: Task): { status: "complete"; nextPhase: "PLANNING" | "FAILED" } {
  const attempts = task.attempts;
  const retry = attempts < ctx.config.retry.maxAttempts;
  const nextState: Task["state"] = retry ? "READY" : "BLOCKED";
  appendTaskEvent(ctx, { ...task, state: nextState, updatedAt: ctx.clock.now() });
  return { status: "complete", nextPhase: retry ? "PLANNING" : "FAILED" };
}

function toCandidate(ctx: PhaseContext, task: Task, result: CandidateResult, index: number): Candidate {
  const now = ctx.clock.now();
  const state = resultStatusToCandidateState(result);
  const gateReport = result.status === "no_changes" ? noChangesGateReport(result, now) : null;
  return {
    id: result.id,
    runId: ctx.run.id,
    taskId: task.id,
    attempt: task.attempts,
    model: { provider: "worker", model: `candidate-${index}` },
    baseCheckpointHash: result.baseCheckpoint,
    branch: result.branch,
    worktreePath: null,
    headCommit: result.headCommit,
    state: gateReport === null ? state : "FAILED_GATES",
    gateReport,
    transcriptRef: result.workerOutcome?.transcriptRef ?? null,
    diffRef: null,
    createdAt: now,
    updatedAt: now,
  };
}

function resultStatusToCandidateState(result: CandidateResult): CandidateState {
  switch (result.status) {
    case "implemented":
      return "IMPLEMENTED";
    case "passed":
      return "PASSED_GATES";
    case "failed_gates":
    case "no_changes":
      return "FAILED_GATES";
    case "interrupted":
      return "INTERRUPTED";
    case "worker_failed":
    case "error":
      return "DISCARDED";
    default:
      return "DISCARDED";
  }
}

function applyGateResult(ctx: PhaseContext, candidate: Candidate, headCommit: string, gateResult: GateResult): Candidate {
  const gateReport = toGateReport(headCommit, gateResult, ctx.clock.now());
  return {
    ...candidate,
    state: gateResult.passed ? "PASSED_GATES" : "FAILED_GATES",
    gateReport,
    updatedAt: ctx.clock.now(),
  };
}

function toGateReport(commitHash: string, gate: GateResult, createdAt: number): GateReport {
  const failures: { reason: GateFailureReason; detail: string }[] = [];
  if (gate.candidateProtectedPathProblems.length > 0) {
    for (const problem of gate.candidateProtectedPathProblems) {
      failures.push({ reason: "protected_path_modified", detail: `${problem.path}: ${problem.reason}` });
    }
  }
  if (gate.acceptanceProblems.length > 0) {
    for (const problem of gate.acceptanceProblems) {
      failures.push({ reason: "config_weakened", detail: `${problem.path}: ${problem.reason}` });
    }
  }
  if (gate.silencing.length > 0) {
    for (const finding of gate.silencing) {
      failures.push({ reason: "test_silencing_detected", detail: `${finding.path}: ${finding.detail}` });
    }
  }
  if (gate.regression.newlyFailing.length > 0 || gate.regression.degradedChecks.length > 0) {
    failures.push({
      reason: "regression_vs_baseline",
      detail: [...gate.regression.newlyFailing, ...gate.regression.degradedChecks].join(", "),
    });
  }
  for (const check of gate.checks) {
    if (check.status !== "pass") {
      failures.push({ reason: "mandatory_check_failed", detail: `${check.name}: ${check.status}` });
    }
  }
  return {
    gatedCommit: commitHash,
    checks: gate.checks,
    injectedAcceptance: [],
    failures,
    passed: gate.passed,
    diffStat: { files: 0, insertions: 0, deletions: 0 },
    createdAt,
  };
}

function noChangesGateReport(result: CandidateResult, createdAt: number): GateReport {
  return {
    gatedCommit: result.baseCheckpoint,
    checks: [],
    injectedAcceptance: [],
    failures: [{ reason: "no_changes", detail: "candidate produced no diff vs base checkpoint" }],
    passed: false,
    diffStat: result.diffSummary,
    createdAt,
  };
}

function evidenceFromGate(gate: GateResult): EvidenceVector {
  const gates: EvidenceVector["gates"] = {};
  for (const check of gate.checks) gates[check.name] = check.status;
  const tests = gate.checks.filter((check) => check.kind === "test");
  return {
    gates,
    testsPassed: tests.filter((check) => check.status === "pass").length,
    testsFailed: tests.filter((check) => check.status === "fail" || check.status === "error" || check.status === "timeout").length,
    testsTotal: tests.length,
    openValidatedFindings: emptyFindingCounts(),
    diffLinesFromBaseline: gate.checks.reduce((sum, check) => sum + (check.summary?.total ?? 0), 0),
  };
}

function createCheckpoint(
  ctx: PhaseContext,
  task: Task,
  commitHash: string,
  gateResult: GateResult,
  previousHead: string,
): Checkpoint {
  const latest = ctx.store.repos.checkpoints.latest(ctx.run.id);
  const parent = latest?.commitHash === previousHead ? latest.id : latest?.id ?? null;
  const seq = (latest?.seq ?? -1) + 1;
  return {
    id: id("cp", ctx.clock.now()),
    runId: ctx.run.id,
    seq,
    commitHash,
    parentId: parent,
    source: "integration",
    taskId: task.id,
    evidence: evidenceFromGate(gateResult),
    createdAt: ctx.clock.now(),
  };
}

async function validateRuntimeIfNeeded(
  ctx: PhaseContext,
  options: CandidateDriverOptions,
  integratedCommit: string,
  checkoutDir: string,
): Promise<boolean> {
  const mode = ctx.config.runtimeValidation.mode;
  if (mode === "off") return true;
  const validators = await resolveValue(options.runtimeValidators ?? [], ctx);
  if (validators.length === 0) return mode !== "required";
  const templates = templatesFromCorpus(ctx.store.repos.acceptanceCorpus.forMission(ctx.run.missionId));
  if (templates.length === 0) return mode !== "required";
  const first = templates[0];
  if (first === undefined) return mode !== "required";
  const scenario = bindNodeScenario({
    template: first,
    projectPath: checkoutDir,
    runId: ctx.run.id,
    checkpointHash: integratedCommit,
  });
  const selection = await discoverRuntimeValidator(mode, scenario, validators);
  if (selection.validator === null) return mode !== "required";
  const evidences = await rerunRuntimeScenarios({
    templates,
    projectPath: checkoutDir,
    runId: ctx.run.id,
    checkpointHash: integratedCommit,
    validator: selection.validator,
    level: ctx.config.runtimeValidation.level,
  });
  return evidences.every((evidence) => runtimeAllowsDone(mode, evidence, integratedCommit));
}

async function resolveGates(ctx: PhaseContext, options: CandidateDriverOptions, task: Task): Promise<CandidateGates> {
  if (options.resolveGates !== undefined) return options.resolveGates(ctx, task);
  const profile = await (options.resolveProfile ?? defaultProfile)(ctx);
  const baseline = ctx.store.repos.baselines.listByRun(ctx.run.id)[0];
  if (baseline === undefined) throw new Error("baseline missing for candidate gates");
  const waiverService = new ProtectedChangeWaiverService({ events: ctx.store.events }, ctx.clock);
  return {
    profile,
    baseline,
    acceptanceArtifacts: ctx.store.repos.acceptance.forTask(ctx.run.id, task.id),
    materializeAcceptance: (checkoutDir, artifacts, corpus) => {
      if (corpus === undefined) ctx.store.acceptance.materialize(checkoutDir, artifacts);
      else ctx.store.acceptance.materialize(checkoutDir, artifacts);
    },
    verifyAcceptance: (checkoutDir, artifacts) => ctx.store.acceptance.verify(checkoutDir, artifacts),
    persistOutput: createCheckOutputPersister(ctx.store.artifacts),
    protectedChangeWaivers: ctx.store.repos.protectedChangeWaivers.listByRun(ctx.run.id),
    protectedChangeScope: {
      runId: ctx.run.id,
      missionId: ctx.run.missionId,
      taskId: task.id,
      requirementId: task.origin.kind === "mission_requirement" ? task.origin.requirementRef : task.id,
      baseCheckpointHash: task.baseCheckpointHash,
      findingKind: "protected_path_modified",
    },
    validateProtectedChangeWaiver: (waiver) => waiverService.isValidated(waiver),
  };
}

function defaultProfile(ctx: PhaseContext): ProjectProfile {
  return {
    projectPath: ctx.run.projectPath,
    alias: null,
    packageManager: "pnpm",
    framework: "vitest",
    checks: [{ name: "test", kind: "test", command: ["pnpm", "test"], mandatory: true }],
    manifestHashes: {},
    scriptsHash: "0".repeat(64),
    discoveredAt: ctx.clock.now(),
  };
}

function defaultRunHead(ctx: PhaseContext): RunHead {
  return new GitBranchRunHead(ctx.run.projectPath, ctx.run.runBranch);
}

async function resolveValue<T>(value: T | ((ctx: PhaseContext) => T | Promise<T>), ctx: PhaseContext): Promise<T> {
  return typeof value === "function" ? (value as (ctx: PhaseContext) => T | Promise<T>)(ctx) : value;
}

async function resolveCorpus(
  ctx: PhaseContext,
  options: CandidateDriverOptions,
): Promise<MissionAcceptanceCorpus | undefined> {
  if (options.resolveCorpus === undefined) return undefined;
  return options.resolveCorpus(ctx);
}

function appendCandidateEvents(ctx: PhaseContext, candidates: Candidate[], type: "candidate.created" | "candidate.state_changed" | "candidate.gated"): void {
  const events: NewEvent[] = candidates.map((candidate) => ({
    id: id("evt", ctx.clock.now()),
    runId: ctx.run.id,
    ts: ctx.clock.now(),
    type,
    payload: { candidate },
    causedBy: [],
    actor: { kind: "worker", model: candidate.model },
    artifacts: [],
  }));
  if (events.length > 0) ctx.store.events.append(events);
}

function appendTaskEvent(ctx: PhaseContext, task: Task): void {
  ctx.store.events.append([{
    id: id("evt", ctx.clock.now()),
    runId: ctx.run.id,
    ts: ctx.clock.now(),
    type: "task.state_changed",
    payload: { task },
    causedBy: [],
    actor: SYSTEM_ACTOR,
    artifacts: [],
  }]);
}

function patchTask(ctx: PhaseContext, task: Task): Task {
  appendTaskEvent(ctx, task);
  return task;
}

function appendCheckpoint(ctx: PhaseContext, checkpoint: Checkpoint): void {
  ctx.store.events.append([{
    id: id("evt", ctx.clock.now()),
    runId: ctx.run.id,
    ts: ctx.clock.now(),
    type: "checkpoint.created",
    payload: { checkpoint },
    causedBy: [],
    actor: SYSTEM_ACTOR,
    artifacts: [],
  }]);
}

function appendRunCheckpoint(ctx: PhaseContext, checkpointHash: string): void {
  const run = { ...ctx.run, currentCheckpointHash: checkpointHash, updatedAt: ctx.clock.now() };
  ctx.store.events.append([{
    id: id("evt", ctx.clock.now()),
    runId: ctx.run.id,
    ts: ctx.clock.now(),
    type: "run.phase_changed",
    payload: { run },
    causedBy: [],
    actor: SYSTEM_ACTOR,
    artifacts: [],
  }]);
}

function appendIntegrationEvent(
  ctx: PhaseContext,
  type: "integration.started" | "integration.finished",
  payload: Record<string, unknown>,
  causedBy: string[] = [],
): string {
  const eventId = id("evt", ctx.clock.now());
  ctx.store.events.append([{
    id: eventId,
    runId: ctx.run.id,
    ts: ctx.clock.now(),
    type,
    payload,
    causedBy,
    actor: SYSTEM_ACTOR,
    artifacts: [],
  }]);
  return eventId;
}
