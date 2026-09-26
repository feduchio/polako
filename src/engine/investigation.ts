import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { CandidateWorkerFactory, WorkerReproduction } from "../agents/types.js";
import { CORPUS_EXECUTABLE_STATUS } from "../domain/acceptance.js";
import type { ArtifactRef } from "../domain/common.js";
import { SYSTEM_ACTOR } from "../domain/common.js";
import type { NewEvent } from "../domain/event.js";
import {
  commitFindingStatus,
  FindingSchema,
  FindingValidationStrictSchema,
  type Finding,
  type ValidationVerdict,
} from "../domain/finding.js";
import { createTaskFromValidFinding, type Task } from "../domain/task.js";
import type { CommandPolicy } from "../sandbox/allowlist.js";
import type { ProcessResult } from "../sandbox/process.js";
import type { Sandbox, SandboxHandle } from "../sandbox/worktree.js";
import { canonicalJson } from "../shared/hash.js";
import { id } from "../shared/ids.js";
import { MissionAcceptanceService } from "../store/missionAcceptance.js";
import { prepareWorkerCheckout, type CandidateGates } from "./candidates.js";
import { assertIsolatedCheckout, createCheckpointCheckout, destroyCheckout, uniqueCheckoutId } from "./checkpointCheckout.js";
import { transitionTask } from "./taskTransition.js";
import type { PhaseContext, PhaseDriverResult } from "./types.js";

export const INVESTIGATION_EVENT = "investigation.completed";
const REPRODUCTION_TIMEOUT_MS = 120_000;

export interface InvestigationDeps {
  sandbox: Sandbox;
  policy: CommandPolicy;
  workerFactory: CandidateWorkerFactory;
  gates: CandidateGates;
}

interface AddedFile {
  path: string;
  content: string;
}

interface Reproduced {
  verdict: ValidationVerdict;
  rationale: string;
  exitCode: number | null;
  output: ArtifactRef;
}

/** The oldest investigation that can run now, or null. */
export function activeInvestigationTask(ctx: PhaseContext): Task | null {
  const tasks = ctx.store.repos.tasks.listByRun(ctx.run.id).filter((task) => task.kind === "investigation");
  return tasks.find((task) => task.state === "RUNNING") ??
    tasks.find((task) => task.state === "READY" || task.state === "PENDING") ??
    null;
}

/**
 * Run one investigation to a verdict the engine can stand behind.
 *
 * A worker writes the reproduction; the engine re-runs it on a fresh checkout of the finding's
 * commit with only the files the worker added, and the exit code decides. The worker's summary is
 * never read as a verdict: an investigation that says "confirmed" and whose command passes is a
 * rejected finding.
 */
export async function runInvestigationTask(ctx: PhaseContext, task: Task, deps: InvestigationDeps): Promise<PhaseDriverResult> {
  if (task.origin.kind !== "investigation") return { status: "complete", nextPhase: "PLANNING" };
  const finding = ctx.store.repos.findings.get(task.origin.findingId);
  if (finding?.status !== "UNCERTAIN") {
    // Decided some other way since the task was made; there is nothing left to investigate.
    transitionTask(ctx.store, ctx.clock, ctx.run.id, { ...task, state: "CANCELLED", updatedAt: ctx.clock.now() });
    return { status: "complete", nextPhase: "PLANNING" };
  }
  const running = startTask(ctx, task);

  let reproduction: WorkerReproduction;
  let added: AddedFile[];
  try {
    const written = await writeReproduction(ctx, running, finding, deps);
    if ("failure" in written) return retryOrBlock(ctx, running, finding, written.failure);
    ({ reproduction, added } = written);
  } catch (error) {
    return retryOrBlock(ctx, running, finding, `investigation worker failed: ${errorText(error)}`);
  }

  let result: Reproduced;
  try {
    result = await rerun(ctx, running, finding, deps, reproduction, added);
  } catch (error) {
    return retryOrBlock(ctx, running, finding, `reproduction could not be re-run: ${errorText(error)}`);
  }
  if (result.verdict === "UNCERTAIN") {
    recordInvestigation(ctx, running, finding, reproduction, added, result);
    return retryOrBlock(ctx, running, finding, result.rationale);
  }
  applyVerdict(ctx, running, finding, reproduction, added, result);
  return { status: "complete", nextPhase: "PLANNING" };
}

