import { assertReviewerRolesResolvable } from "../review/reviewerProtocol.js";
import { ProtocolRegistry, defaultProtocolsRoot } from "../protocols/loader.js";
import { SYSTEM_ACTOR, modelRefKey, type ModelRef } from "../domain/common.js";
import type { CorpusEntry } from "../domain/acceptance.js";
import type { Event, NewEvent } from "../domain/event.js";
import { FINDING_TABLE, FindingSchema, FindingValidationStrictSchema, findingStatusFromVerdict, type Finding, type FindingValidation, type ValidationVerdict } from "../domain/finding.js";
import type { ReviewAxis } from "../domain/finding.js";
import { assertTransition } from "../domain/fsm.js";
import { createInvestigationTask, createTaskFromValidFinding, type Task } from "../domain/task.js";
import { ProviderError } from "../broker/types.js";
import {
  DEBATE_ARGUMENT,
  DEBATE_METHOD,
  DEBATE_OUTCOME,
  DEBATE_STARTED,
  FindingValidator,
  argumentRecords,
  assertDebateMayStart,
  causalB5ValidationId,
  collectPreDebateEvidenceRefs,
  debateActor,
  debateEventsFor,
  debateValidationFor,
  deriveDebateCorpusKind,
  legalDebateValid,
  nextDebateStep,
  outcomePayload,
  parseJudgeVerdict,
  rolePrompt,
  startedPayload,
  threeDistinctDebateRoles,
  type CorpusAppender,
  type DebateRole,
  type DebateRoles,
  type FindingEvidenceWorker,
  type FindingValidationResult,
} from "../findings/index.js";
import { emitNeedsHumanReport } from "../report/emit.js";
import {
  assertExecutionCheckpoint,
  currentReviewRoundIndex,
  isReviewRoundComplete,
  reviewAxesForRound,
  reviewRoundExecutions,
  type ReviewExecution,
} from "../domain/review.js";
import type { TerminalReason } from "../domain/run.js";
import { PolishError } from "../shared/errors.js";
import { buildCheckpointReviewArtifact, type CheckpointReviewArtifact } from "../review/artifact.js";
import { REVIEW_TRUNCATED_MESSAGE, runAxisReview, type ReviewProvider, type RunAxisReviewInput, type RunAxisReviewResult } from "../review/swarm.js";
import type { Checkpoint } from "../domain/checkpoint.js";
import { id } from "../shared/ids.js";
import {
  nextUnconsumedCompletedReviewRound,
  recordCleanRoundEvent,
} from "../convergence/record.js";
import { orderReviewersByEnsemble, pendingEnsembleOverride } from "../convergence/pathology/ensemble.js";
import { MissionAcceptanceService } from "../store/missionAcceptance.js";
import type { PhaseContext, PhaseDriver } from "./types.js";
import {
  assertIsolatedCheckout,
  CheckpointCheckoutEvidenceWorker,
  createCheckpointCheckout,
  detachedCheckoutPolicy,
  destroyCheckout,
  uniqueCheckoutId,
} from "./checkpointCheckout.js";
import type { CommandPolicy } from "../sandbox/allowlist.js";
import type { Sandbox, SandboxHandle } from "../sandbox/worktree.js";

export interface ReviewDriverOptions {
  resolveReviewers?: (ctx: PhaseContext) => ReviewProvider[] | Promise<ReviewProvider[]>;
  strictProbeEpochComplete?: (ctx: PhaseContext) => boolean;
  resolveAxes?: (ctx: PhaseContext) => ReviewAxis[] | Promise<ReviewAxis[]>;
  sandbox?: Sandbox | ((ctx: PhaseContext) => Sandbox | Promise<Sandbox>);
  policy?: CommandPolicy | ((ctx: PhaseContext) => CommandPolicy | Promise<CommandPolicy>);
  runAxisReview?: (input: RunAxisReviewInput) => Promise<RunAxisReviewResult>;
  /** Injected once; `ProtocolRegistry.load` is synchronous IO over every protocol directory. */
  protocols?: ProtocolRegistry;
}

export interface DebateCompletionRequest {
  role: DebateRole;
  model: ModelRef;
  prompt: string;
  finding: Finding;
}

export interface ValidatingDriverOptions {
  resolveWorker?: (ctx: PhaseContext) => FindingEvidenceWorker | Promise<FindingEvidenceWorker>;
  /** Three distinct cost-eligible models, or null to skip debate (no invented verdict). */
  resolveDebateRoles?: (ctx: PhaseContext) => DebateRoles | null | Promise<DebateRoles | null>;
  completeDebate?: (ctx: PhaseContext, request: DebateCompletionRequest) => Promise<string>;
  sandbox?: Sandbox | ((ctx: PhaseContext) => Sandbox | Promise<Sandbox>);
  policy?: CommandPolicy | ((ctx: PhaseContext) => CommandPolicy | Promise<CommandPolicy>);
}

