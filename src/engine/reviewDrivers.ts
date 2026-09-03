import { SYSTEM_ACTOR } from "../domain/common.js";
import type { NewEvent } from "../domain/event.js";
import type { Finding } from "../domain/finding.js";
import type { ReviewAxis } from "../domain/finding.js";
import {
  assertExecutionCheckpoint,
  currentReviewRoundIndex,
  isReviewRoundComplete,
  reviewAxesForRound,
  type ReviewExecution,
} from "../domain/review.js";
import type { ProviderAdapter } from "../broker/types.js";
import { ScriptedProvider } from "../providers/scripted.js";
import { buildCheckpointReviewArtifact } from "../review/artifact.js";
import { runAxisReview } from "../review/swarm.js";
import { id } from "../shared/ids.js";
import type { PhaseContext, PhaseDriver } from "./types.js";

export interface ReviewDriverOptions {
  resolveProviders?: (ctx: PhaseContext) => ProviderAdapter[] | Promise<ProviderAdapter[]>;
  resolveAxes?: (ctx: PhaseContext) => ReviewAxis[] | Promise<ReviewAxis[]>;
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
    const providers = await resolveProviders(ctx, options);
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

    for (const axis of missingAxes(axes, roundExecutions, required)) {
      const provider = providers[axes.indexOf(axis) % providers.length] ?? providers[0];
      if (provider === undefined) return { status: "waiting" };
      const started = await startExecution(ctx, hash, roundIndex, axis, provider);
      try {
        const result = await runAxisReview({
          checkpoint,
          axis,
          artifact,
          provider,
          repositoryRoot: ctx.run.projectPath,
          now: ctx.clock.now(),
        });
        finishExecution(ctx, started, result.findings, result.model, result.promptDigest);
        for (const finding of result.findings) {
          raiseFinding(ctx, finding, started.id);
        }
      } catch (err) {
        failExecution(ctx, started, err instanceof Error ? err.message : String(err));
        return { status: "waiting" };
      }
    }

    const refreshed = ctx.store.repos.reviewExecutions.listByRun(ctx.run.id);
    if (isReviewRoundComplete(refreshed, hash, roundIndex, required)) {
      return { status: "complete", nextPhase: "VALIDATING" };
    }
    return { status: "waiting" };
  };
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

async function resolveProviders(ctx: PhaseContext, options: ReviewDriverOptions): Promise<ProviderAdapter[]> {
  if (options.resolveProviders) return options.resolveProviders(ctx);
  return [new ScriptedProvider("review-default", [])];
}

async function startExecution(
  ctx: PhaseContext,
  checkpointHash: string,
  roundIndex: number,
  axis: ReviewAxis,
  provider: ProviderAdapter,
): Promise<ReviewExecution> {
  const now = ctx.clock.now();
  const model = (await provider.listModels())[0]?.ref ?? { provider: provider.id, model: "default" };
  const execution: ReviewExecution = {
    id: id("rvex", now),
    runId: ctx.run.id,
    checkpointHash,
    roundIndex,
    axis,
    requestedModel: model,
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