function startTask(ctx: PhaseContext, task: Task): Task {
  let current = task;
  if (current.state === "PENDING") {
    current = transitionTask(ctx.store, ctx.clock, ctx.run.id, { ...current, state: "READY", updatedAt: ctx.clock.now() });
  }
  if (current.state === "READY") {
    current = transitionTask(ctx.store, ctx.clock, ctx.run.id, {
      ...current,
      state: "RUNNING",
      attempts: current.attempts + 1,
      updatedAt: ctx.clock.now(),
    });
  }
  return current;
}

async function writeReproduction(
  ctx: PhaseContext,
  task: Task,
  finding: Finding,
  deps: InvestigationDeps,
): Promise<{ reproduction: WorkerReproduction; added: AddedFile[] } | { failure: string }> {
  let handle: SandboxHandle | undefined;
  try {
    const checkout = await isolatedCheckout(ctx, deps, finding, `${task.id}-w${String(task.attempts)}`);
    handle = checkout;
    await prepareWorkerCheckout(checkout, deps.gates, ctx.signal);
    const before = new Set(await untracked(handle));
    const outcome = await deps.workerFactory(0).run(task, handle);
    if (outcome.status !== "completed") return { failure: `investigation worker ${outcome.status}: ${outcome.error ?? "no reason given"}` };
    if (outcome.reproduction === undefined) return { failure: "investigation worker finished without a reproduction command" };
    if ((await handle.git.trackedDiffAgainst(finding.checkpointHash)).trim() !== "") {
      return { failure: "investigation worker modified tracked files" };
    }
    const added = (await untracked(handle))
      .filter((path) => !before.has(path))
      .map((path) => ({ path, content: readFileSync(resolve(checkout.path, path), "utf8") }));
    return { reproduction: outcome.reproduction, added };
  } finally {
    await destroyCheckout(handle);
  }
}