/** Production REVIEWING driver: fresh independent reviewers on the integrated checkpoint artifact. */
export function createReviewingDriver(options: ReviewDriverOptions = {}): PhaseDriver {
  let checkoutSeq = 0;
  // Once per driver, not once per axis per round: loading walks every protocol directory.
  const protocols = options.protocols ?? ProtocolRegistry.load(defaultProtocolsRoot());
  assertReviewerRolesResolvable(protocols);
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
    const override = pendingEnsembleOverride(ctx.store.events.list(ctx.run.id), hash, roundIndex);
    const resolved = await resolveReviewers(ctx, options);
    const reviewers = override === null ? resolved : orderReviewersByEnsemble(resolved, override);
    const exhausted = exhaustedAxes(axes, roundExecutions, required, ctx.config.review.maxAxisAttemptsPerRound);
    if (exhausted.length > 0) return stopForExhaustedAxes(ctx, hash, roundIndex, exhausted);
    if (reviewers.length === 0) {
      // Only a *transient* exclusion justifies waiting. A rate limit lifts; a truncation or a schema
      // rejection is deterministic and recurs at the same cap, so waiting on it is the unbounded loop
      // in a quieter form. `exhaustedAxes` cannot save us here: production routing excludes sticky
      // models, so with a pool smaller than `maxAxisAttemptsPerRound` the counter never reaches the
      // cap and the axis would sit in REVIEWING forever.
      if (transientlyExcludedReviewModels(ctx).length > 0) return { status: "waiting" };
      const deterministic = deterministicallyExcludedReviewModels(ctx);
      if (deterministic.length > 0) {
        return {
          status: "complete",
          nextPhase: "FAILED",
          terminalReason: {
            code: "providers_unavailable",
            summary: deterministic.some((entry) => entry.error === REVIEW_TRUNCATED_MESSAGE)
              ? `every reviewer model exceeded review.maxOutputTokens (${String(ctx.config.review.maxOutputTokens)}); raise the cap or use a terser model`
              : "every reviewer model failed with a non-retryable error",
          },
        };
      }
      return {
        status: "complete",
        nextPhase: "FAILED",
        terminalReason: options.strictProbeEpochComplete?.(ctx) === false
          ? {
              code: "internal_error",
              summary: "strict reviewer probe epoch is incomplete",
            }
          : {
              code: "providers_unavailable",
              summary: "no probed strict-schema reviewer models available",
            },
      };
    }
    if (options.sandbox === undefined) {
      throw new PolishError("CONFIG_ERROR", "production REVIEWING requires a sandbox");
    }

    const sandbox = await resolveDriverValue(options.sandbox, ctx);
    const policy = options.policy === undefined ? detachedCheckoutPolicy() : await resolveDriverValue(options.policy, ctx);
    const baseline = ctx.store.repos.baselines.listByRun(ctx.run.id)[0];
    const parent = checkpoint.parentId === null ? null : ctx.store.repos.checkpoints.get(checkpoint.parentId);
    let handle: SandboxHandle | undefined;
    try {
      handle = await createCheckpointCheckout(sandbox, {
        id: uniqueCheckoutId("rev", ctx.run.id, ++checkoutSeq),
        baseCommit: hash,
        policy,
      });
      await assertIsolatedCheckout(handle, ctx.run.projectPath, hash);
      const artifact = await buildCheckpointReviewArtifact({
        projectPath: handle.path,
        checkpoint,
        baselineCommit: baseline?.commitHash ?? null,
        parentCommit: parent?.commitHash ?? null,
      });
      if (artifact.commitHash !== hash) {
        throw new Error(`checkpoint artifact hash ${artifact.commitHash} does not match run checkpoint ${hash}`);
      }

      const rateLimited = new Set<string>();
      for (const axis of missingAxes(axes, roundExecutions, required)) {
        const preferredIndex = Math.max(0, axes.indexOf(axis));
        // Re-read: `roundExecutions` is a pre-loop snapshot, so an earlier axis that reported a
        // finding during this same pass is invisible to it.
        if (adversarialSkipApplies(ctx, hash, roundIndex, axis)) {
          // The row must name the model that would actually have been called, which is the first
          // reviewer `reviewAxisWithFallback` would not have passed over.
          const skipReviewer = nextUsableReviewer(reviewers, preferredIndex, rateLimited);
          if (skipReviewer !== undefined) {
            skipExecution(ctx, hash, roundIndex, axis, skipReviewer, SKIP_REASON);
            continue;
          }
        }
        const outcome = await reviewAxisWithFallback(ctx, {
          hash,
          roundIndex,
          axis,
          reviewers,
          preferredIndex: Math.max(0, axes.indexOf(axis)),
          checkpoint,
          artifact,
          repositoryRoot: handle.path,
          rateLimited,
          protocols,
          review: options.runAxisReview ?? runAxisReview,
        });
        if (outcome === "waiting") return { status: "waiting" };
      }

      const refreshed = ctx.store.repos.reviewExecutions.listByRun(ctx.run.id);
      if (isReviewRoundComplete(refreshed, hash, roundIndex, required)) {
        return { status: "complete", nextPhase: "VALIDATING" };
      }
      return { status: "waiting" };
    } catch (err) {
      if (handle === undefined) {
        recordCheckoutCreateFailure(ctx, hash, roundIndex, axes[0] ?? "correctness", reviewers[0], err);
      }
      if (err instanceof PolishError) throw err;
      throw new PolishError("SANDBOX_ERROR", err instanceof Error ? err.message : String(err));
    } finally {
      await destroyCheckout(handle);
    }
  };
}

