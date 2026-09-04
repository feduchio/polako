import { SYSTEM_ACTOR, modelRefKey, type ModelRef } from "../domain/common.js";
import type { CorpusEntry } from "../domain/acceptance.js";
import type { NewEvent } from "../domain/event.js";
import type { Finding } from "../domain/finding.js";
import type { ReviewAxis } from "../domain/finding.js";
import { ProviderError } from "../broker/types.js";
import {
  FindingValidator,
  ProjectFindingEvidenceWorker,
  type CorpusAppender,
  type FindingEvidenceWorker,
  type FindingValidationResult,
} from "../findings/index.js";
import {
  assertExecutionCheckpoint,
  currentReviewRoundIndex,
  isReviewRoundComplete,
  reviewAxesForRound,
  type ReviewExecution,
} from "../domain/review.js";
import { PolishError } from "../shared/errors.js";
import { buildCheckpointReviewArtifact, type CheckpointReviewArtifact } from "../review/artifact.js";
import { runAxisReview, type ReviewProvider } from "../review/swarm.js";
import type { Checkpoint } from "../domain/checkpoint.js";
import { id } from "../shared/ids.js";
import {
  latestCompletedReviewRound,
  recordCleanRoundEvent,
} from "../convergence/record.js";
import { MissionAcceptanceService } from "../store/missionAcceptance.js";
import type { PhaseContext, PhaseDriver } from "./types.js";

export interface ReviewDriverOptions {
  resolveReviewers?: (ctx: PhaseContext) => ReviewProvider[] | Promise<ReviewProvider[]>;
  resolveAxes?: (ctx: PhaseContext) => ReviewAxis[] | Promise<ReviewAxis[]>;
}

export interface ValidatingDriverOptions {
  resolveWorker?: (ctx: PhaseContext) => FindingEvidenceWorker | Promise<FindingEvidenceWorker>;
}

/** Production REVIEWING driver: fresh independent reviewers on the integrated checkpoint artifact. */
export function createReviewingDriver(options: ReviewDriverOptions = {}): PhaseDriver {
  return async (ctx) => {
    const hash = ctx.run.currentCheckpointHash;
    if (hash === null) return { status: "waiting" };

    const checkpoint = ctx.store.repos.checkpoints.byCommit(ctx.run.id, hash);
    if (checkpoint === null) return { status: "waiting" };

    const required = ctx.config.review.reviewersPerRound;
    const allExecutions = ctx.store.repos.reviewExecutions.listByRun(ctx.run.id);
    const roundIndex = currentReviewRoundIndex(allExecutions, required, hash);

    if (isReviewRoundComplete(allExecutions, hash, roundIndex, required)) {
      return { status: "complete", nextPhase: "VALIDATING" };
    }

    const roundExecutions = allExecutions.filter(
      (execution) => execution.checkpointHash === hash && execution.roundIndex === roundIndex,
    );
    const axes = await resolveAxes(ctx, options);
    const reviewers = await resolveReviewers(ctx, options);
    if (reviewers.length === 0) {
      if (recentlyRateLimitedReviewModels(ctx).length > 0) return { status: "waiting" };
      throw new PolishError("CONFIG_ERROR", "no cost-eligible reviewer models available");
    }
    const baseline = ctx.store.repos.baselines.listByRun(ctx.run.id)[0];
    const parent = checkpoint.parentId === null ? null : ctx.store.repos.checkpoints.get(checkpoint.parentId);
    const artifact = await buildCheckpointReviewArtifact({
      projectPath: ctx.run.projectPath,
      checkpoint,
      baselineCommit: baseline?.commitHash ?? null,
      parentCommit: parent?.commitHash ?? null,
    });
    if (artifact.commitHash !== hash) {
      throw new Error(`checkpoint artifact hash ${artifact.commitHash} does not match run checkpoint ${hash}`);
    }

    const rateLimited = new Set<string>();
    for (const axis of missingAxes(axes, roundExecutions, required)) {
      const outcome = await reviewAxisWithFallback(ctx, {
        hash,
        roundIndex,
        axis,
        reviewers,
        preferredIndex: Math.max(0, axes.indexOf(axis)),
        checkpoint,
        artifact,
        rateLimited,
      });
      if (outcome === "waiting") return { status: "waiting" };
    }

    const refreshed = ctx.store.repos.reviewExecutions.listByRun(ctx.run.id);
    if (isReviewRoundComplete(refreshed, hash, roundIndex, required)) {
      return { status: "complete", nextPhase: "VALIDATING" };
    }
    return { status: "waiting" };
  };
}