async function rerun(
  ctx: PhaseContext,
  task: Task,
  finding: Finding,
  deps: InvestigationDeps,
  reproduction: WorkerReproduction,
  added: readonly AddedFile[],
): Promise<Reproduced> {
  let handle: SandboxHandle | undefined;
  try {
    handle = await isolatedCheckout(ctx, deps, finding, `${task.id}-v${String(task.attempts)}`);
    await prepareWorkerCheckout(handle, deps.gates, ctx.signal);
    for (const file of added) {
      const target = resolve(handle.path, file.path);
      const rel = relative(handle.path, target);
      if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`added file ${file.path} escapes the checkout`);
      // A fresh checkout already holding the path means the worker's "new" file shadows project content.
      if (existsSync(target)) throw new Error(`added file ${file.path} already exists in the checkpoint`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content);
    }
    const result = await handle.run(reproduction.argv, {
      timeoutMs: REPRODUCTION_TIMEOUT_MS,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    const output = ctx.store.artifacts.put(canonicalJson(result), "investigation_reproduction", reproduction.argv.join(" "), ctx.clock.now());
    return { ...classifyReproduction(result, added), output };
  } finally {
    await destroyCheckout(handle);
  }
}

/**
 * Exit code decides, except where the command never reached the question: a missing binary, a
 * missing module, a timeout, or a reproduction script that does not itself parse. Those say nothing
 * about the finding and leave it UNCERTAIN.
 */
export function classifyReproduction(
  result: ProcessResult,
  added: readonly { path: string }[],
): { verdict: ValidationVerdict; rationale: string; exitCode: number | null } {
  const exitCode = result.exitCode;
  const output = `${result.stdout}\n${result.stderr}`;
  const uncertain = (rationale: string) => ({ verdict: "UNCERTAIN" as const, rationale, exitCode });
  if (result.timedOut) return uncertain(`reproduction timed out after ${String(REPRODUCTION_TIMEOUT_MS)}ms`);
  if (result.aborted) return uncertain("reproduction was aborted");
  if (exitCode === 127 || /command not found|failed to spawn|enoent/i.test(output)) {
    return uncertain("reproduction command was not found");
  }
  if (/cannot find module|cannot find package|err_module_not_found/i.test(output)) {
    return uncertain("reproduction could not load a module it needs");
  }
  if (/\bSyntaxError\b/.test(output) && added.some((file) => output.includes(file.path))) {
    return uncertain("the reproduction's own file does not parse");
  }
  if (exitCode === 0) {
    return { verdict: "REJECTED", rationale: "the engine re-ran the reproduction and it passed: the defect is not there", exitCode };
  }
  return {
    verdict: "VALID",
    rationale: `the engine re-ran the reproduction and it failed with exit code ${String(exitCode)}`,
    exitCode,
  };
}

async function isolatedCheckout(ctx: PhaseContext, deps: InvestigationDeps, finding: Finding, key: string): Promise<SandboxHandle> {
  const handle = await createCheckpointCheckout(deps.sandbox, {
    id: uniqueCheckoutId("inv", key, 0),
    baseCommit: finding.checkpointHash,
    policy: deps.policy,
  });
  try {
    await assertIsolatedCheckout(handle, ctx.run.projectPath, finding.checkpointHash);
  } catch (error) {
    await destroyCheckout(handle);
    throw error;
  }
  return handle;
}

function untracked(handle: SandboxHandle): Promise<string[]> {
  return handle.git.untrackedFiles();
}

function retryOrBlock(ctx: PhaseContext, task: Task, finding: Finding, reason: string): PhaseDriverResult {
  const exhausted = task.attempts >= ctx.config.retry.maxAttempts;
  ctx.store.events.append([{
    id: id("evt", ctx.clock.now()),
    runId: ctx.run.id,
    ts: ctx.clock.now(),
    type: INVESTIGATION_EVENT,
    payload: { taskId: task.id, findingId: finding.id, verdict: null, reason, attempt: task.attempts, exhausted },
    causedBy: [],
    actor: SYSTEM_ACTOR,
    artifacts: [],
  }]);
  transitionTask(ctx.store, ctx.clock, ctx.run.id, {
    ...task,
    state: exhausted ? "BLOCKED" : "READY",
    updatedAt: ctx.clock.now(),
  });
  return { status: "complete", nextPhase: "PLANNING" };
}

function recordInvestigation(
  ctx: PhaseContext,
  task: Task,
  finding: Finding,
  reproduction: WorkerReproduction,
  added: readonly AddedFile[],
  result: Reproduced,
): string {
  const eventId = id("evt", ctx.clock.now());
  ctx.store.events.append([{
    id: eventId,
    runId: ctx.run.id,
    ts: ctx.clock.now(),
    type: INVESTIGATION_EVENT,
    payload: {
      taskId: task.id,
      findingId: finding.id,
      verdict: result.verdict,
      rationale: result.rationale,
      argv: reproduction.argv,
      exitCode: result.exitCode,
      addedFiles: added.map((file) => file.path),
      attempt: task.attempts,
    },
    causedBy: [],
    actor: SYSTEM_ACTOR,
    artifacts: [result.output],
  }]);
  return eventId;
}

function applyVerdict(
  ctx: PhaseContext,
  task: Task,
  before: Finding,
  reproduction: WorkerReproduction,
  added: readonly AddedFile[],
  result: Reproduced,
): void {
  const causal = recordInvestigation(ctx, task, before, reproduction, added, result);
  const now = ctx.clock.now();
  const validating = FindingSchema.parse({ ...before, status: "VALIDATING", updatedAt: now });
  const terminal = FindingSchema.parse({ ...validating, status: result.verdict, updatedAt: now });
  const validation = FindingValidationStrictSchema.parse({
    id: id("fval", now),
    findingId: before.id,
    runId: before.runId,
    method: "deterministic_reproduction",
    verdict: result.verdict,
    rationale: result.rationale,
    evidenceRefs: [result.output],
    performedBy: SYSTEM_ACTOR,
    createdAt: now,
  });
  commitFindingStatus(before.status, "VALIDATING", before.id);
  commitFindingStatus("VALIDATING", result.verdict, before.id);

  const fix = result.verdict === "VALID" && terminal.blocking
    ? createTaskFromValidFinding(terminal, validation, {
        id: id("task", now),
        runId: terminal.runId,
        title: `Fix: ${terminal.claim}`,
        description: fixDescription(terminal, reproduction, added, result),
        kind: "bugfix",
        acceptance: [`\`${reproduction.argv.join(" ")}\` exits 0 with the reproduction files in place`],
        complexity: "normal",
        baseCheckpointHash: terminal.checkpointHash,
        now,
      })
    : null;

  const validatingId = id("evt", now);
  const validatedId = id("evt", now + 1);
  const events: NewEvent[] = [
    {
      id: validatingId,
      runId: ctx.run.id,
      ts: now,
      type: "finding.status_changed",
      payload: { finding: validating, from: before.status, to: "VALIDATING" },
      causedBy: [causal],
      actor: SYSTEM_ACTOR,
      artifacts: [],
    },
    {
      id: validatedId,
      runId: ctx.run.id,
      ts: now,
      type: "finding.validated",
      payload: { validation, finding: terminal },
      causedBy: [causal, validatingId],
      actor: SYSTEM_ACTOR,
      artifacts: validation.evidenceRefs,
    },
    {
      id: id("evt", now + 2),
      runId: ctx.run.id,
      ts: now,
      type: "finding.status_changed",
      payload: { finding: terminal, from: "VALIDATING", to: result.verdict },
      causedBy: [validatedId],
      actor: SYSTEM_ACTOR,
      artifacts: [],
    },
  ];
  if (fix !== null) {
    events.push({
      id: id("evt", now + 3),
      runId: ctx.run.id,
      ts: now,
      type: "task.created",
      payload: { task: fix },
      causedBy: [validatedId],
      actor: SYSTEM_ACTOR,
      artifacts: [],
    });
  }
  ctx.store.events.append(events);
  transitionTask(ctx.store, ctx.clock, ctx.run.id, { ...task, state: "SATISFIED", updatedAt: ctx.clock.now() }, [validatedId]);

  if (result.verdict === "VALID") {
    new MissionAcceptanceService(ctx.store, ctx.clock).record({
      missionId: ctx.run.missionId,
      sourceRunId: terminal.runId,
      requirementRef: requirementRefOf(ctx),
      kind: "regression_test",
      summary: `Reproduced finding: ${terminal.claim}`,
      evidenceRefs: [validatedId],
      artifactHashes: [result.output.sha256],
      metadata: {
        findingId: terminal.id,
        validationId: validation.id,
        method: "deterministic_reproduction",
        argv: reproduction.argv,
        executableStatus: fix === null ? CORPUS_EXECUTABLE_STATUS.noFixingTask : CORPUS_EXECUTABLE_STATUS.pendingIntegration,
      },
    });
  }
}

function fixDescription(finding: Finding, reproduction: WorkerReproduction, added: readonly AddedFile[], result: Reproduced): string {
  return [
    `WHAT: ${finding.claim}`,
    `WHY: ${result.rationale}`,
    "CONSTRAINTS: keep the reproduction passing once fixed; do not weaken it",
    `EVIDENCE: \`${reproduction.argv.join(" ")}\` failed on ${finding.checkpointHash}`,
    ...added.map((file) => `REPRODUCTION FILE ${file.path}:\n${file.content}`),
  ].join("\n");
}

function requirementRefOf(ctx: PhaseContext): string {
  const interpretation = ctx.run.interpretationId === null ? null : ctx.store.repos.interpretations.get(ctx.run.interpretationId);
  return interpretation?.requirements[0]?.ref ?? "R1";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