/** Production VALIDATING driver: triage, reproduce, persist validation evidence, spawn tasks. */
export function createValidatingDriver(options: ValidatingDriverOptions = {}): PhaseDriver {
  let checkoutSeq = 0;
  return async (ctx) => {
    const hash = ctx.run.currentCheckpointHash;
    if (hash === null) return { status: "waiting" };

    const allFindings = ctx.store.repos.findings.listByRun(ctx.run.id);
    const raw = allFindings
      .filter((finding) => finding.status === "RAW" && finding.checkpointHash === hash)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

    const requirementRef = resolveRequirementRef(ctx);
    let known = [...allFindings];

    if (raw.length > 0) {
      const worker = await resolveEvidenceWorker(ctx, options, () => ++checkoutSeq);
      const deferredCorpus = new DeferredCorpusAppender(ctx.clock.now());
      const validator = new FindingValidator({
        clock: ctx.clock,
        worker,
        corpus: deferredCorpus,
        maxInvestigationRounds: ctx.config.convergence.maxInvestigationRoundsPerFinding,
      });

      for (const finding of raw) {
        const result = await validator.validate({
          finding,
          existingFindings: known.filter((item) => item.id !== finding.id),
          missionId: ctx.run.missionId,
          requirementRef,
        });
        known = known.map((item) => (item.id === finding.id ? result.finding : item));
        const causedBy = findRaisedEventId(ctx, finding.id);
        const persist = result.finding.status === "UNCERTAIN" ? { ...result, task: null } : result;
        const validationEventId = persistValidationResult(ctx, finding, persist, causedBy === null ? [] : [causedBy]);
        if (deferredCorpus.pending !== null && validationEventId !== null) {
          const corpus = new MissionAcceptanceService(ctx.store, ctx.clock);
          corpus.record({
            ...deferredCorpus.pending,
            evidenceRefs: [validationEventId, ...deferredCorpus.pending.evidenceRefs],
          });
          deferredCorpus.pending = null;
        }
      }
    }

    const afterRaw = ctx.store.repos.findings.listByRun(ctx.run.id);
    const debateTargets = afterRaw
      .filter((finding) => finding.checkpointHash === hash && needsDebateWork(ctx, finding))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    let escalateHuman = false;
    for (const finding of debateTargets) {
      const outcome = await runFindingDebate(ctx, finding, options, requirementRef);
      if (outcome === "needs_human") escalateHuman = true;
    }
    if (escalateHuman) {
      const reason = {
        code: "pathology_detected" as const,
        summary: "an uncertain finding exhausted its investigation budget",
        question: "An UNCERTAIN finding exhausted investigation after debate. How should the run proceed?",
        options: ["Provide more evidence", "Stop the run"],
      };
      emitNeedsHumanReport(ctx, reason);
      return { status: "complete", nextPhase: "NEEDS_HUMAN", terminalReason: reason };
    }

    if (hasPendingFindingWork(ctx, hash)) return { status: "complete", nextPhase: "PLANNING" };
    recordCleanRoundIfEligible(ctx, hash);
    return { status: "complete", nextPhase: "CONVERGENCE_CHECK" };
  };
}

function needsDebateWork(ctx: PhaseContext, finding: Finding): boolean {
  if (finding.status !== "UNCERTAIN") return false;
  const events = ctx.store.events.list(ctx.run.id);
  const validations = ctx.store.repos.validations.listByFinding(finding.id);
  if (debateValidationFor(validations, finding.id) !== null) return false;
  const debate = debateEventsFor(events, finding.id, finding.checkpointHash);
  if (debate.outcome !== null || debate.started !== null) return true;
  if (causalB5ValidationId(events, finding.id) === null) return false;
  return !hasInvestigationForFinding(ctx, finding.id);
}

function hasInvestigationForFinding(ctx: PhaseContext, findingId: string): boolean {
  return ctx.store.repos.tasks.listByRun(ctx.run.id).some(
    (task) => task.origin.kind === "investigation" && task.origin.findingId === findingId,
  );
}

async function runFindingDebate(
  ctx: PhaseContext,
  finding: Finding,
  options: ValidatingDriverOptions,
  requirementRef: string,
): Promise<"ok" | "needs_human"> {
  assertDebateMayStart(finding);
  const events = ctx.store.events.list(ctx.run.id);
  const validations = ctx.store.repos.validations.listByFinding(finding.id);
  if (debateValidationFor(validations, finding.id) !== null) return "ok";

  const debate = debateEventsFor(events, finding.id, finding.checkpointHash);
  if (debate.outcome === null) {
    const prepared = await persistDebateThroughOutcome(ctx, finding, options, debate.started);
    if (prepared === "skipped") return handleResidualUncertain(ctx, finding, requirementRef, null);
  }

  const latest = debateEventsFor(ctx.store.events.list(ctx.run.id), finding.id, finding.checkpointHash);
  if (latest.outcome === null) return handleResidualUncertain(ctx, finding, requirementRef, null);
  return applyDebateOutcome(ctx, finding, latest.outcome, requirementRef);
}