/** Production VALIDATING driver: triage, reproduce, persist validation evidence, spawn tasks. */
export function createValidatingDriver(options: ValidatingDriverOptions = {}): PhaseDriver {
  return async (ctx) => {
    const hash = ctx.run.currentCheckpointHash;
    if (hash === null) return { status: "waiting" };

    const allFindings = ctx.store.repos.findings.listByRun(ctx.run.id);
    const raw = allFindings
      .filter((finding) => finding.status === "RAW" && finding.checkpointHash === hash)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    if (raw.length === 0) {
      if (hasPendingFindingWork(ctx, hash)) return { status: "complete", nextPhase: "PLANNING" };
      recordCleanRoundIfEligible(ctx, hash);
      return { status: "complete", nextPhase: "CONVERGENCE_CHECK" };
    }

    const worker = await resolveEvidenceWorker(ctx, options);
    const deferredCorpus = new DeferredCorpusAppender(ctx.clock.now());
    const validator = new FindingValidator({
      clock: ctx.clock,
      worker,
      corpus: deferredCorpus,
      maxInvestigationRounds: ctx.config.convergence.maxInvestigationRoundsPerFinding,
    });
    const requirementRef = resolveRequirementRef(ctx);
    let known = [...allFindings];

    for (const finding of raw) {
      const result = await validator.validate({
        finding,
        existingFindings: known.filter((item) => item.id !== finding.id),
        missionId: ctx.run.missionId,
        requirementRef,
      });
      known = known.map((item) => (item.id === finding.id ? result.finding : item));
      const causedBy = findRaisedEventId(ctx, finding.id);
      const validationEventId = persistValidationResult(ctx, finding, result, causedBy === null ? [] : [causedBy]);
      if (deferredCorpus.pending !== null && validationEventId !== null) {
        const corpus = new MissionAcceptanceService(ctx.store, ctx.clock);
        corpus.record({
          ...deferredCorpus.pending,
          evidenceRefs: [validationEventId, ...deferredCorpus.pending.evidenceRefs],
        });
        deferredCorpus.pending = null;
      }
    }

    if (hasPendingFindingWork(ctx, hash)) return { status: "complete", nextPhase: "PLANNING" };
    recordCleanRoundIfEligible(ctx, hash);
    return { status: "complete", nextPhase: "CONVERGENCE_CHECK" };
  };
}

function recordCleanRoundIfEligible(ctx: PhaseContext, checkpointHash: string): void {
  const required = ctx.config.review.reviewersPerRound;
  const reviewExecutions = ctx.store.repos.reviewExecutions.listByRun(ctx.run.id);
  const latest = latestCompletedReviewRound(reviewExecutions, checkpointHash, required);
  if (latest === null) return;

  const completedReviewRounds = new Set(
    reviewExecutions
      .filter((execution) => execution.checkpointHash === checkpointHash)
      .map((execution) => execution.roundIndex),
  ).size;
  const existingForCheckpoint = ctx.store.repos.cleanRounds.forCheckpoint(ctx.run.id, checkpointHash).length;
  if (existingForCheckpoint >= completedReviewRounds) return;

  const findings = ctx.store.repos.findings.listByRun(ctx.run.id);
  const event = recordCleanRoundEvent({
    runId: ctx.run.id,
    checkpointHash,
    requiredReviewers: required,
    reviewExecutions,
    findings,
    existingCleanRounds: ctx.store.repos.cleanRounds.listByRun(ctx.run.id),
    reviewRoundIndex: latest,
    now: ctx.clock.now(),
  });
  ctx.store.events.append([event]);
}

/** Models whose latest review on this checkpoint is a sticky failure (429, 400, schema). */
export function recentlyRateLimitedReviewModels(ctx: PhaseContext): ModelRef[] {
  const hash = ctx.run.currentCheckpointHash;
  if (hash === null) return [];
  const latest = new Map<string, ReviewExecution>();
  for (const execution of ctx.store.repos.reviewExecutions.listByRun(ctx.run.id)) {
    if (execution.checkpointHash !== hash) continue;
    if (!execution.completed && execution.error === undefined) continue;
    const key = modelRefKey(execution.requestedModel);
    const prev = latest.get(key);
    const stamp = execution.finishedAt ?? execution.startedAt;
    const prevStamp = prev === undefined ? -1 : (prev.finishedAt ?? prev.startedAt);
    if (prev === undefined || stamp >= prevStamp) latest.set(key, execution);
  }
  const excluded: ModelRef[] = [];
  const completedKeys = new Set<string>();
  for (const execution of ctx.store.repos.reviewExecutions.listByRun(ctx.run.id)) {
    if (execution.checkpointHash === hash && execution.completed) {
      completedKeys.add(modelRefKey(execution.requestedModel));
    }
  }
  for (const execution of latest.values()) {
    if (execution.completed || execution.error === undefined) continue;
    if (!isStickyReviewSkip(undefined, execution.error)) continue;
    const key = modelRefKey(execution.requestedModel);
    if (completedKeys.has(key)) continue;
    excluded.push(execution.requestedModel);
  }
  return excluded;
}