async function persistDebateThroughOutcome(
  ctx: PhaseContext,
  finding: Finding,
  options: ValidatingDriverOptions,
  startedEvent: Event | null,
): Promise<"debated" | "skipped"> {
  let started = startedEvent;
  if (started === null) {
    const roles = (await options.resolveDebateRoles?.(ctx)) ?? null;
    if (roles === null || !threeDistinctDebateRoles(roles) || options.completeDebate === undefined) {
      return "skipped";
    }
    const causal = causalB5ValidationId(ctx.store.events.list(ctx.run.id), finding.id);
    if (causal === null) return "skipped";
    started = persistDebateStarted(ctx, finding, roles, causal);
  }

  const roles = startedPayload(started).roles;
  if (!threeDistinctDebateRoles(roles) || options.completeDebate === undefined) {
    persistDebateOutcome(ctx, finding, {
      verdict: "UNCERTAIN",
      rationale: "debate roles could not be completed without inventing a verdict",
      hardFailure: true,
    });
    return "debated";
  }

  const maxRounds = ctx.config.convergence.maxDebateRounds;
  const validations = ctx.store.repos.validations.listByFinding(finding.id);
  const preDebateRefs = collectPreDebateEvidenceRefs(finding, validations);

  const maxSteps = maxRounds * 3 + 1;
  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex++) {
    const records = argumentRecords(debateEventsFor(ctx.store.events.list(ctx.run.id), finding.id, finding.checkpointHash).arguments);
    const step = nextDebateStep(records, maxRounds);
    if ("done" in step) {
      const lastJudge = [...records].reverse().find((item) => item.role === "judge");
      const parsed = lastJudge === undefined ? null : parseJudgeVerdict(lastJudge.text);
      persistDebateOutcome(ctx, finding, {
        verdict: parsed?.verdict ?? "UNCERTAIN",
        rationale:
          parsed?.rationale ??
          (step.hardFailure === true
            ? "malformed or empty judge verdict"
            : `debate remained UNCERTAIN after ${maxRounds} rounds`),
        hardFailure: step.hardFailure === true || parsed === null,
      });
      return "debated";
    }

    const prompt = rolePrompt(step.role, finding, validations, preDebateRefs, records, step.roundIndex);
    try {
      const text = await options.completeDebate(ctx, {
        role: step.role,
        model: roles[step.role],
        prompt,
        finding,
      });
      if (step.role !== "judge" && text.trim() === "") {
        persistDebateOutcome(ctx, finding, {
          verdict: "UNCERTAIN",
          rationale: `${step.role} returned an empty argument`,
          hardFailure: true,
        });
        return "debated";
      }
      if (step.role === "judge" && parseJudgeVerdict(text) === null) {
        persistRoleArgument(ctx, finding, step.role, step.roundIndex, text, roles[step.role]);
        persistDebateOutcome(ctx, finding, {
          verdict: "UNCERTAIN",
          rationale: "malformed or empty judge verdict",
          hardFailure: true,
        });
        return "debated";
      }
      persistRoleArgument(ctx, finding, step.role, step.roundIndex, text, roles[step.role]);
    } catch (error) {
      persistDebateOutcome(ctx, finding, {
        verdict: "UNCERTAIN",
        rationale: `debate role ${step.role} failed: ${error instanceof Error ? error.message : String(error)}`,
        hardFailure: true,
      });
      return "debated";
    }
  }
  persistDebateOutcome(ctx, finding, {
    verdict: "UNCERTAIN",
    rationale: "debate exceeded the bounded role schedule",
    hardFailure: true,
  });
  return "debated";
}

function persistDebateStarted(ctx: PhaseContext, finding: Finding, roles: DebateRoles, causalValidationId: string) {
  const event: NewEvent = {
    id: id("evt", ctx.clock.now()),
    runId: ctx.run.id,
    ts: ctx.clock.now(),
    type: DEBATE_STARTED,
    payload: {
      findingId: finding.id,
      checkpointHash: finding.checkpointHash,
      roles,
      causalValidationId,
    },
    causedBy: [causalValidationId],
    actor: SYSTEM_ACTOR,
    artifacts: [],
  };
  const [stored] = ctx.store.events.append([event]);
  if (stored === undefined) throw new Error("debate_started persist failed");
  return stored;
}

function persistRoleArgument(
  ctx: PhaseContext,
  finding: Finding,
  role: DebateRole,
  roundIndex: number,
  text: string,
  model: ModelRef,
): void {
  const artifact = ctx.store.artifacts.put(text, `debate.${role}`, `${finding.id}:${role}:${roundIndex}`, ctx.clock.now());
  const event: NewEvent = {
    id: id("evt", ctx.clock.now()),
    runId: ctx.run.id,
    ts: ctx.clock.now(),
    type: DEBATE_ARGUMENT,
    payload: {
      findingId: finding.id,
      checkpointHash: finding.checkpointHash,
      role,
      roundIndex,
      text,
    },
    causedBy: [],
    actor: debateActor(role, model),
    artifacts: [artifact],
  };
  ctx.store.events.append([event]);
}

function persistDebateOutcome(
  ctx: PhaseContext,
  finding: Finding,
  input: { verdict: ValidationVerdict; rationale: string; hardFailure: boolean },
): void {
  const debate = debateEventsFor(ctx.store.events.list(ctx.run.id), finding.id, finding.checkpointHash);
  const records = argumentRecords(debate.arguments);
  const causalRefs = [debate.started?.id, ...debate.arguments.map((event) => event.id)].filter(
    (value): value is string => value !== undefined,
  );
  const event: NewEvent = {
    id: id("evt", ctx.clock.now()),
    runId: ctx.run.id,
    ts: ctx.clock.now(),
    type: DEBATE_OUTCOME,
    payload: {
      findingId: finding.id,
      checkpointHash: finding.checkpointHash,
      verdict: input.verdict,
      rationale: input.rationale,
      roundCount: records.reduce((max, item) => Math.max(max, item.roundIndex), 0),
      hardFailure: input.hardFailure,
      causalRefs,
    },
    causedBy: causalRefs,
    actor: SYSTEM_ACTOR,
    artifacts: debate.arguments.flatMap((item) => item.artifacts),
  };
  ctx.store.events.append([event]);
}

function applyDebateOutcome(
  ctx: PhaseContext,
  before: Finding,
  outcomeEvent: Event,
  requirementRef: string,
): "ok" | "needs_human" {
  if (debateValidationFor(ctx.store.repos.validations.listByFinding(before.id), before.id) !== null) {
    return "ok";
  }
  const outcome = outcomePayload(outcomeEvent);
  const validations = ctx.store.repos.validations.listByFinding(before.id);
  const preDebateRefs = collectPreDebateEvidenceRefs(before, validations);
  let verdict: ValidationVerdict = outcome.verdict;
  let rationale = outcome.rationale;
  if (verdict === "VALID" && !legalDebateValid(preDebateRefs)) {
    verdict = "UNCERTAIN";
    rationale = "debate VALID without pre-debate evidence refs is a hard failure";
  }

  const now = ctx.clock.now();
  const debateState = debateEventsFor(ctx.store.events.list(ctx.run.id), before.id, before.checkpointHash);
  const debateArtifacts = debateState.arguments.flatMap((event) => event.artifacts);
  const evidenceRefs = verdict === "VALID" ? [...preDebateRefs, ...debateArtifacts] : debateArtifacts;
  if (debateState.started === null) {
    return handleResidualUncertain(ctx, before, requirementRef, null);
  }
  const judgeModel = startedPayload(debateState.started).roles.judge;

  const validating = FindingSchema.parse({ ...before, status: "VALIDATING", updatedAt: now });
  const terminalStatus = findingStatusFromVerdict(verdict);
  const residualInvestigate =
    terminalStatus === "UNCERTAIN" &&
    before.investigationRounds < ctx.config.convergence.maxInvestigationRoundsPerFinding;
  const terminalFinding = FindingSchema.parse({
    ...validating,
    status: terminalStatus,
    investigationRounds: residualInvestigate ? before.investigationRounds + 1 : before.investigationRounds,
    updatedAt: now,
  });
  const validation = FindingValidationStrictSchema.parse({
    id: id("fval", now),
    findingId: before.id,
    runId: before.runId,
    method: DEBATE_METHOD,
    verdict,
    rationale,
    evidenceRefs,
    performedBy: debateActor("judge", judgeModel),
    createdAt: now,
  });

  assertTransition(FINDING_TABLE, `finding ${before.id}`, before.status, "VALIDATING");
  assertTransition(FINDING_TABLE, `finding ${before.id}`, "VALIDATING", terminalStatus);

  let task: Task | null = null;
  if (verdict === "VALID" && terminalFinding.blocking) {
    task = createTaskFromValidFinding(terminalFinding, validation, {
      id: id("task", now),
      runId: terminalFinding.runId,
      title: `Fix: ${terminalFinding.claim}`,
      description: `WHAT: ${terminalFinding.claim}\nWHY: ${validation.rationale}`,
      kind: "bugfix",
      acceptance: acceptanceLines(terminalFinding),
      complexity: "normal",
      baseCheckpointHash: terminalFinding.checkpointHash,
      now,
    });
  } else if (residualInvestigate) {
    task = createInvestigationTask({ ...terminalFinding, investigationRounds: before.investigationRounds }, ctx.config.convergence.maxInvestigationRoundsPerFinding, {
      id: id("task", now),
      runId: terminalFinding.runId,
      title: `Investigate: ${terminalFinding.claim}`,
      description: `WHAT: ${terminalFinding.claim}\nWHY: ${validation.rationale}`,
      acceptance: acceptanceLines(terminalFinding),
      complexity: "normal",
      baseCheckpointHash: terminalFinding.checkpointHash,
      now,
    });
  }

  const validatingEventId = id("evt", now);
  const debateValidatedId = id("evt", now + 1);
  const terminalStatusId = id("evt", now + 2);
  const events: NewEvent[] = [
    {
      id: validatingEventId,
      runId: ctx.run.id,
      ts: now,
      type: "finding.status_changed",
      payload: { finding: validating, from: before.status, to: "VALIDATING" },
      causedBy: [outcomeEvent.id],
      actor: debateActor("judge", judgeModel),
      artifacts: [],
    },
    {
      id: debateValidatedId,
      runId: ctx.run.id,
      ts: now,
      type: "finding.validated",
      payload: { validation, finding: terminalFinding },
      causedBy: [outcomeEvent.id, validatingEventId],
      actor: debateActor("judge", judgeModel),
      artifacts: validation.evidenceRefs,
    },
    {
      id: terminalStatusId,
      runId: ctx.run.id,
      ts: now,
      type: "finding.status_changed",
      payload: { finding: terminalFinding, from: "VALIDATING", to: terminalStatus },
      causedBy: [debateValidatedId],
      actor: debateActor("judge", judgeModel),
      artifacts: [],
    },
  ];
  if (task !== null) {
    events.push({
      id: id("evt", now + 3),
      runId: ctx.run.id,
      ts: now,
      type: "task.created",
      payload: { task },
      causedBy: [debateValidatedId],
      actor: debateActor("judge", judgeModel),
      artifacts: [],
    });
  }
  ctx.store.events.append(events);

  if (verdict === "VALID") {
    const corpus = new MissionAcceptanceService(ctx.store, ctx.clock);
    corpus.record({
      missionId: ctx.run.missionId,
      sourceRunId: terminalFinding.runId,
      requirementRef,
      kind: deriveDebateCorpusKind(validations, preDebateRefs),
      summary: `Debate-validated finding: ${terminalFinding.claim}`,
      evidenceRefs: [debateValidatedId],
      artifactHashes: preDebateRefs.map((ref) => ref.sha256),
      metadata: { findingId: terminalFinding.id, validationId: validation.id, method: DEBATE_METHOD },
    });
  }

  if (terminalStatus === "UNCERTAIN" && !residualInvestigate) return "needs_human";
  return "ok";
}