function isRateLimitMessage(message: string): boolean {
  return /rate.?limit|\b429\b/i.test(message);
}

/** Capability/schema mismatches that should not be retried on this checkpoint. */
function isStickyReviewSkip(err: unknown, message: string): boolean {
  if (err instanceof ProviderError && (err.kind === "bad_request" || err.kind === "auth" || err.kind === "not_found" || err.kind === "context_length")) {
    return true;
  }
  if (err instanceof Error && (err.name === "ZodError" || err instanceof TypeError)) return true;
  return (
    isRateLimitMessage(message) ||
    /\bbad request\b|\b400\b|JSON mode is not enabled/i.test(message) ||
    /invalid_type|expected array|findings array/i.test(message)
  );
}

async function reviewAxisWithFallback(
  ctx: PhaseContext,
  input: {
    hash: string;
    roundIndex: number;
    axis: ReviewAxis;
    reviewers: readonly ReviewProvider[];
    preferredIndex: number;
    checkpoint: Checkpoint;
    artifact: CheckpointReviewArtifact;
    rateLimited: Set<string>;
  },
): Promise<"ok" | "waiting"> {
  const count = input.reviewers.length;
  for (let offset = 0; offset < count; offset++) {
    const reviewer = input.reviewers[(input.preferredIndex + offset) % count];
    if (reviewer === undefined) continue;
    const key = modelRefKey(reviewer.model);
    if (input.rateLimited.has(key)) continue;
    const started = startExecution(ctx, input.hash, input.roundIndex, input.axis, reviewer);
    try {
      const result = await runAxisReview({
        checkpoint: input.checkpoint,
        axis: input.axis,
        artifact: input.artifact,
        provider: reviewer,
        repositoryRoot: ctx.run.projectPath,
        now: ctx.clock.now(),
      });
      finishExecution(ctx, started, result.findings, result.model, result.promptDigest);
      for (const finding of result.findings) {
        raiseFinding(ctx, finding, started.id);
      }
      return "ok";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failExecution(ctx, started, message);
      input.rateLimited.add(key);
    }
  }
  return "waiting";
}

function missingAxes(
  axes: readonly ReviewAxis[],
  executions: readonly ReviewExecution[],
  required: number,
): ReviewAxis[] {
  const assigned = axes.slice(0, required);
  const missing: ReviewAxis[] = [];
  for (const axis of assigned) {
    const have = executions.filter((execution) => execution.axis === axis && execution.completed).length;
    const need = assigned.filter((item) => item === axis).length;
    const alreadyQueued = missing.filter((item) => item === axis).length;
    if (have + alreadyQueued < need) missing.push(axis);
  }
  return missing;
}

async function resolveAxes(ctx: PhaseContext, options: ReviewDriverOptions): Promise<ReviewAxis[]> {
  if (options.resolveAxes) return options.resolveAxes(ctx);
  return reviewAxesForRound(ctx.config.review.reviewersPerRound);
}

async function resolveReviewers(ctx: PhaseContext, options: ReviewDriverOptions): Promise<ReviewProvider[]> {
  if (options.resolveReviewers) return options.resolveReviewers(ctx);
  throw new PolishError("CONFIG_ERROR", "production REVIEWING requires explicit ReviewProvider selection");
}

function hasPendingFindingWork(ctx: PhaseContext, checkpointHash: string): boolean {
  return ctx.store.repos.tasks.listByRun(ctx.run.id).some(
    (task) =>
      task.state === "PENDING" &&
      task.baseCheckpointHash === checkpointHash &&
      (task.kind === "investigation" || task.origin.kind === "valid_finding"),
  );
}

async function resolveEvidenceWorker(ctx: PhaseContext, options: ValidatingDriverOptions): Promise<FindingEvidenceWorker> {
  if (options.resolveWorker) return options.resolveWorker(ctx);
  return new ProjectFindingEvidenceWorker({
    projectPath: ctx.run.projectPath,
    persistOutput: (output, kind, label) => ctx.store.artifacts.put(output, kind, label),
    now: () => ctx.clock.now(),
  });
}

function resolveRequirementRef(ctx: PhaseContext): string {
  const interpretationId = ctx.run.interpretationId;
  if (interpretationId !== null) {
    const interpretation = ctx.store.repos.interpretations.get(interpretationId);
    const first = interpretation?.requirements[0];
    if (first !== undefined) return first.ref;
  }
  return "R1";
}

function findRaisedEventId(ctx: PhaseContext, findingId: string): string | null {
  for (const event of ctx.store.events.list(ctx.run.id, { types: ["finding.raised"] })) {
    const finding = (event.payload as { finding?: Finding }).finding;
    if (finding?.id === findingId) return event.id;
  }
  return null;
}