function handleResidualUncertain(
  ctx: PhaseContext,
  finding: Finding,
  _requirementRef: string,
  _validation: FindingValidation | null,
): "ok" | "needs_human" {
  const max = ctx.config.convergence.maxInvestigationRoundsPerFinding;
  if (finding.investigationRounds >= max) return "needs_human";
  if (hasInvestigationForFinding(ctx, finding.id)) return "ok";
  const now = ctx.clock.now();
  const updated = FindingSchema.parse({
    ...finding,
    investigationRounds: finding.investigationRounds + 1,
    updatedAt: now,
  });
  const task = createInvestigationTask(finding, max, {
    id: id("task", now),
    runId: finding.runId,
    title: `Investigate: ${finding.claim}`,
    description: `WHAT: ${finding.claim}\nWHY: residual UNCERTAIN after debate skip`,
    acceptance: acceptanceLines(finding),
    complexity: "normal",
    baseCheckpointHash: finding.checkpointHash,
    now,
  });
  ctx.store.events.append([
    {
      id: id("evt", now),
      runId: ctx.run.id,
      ts: now,
      type: "finding.status_changed",
      payload: { finding: updated, from: finding.status, to: finding.status },
      causedBy: [],
      actor: { kind: "evidence_agent" },
      artifacts: [],
    },
    {
      id: id("evt", now + 1),
      runId: ctx.run.id,
      ts: now,
      type: "task.created",
      payload: { task },
      causedBy: [],
      actor: { kind: "evidence_agent" },
      artifacts: [],
    },
  ]);
  return "ok";
}

function acceptanceLines(finding: Finding): string[] {
  if (finding.suggestedCheck !== undefined) return [finding.suggestedCheck];
  if (finding.reproduction.length > 0) return [`The reproduction no longer demonstrates the issue: ${finding.reproduction.join(" → ")}`];
  return [`Independent gates show that "${finding.claim}" is resolved`];
}

function recordCleanRoundIfEligible(ctx: PhaseContext, checkpointHash: string): void {
  const required = ctx.config.review.reviewersPerRound;
  const reviewExecutions = ctx.store.repos.reviewExecutions.listByRun(ctx.run.id);
  const existingCleanRounds = ctx.store.repos.cleanRounds.listByRun(ctx.run.id);
  const reviewRoundIndex = nextUnconsumedCompletedReviewRound(
    existingCleanRounds,
    reviewExecutions,
    checkpointHash,
    required,
  );
  if (reviewRoundIndex === null) return;

  const findings = ctx.store.repos.findings.listByRun(ctx.run.id);
  const event = recordCleanRoundEvent({
    runId: ctx.run.id,
    checkpointHash,
    requiredReviewers: required,
    reviewExecutions,
    findings,
    existingCleanRounds,
    reviewRoundIndex,
    now: ctx.clock.now(),
  });
  ctx.store.events.append([event]);
}

/** Models whose latest review on this checkpoint is a sticky failure (429, 400, schema). */
/** Excluded because of a rate limit, which lifts on its own: waiting is justified. */
export function transientlyExcludedReviewModels(ctx: PhaseContext): ModelRef[] {
  return excludedReviewModels(ctx)
    .filter((entry) => isRateLimitMessage(entry.error))
    .map((entry) => entry.model);
}

/**
 * Excluded for a reason that will recur unchanged on the next tick — truncation at the configured cap,
 * a 400, a schema rejection. Waiting on these never ends, so the run must stop instead.
 */
export function deterministicallyExcludedReviewModels(ctx: PhaseContext): { model: ModelRef; error: string }[] {
  return excludedReviewModels(ctx).filter((entry) => !isRateLimitMessage(entry.error));
}

export function recentlyRateLimitedReviewModels(ctx: PhaseContext): ModelRef[] {
  return excludedReviewModels(ctx).map((entry) => entry.model);
}

function excludedReviewModels(ctx: PhaseContext): { model: ModelRef; error: string }[] {
  const hash = ctx.run.currentCheckpointHash;
  if (hash === null) return [];
  const latest = new Map<string, ReviewExecution>();
  for (const execution of ctx.store.repos.reviewExecutions.listByRun(ctx.run.id)) {
    if (execution.checkpointHash !== hash) continue;
    // A skip reached no provider, so it is evidence in neither direction. It must not become the
    // latest word on a model either: the loop below short-circuits on a completed latest row and
    // never consults `completedKeys`, so a skip landing after a 429 would lift the exclusion.
    if (isSkippedExecution(execution)) continue;
    if (!execution.completed && execution.error === undefined) continue;
    const key = modelRefKey(execution.requestedModel);
    const prev = latest.get(key);
    const stamp = execution.finishedAt ?? execution.startedAt;
    const prevStamp = prev === undefined ? -1 : (prev.finishedAt ?? prev.startedAt);
    if (prev === undefined || stamp >= prevStamp) latest.set(key, execution);
  }
  const excluded: { model: ModelRef; error: string }[] = [];
  const completedKeys = new Set<string>();
  for (const execution of ctx.store.repos.reviewExecutions.listByRun(ctx.run.id)) {
    // A skipped axis completed without calling the provider, so it is no evidence that the model
    // works and must not lift a sticky exclusion. Without this a 429'd model is rehabilitated by a
    // row that never reached it, and the next round calls it again.
    if (execution.checkpointHash === hash && execution.completed && !isSkippedExecution(execution)) {
      completedKeys.add(modelRefKey(execution.requestedModel));
    }
  }
  for (const execution of latest.values()) {
    if (execution.completed || execution.error === undefined) continue;
    if (!isStickyReviewSkip(undefined, execution.error)) continue;
    const key = modelRefKey(execution.requestedModel);
    if (completedKeys.has(key)) continue;
    excluded.push({ model: execution.requestedModel, error: execution.error });
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
    message === REVIEW_TRUNCATED_MESSAGE ||
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
        repositoryRoot: string;
        rateLimited: Set<string>;
        protocols: ProtocolRegistry;
        review: (input: RunAxisReviewInput) => Promise<RunAxisReviewResult>;
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
      const result = await input.review({
        checkpoint: input.checkpoint,
        axis: input.axis,
        artifact: input.artifact,
        provider: reviewer,
        protocols: input.protocols,
        repositoryRoot: input.repositoryRoot,
        now: ctx.clock.now(),
        maxOutputTokens: ctx.config.review.maxOutputTokens,
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

async function resolveEvidenceWorker(
  ctx: PhaseContext,
  options: ValidatingDriverOptions,
  nextSeq: () => number,
): Promise<FindingEvidenceWorker> {
  if (options.resolveWorker) return options.resolveWorker(ctx);
  if (options.sandbox === undefined) {
    throw new PolishError("CONFIG_ERROR", "production VALIDATING requires a sandbox when no resolveWorker is provided");
  }
  const sandbox = await resolveDriverValue(options.sandbox, ctx);
  const policy = options.policy === undefined ? detachedCheckoutPolicy() : await resolveDriverValue(options.policy, ctx);
  return new CheckpointCheckoutEvidenceWorker({
    sandbox,
    policy,
    projectPath: ctx.run.projectPath,
    persistOutput: (output, kind, label) => ctx.store.artifacts.put(output, kind, label),
    now: () => ctx.clock.now(),
    nextId: () => uniqueCheckoutId("val", ctx.run.id, nextSeq()),
  });
}

async function resolveDriverValue<T>(value: T | ((ctx: PhaseContext) => T | Promise<T>), ctx: PhaseContext): Promise<T> {
  return typeof value === "function" ? (value as (ctx: PhaseContext) => T | Promise<T>)(ctx) : value;
}

function recordCheckoutCreateFailure(
  ctx: PhaseContext,
  hash: string,
  roundIndex: number,
  axis: ReviewAxis,
  reviewer: ReviewProvider | undefined,
  err: unknown,
): void {
  if (reviewer === undefined) return;
  const started = startExecution(ctx, hash, roundIndex, axis, reviewer);
  failExecution(ctx, started, err instanceof Error ? err.message : String(err));
}

/**
 * Where a run goes when an axis cannot be reviewed. Named so a test can assert it against the gate
 * the engine uses rather than against a copy of the table.
 */
export const EXHAUSTED_NEXT_PHASE = "FAILED" as const;

/**
 * Axes that have already failed `cap` times in this round and are still not complete. Counted from
 * the persisted executions, so the bound holds across scheduler ticks rather than within one.
 */
export function exhaustedAxes(
  axes: readonly ReviewAxis[],
  roundExecutions: readonly ReviewExecution[],
  required: number,
  cap: number,
): ReviewAxis[] {
  const out: ReviewAxis[] = [];
  for (const axis of missingAxes(axes, roundExecutions, required)) {
    if (out.includes(axis)) continue;
    const failed = roundExecutions.filter(
      (execution) => execution.axis === axis && !execution.completed && isStickyReviewSkip(undefined, execution.error ?? ""),
    ).length;
    if (failed >= cap) out.push(axis);
  }
  return out;
}

function stopForExhaustedAxes(
  ctx: PhaseContext,
  hash: string,
  roundIndex: number,
  exhausted: readonly ReviewAxis[],
): { status: "complete"; nextPhase: typeof EXHAUSTED_NEXT_PHASE; terminalReason: TerminalReason } {
  const cap = ctx.config.review.maxAxisAttemptsPerRound;
  recordAxisExhausted(ctx, hash, roundIndex, exhausted, cap);
  // Terminal, not "proceed with the round marked unverified": VALIDATING would admit a checkpoint
  // that no reviewer ever saw, which is a worse failure than stopping.
  return {
    status: "complete",
    nextPhase: EXHAUSTED_NEXT_PHASE,
    terminalReason: {
      code: "providers_unavailable",
      summary: `review axis ${exhausted.join(", ")} failed ${String(cap)} times in round ${String(roundIndex)} with non-retryable provider errors`,
    },
  };
}

function recordAxisExhausted(
  ctx: PhaseContext,
  hash: string,
  roundIndex: number,
  axes: readonly ReviewAxis[],
  cap: number,
): void {
  const event: NewEvent = {
    id: id("evt", ctx.clock.now()),
    runId: ctx.run.id,
    ts: ctx.clock.now(),
    type: "review.axis_exhausted",
    payload: { checkpointHash: hash, roundIndex, axes: [...axes], attemptCap: cap },
    causedBy: [],
    actor: SYSTEM_ACTOR,
    artifacts: [],
  };
  ctx.store.events.append([event]);
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

/** Marks an execution that completed the round without calling a provider. */
const SKIP_REASON = "no_prior_findings";

function isSkippedExecution(execution: ReviewExecution): boolean {
  return execution.completed && execution.error === SKIP_REASON;
}

/**
 * The reviewer `reviewAxisWithFallback` would actually reach: its first choice, then the ring, passing
 * over models already rate-limited in this pass. `undefined` when every model is excluded, in which
 * case there is nothing to attribute a skip to and the normal path must run.
 */
function nextUsableReviewer(
  reviewers: readonly ReviewProvider[],
  preferredIndex: number,
  rateLimited: ReadonlySet<string>,
): ReviewProvider | undefined {
  for (let offset = 0; offset < reviewers.length; offset++) {
    const reviewer = reviewers[(preferredIndex + offset) % reviewers.length];
    if (reviewer === undefined) continue;
    if (rateLimited.has(modelRefKey(reviewer.model))) continue;
    return reviewer;
  }
  return undefined;
}

/**
 * True when `adversarial` may be skipped for this round: the flag is on, this is that axis, and every
 * already-completed other axis of the round reported nothing.
 *
 * Reads the store rather than the caller's pre-loop snapshot. An empty set of completed other axes is
 * not "clean" — with nothing observed yet there is no basis to skip.
 */
function adversarialSkipApplies(
  ctx: PhaseContext,
  checkpointHash: string,
  roundIndex: number,
  axis: ReviewAxis,
): boolean {
  if (!ctx.config.review.skipAdversarialWhenClean) return false;
  if (axis !== "adversarial") return false;
  // Scoped to this checkpoint and round: a clean verdict from another round is no evidence about
  // this one.
  const others = reviewRoundExecutions(
    ctx.store.repos.reviewExecutions.listByRun(ctx.run.id),
    checkpointHash,
    roundIndex,
  ).filter((execution) => execution.completed && execution.axis !== "adversarial");
  if (others.length === 0) return false;
  return others.every((execution) => execution.findings.length === 0);
}

/**
 * A completed execution that made no provider call. `completed: true` is required: `missingAxes` and
 * `isReviewRoundComplete` count only completed executions, so a skip recorded as incomplete would be
 * requeued on every tick.
 */
function skipExecution(
  ctx: PhaseContext,
  checkpointHash: string,
  roundIndex: number,
  axis: ReviewAxis,
  reviewer: ReviewProvider,
  reason: string,
): void {
  const started = startExecution(ctx, checkpointHash, roundIndex, axis, reviewer);
  const skipped: ReviewExecution = {
    ...started,
    completed: true,
    findings: [],
    error: reason,
    finishedAt: ctx.clock.now(),
  };
  assertExecutionCheckpoint(skipped, checkpointHash);
  appendReviewEvent(ctx, "review.finished", skipped);
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