function persistValidationResult(
  ctx: PhaseContext,
  before: Finding,
  result: FindingValidationResult,
  causedBy: string[],
): string | null {
  const events: NewEvent[] = [];
  if (result.finding.status !== before.status || result.finding.fingerprint !== before.fingerprint) {
    events.push({
      id: id("evt", ctx.clock.now()),
      runId: ctx.run.id,
      ts: ctx.clock.now(),
      type: "finding.status_changed",
      payload: { finding: result.finding, from: before.status, to: result.finding.status },
      causedBy,
      actor: { kind: "evidence_agent" },
      artifacts: [],
    });
  }
  let validationEventId: string | null = null;
  if (result.validation !== null) {
    validationEventId = id("evt", ctx.clock.now() + 1);
    events.push({
      id: validationEventId,
      runId: ctx.run.id,
      ts: ctx.clock.now(),
      type: "finding.validated",
      payload: { validation: result.validation, finding: result.finding },
      causedBy,
      actor: { kind: "evidence_agent" },
      artifacts: result.validation.evidenceRefs,
    });
  }
  if (result.task !== null) {
    events.push({
      id: id("evt", ctx.clock.now() + 2),
      runId: ctx.run.id,
      ts: ctx.clock.now(),
      type: "task.created",
      payload: { task: result.task },
      causedBy: validationEventId === null ? causedBy : [validationEventId],
      actor: { kind: "evidence_agent" },
      artifacts: [],
    });
  }
  if (events.length > 0) ctx.store.events.append(events);
  return validationEventId;
}

class DeferredCorpusAppender implements CorpusAppender {
  pending: (Omit<CorpusEntry, "id" | "createdAt"> & { id?: string }) | null = null;

  constructor(private readonly now: number) {}

  record(entry: Omit<CorpusEntry, "id" | "createdAt"> & { id?: string }): CorpusEntry {
    this.pending = entry;
    return { ...entry, id: entry.id ?? id("corp", this.now), createdAt: this.now };
  }
}

function startExecution(
  ctx: PhaseContext,
  checkpointHash: string,
  roundIndex: number,
  axis: ReviewAxis,
  reviewer: ReviewProvider,
): ReviewExecution {
  const now = ctx.clock.now();
  const execution: ReviewExecution = {
    id: id("rvex", now),
    runId: ctx.run.id,
    checkpointHash,
    roundIndex,
    axis,
    requestedModel: reviewer.model,
    completed: false,
    findings: [],
    startedAt: now,
    finishedAt: null,
  };
  assertExecutionCheckpoint(execution, checkpointHash);
  appendReviewEvent(ctx, "review.started", execution);
  return execution;
}

function finishExecution(
  ctx: PhaseContext,
  started: ReviewExecution,
  findings: Finding[],
  model: ReviewExecution["requestedModel"],
  promptDigest: string,
): void {
  const finished: ReviewExecution = {
    ...started,
    requestedModel: model,
    completed: true,
    findings: findings.map(rawFindingFrom),
    promptDigest,
    finishedAt: ctx.clock.now(),
  };
  assertExecutionCheckpoint(finished, started.checkpointHash);
  appendReviewEvent(ctx, "review.finished", finished);
}

function failExecution(ctx: PhaseContext, started: ReviewExecution, error: string): void {
  const failed: ReviewExecution = {
    ...started,
    completed: false,
    error,
    finishedAt: ctx.clock.now(),
  };
  appendReviewEvent(ctx, "review.finished", failed);
}

function rawFindingFrom(finding: Finding): ReviewExecution["findings"][number] {
  return {
    criterion: finding.criterion,
    severity: finding.severity,
    blocking: finding.blocking,
    claim: finding.claim,
    evidence: finding.evidence,
    reproduction: finding.reproduction,
    suggestedCheck: finding.suggestedCheck,
  };
}

function raiseFinding(ctx: PhaseContext, finding: Finding, causedBy: string): void {
  const event: NewEvent = {
    id: id("evt", ctx.clock.now()),
    runId: ctx.run.id,
    ts: ctx.clock.now(),
    type: "finding.raised",
    payload: { finding },
    causedBy: [causedBy],
    actor: finding.reportedBy,
    artifacts: [],
  };
  ctx.store.events.append([event]);
}

function appendReviewEvent(ctx: PhaseContext, type: "review.started" | "review.finished", execution: ReviewExecution): void {
  const event: NewEvent = {
    id: id("evt", ctx.clock.now()),
    runId: ctx.run.id,
    ts: ctx.clock.now(),
    type,
    payload: { execution },
    causedBy: [],
    actor: SYSTEM_ACTOR,
    artifacts: [],
  };
  ctx.store.events.append([event]);
}
