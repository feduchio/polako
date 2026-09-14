import type { PolishConfig } from "../domain/config.js";
import type { Run, TerminalReason } from "../domain/run.js";
import type { Clock } from "../shared/clock.js";
import type { Store } from "../store/index.js";
import type { FinalReportInput, InterimReportInput, NeedsHumanReportInput } from "./reports.js";
import { SemanticEventLog } from "./semanticLog.js";

export interface ReportContext {
  run: Run;
  store: Store;
  clock: Clock;
  config: PolishConfig;
}

const PHASE_EVENT_TYPES: Readonly<Record<string, readonly string[]>> = {
  mission: ["mission.recorded", "mission.interpreted"],
  baseline: ["baseline.snapshotted"],
  planning: ["task.created", "supervisor.decision"],
  execution: ["candidate.created", "candidate.state_changed", "candidate.gated", "candidate.compared"],
  integration: ["integration.started", "integration.finished", "checkpoint.created"],
  review: ["review.started", "review.finished", "finding.raised", "finding.validated", "finding.status_changed"],
  convergence: ["clean_round.recorded"],
};

export function buildFinalReportInput(ctx: ReportContext): FinalReportInput {
  const { run, store } = ctx;
  const events = store.events.list(run.id);
  const mission = store.repos.missions.get(run.missionId);
  const baseline = store.repos.baselines.listByRun(run.id)[0];
  const tasks = store.repos.tasks.listByRun(run.id);
  const candidates = store.repos.candidates.listByRun(run.id);
  const checkpoints = store.repos.checkpoints.listByRun(run.id);
  const reviews = store.repos.reviewExecutions.listByRun(run.id);
  const validations = store.repos.validations.listByRun(run.id);
  const cleanRounds = store.repos.cleanRounds.listByRun(run.id);
  const corpus = store.repos.acceptanceCorpus.forMission(run.missionId);

  const checkpointHash = run.currentCheckpointHash;
  const failure = run.phase === "FAILED" ? run.terminalReason : null;
  const summary =
    failure !== null
      ? failure.summary
      : checkpointHash === null
        ? "Mission complete"
        : `Mission complete at checkpoint ${checkpointHash}`;

  const changes: string[] = [];
  if (mission !== null) changes.push(`Mission: ${mission.text}`);
  if (run.interpretationId !== null) changes.push(`Interpretation: ${run.interpretationId}`);
  if (baseline !== undefined) changes.push(`Baseline checkpoint: ${baseline.commitHash}`);
  for (const task of tasks) changes.push(`Task ${task.id}`);
  for (const candidate of candidates) {
    if (candidate.headCommit !== null) {
      changes.push(`Candidate ${candidate.id} commit ${candidate.headCommit}`);
    }
  }

  const integration = checkpoints.filter((checkpoint) => checkpoint.source === "integration");
  for (const checkpoint of integration) {
    changes.push(`Integration checkpoint ${checkpoint.commitHash} (task ${checkpoint.taskId ?? "none"})`);
  }

  if (checkpointHash !== null) {
    const current = checkpoints.find((checkpoint) => checkpoint.commitHash === checkpointHash);
    if (current !== undefined && baseline !== undefined) {
      changes.push(
        `Diff vs baseline: ${current.evidence.diffLinesFromBaseline} lines from ${baseline.commitHash} to ${checkpointHash}`,
      );
    }
  }

  const checks: string[] = [];
  for (const candidate of candidates) {
    if (candidate.gateReport === null) continue;
    const status = candidate.gateReport.passed ? "pass" : "fail";
    const checkCount = candidate.gateReport.checks.length;
    checks.push(
      `Candidate ${candidate.id} gates ${status} at ${candidate.gateReport.gatedCommit} (${checkCount} checks)`,
    );
  }

  const rejected: string[] = [];
  const winners = candidates.filter((candidate) => candidate.state === "WINNER");
  for (const candidate of candidates.filter((candidate) => candidate.state === "LOSER")) {
    rejected.push(`Candidate ${candidate.id} (${candidate.headCommit ?? "no commit"})`);
  }

  const evidence: string[] = [];
  for (const winner of winners) {
    evidence.push(`Winner ${winner.id} from task ${winner.taskId} commit ${winner.headCommit ?? "unknown"}`);
  }
  for (const compared of events.filter((event) => event.type === "candidate.compared")) {
    const winner = compared.payload["winner"];
    if (typeof winner === "string") evidence.push(`Compared winner ${winner} (event ${compared.id})`);
  }
  for (const entry of corpus.entries) {
    const runtime = entry.runtimeEvidence;
    if (runtime?.runId === run.id) {
      evidence.push(`Runtime evidence ${runtime.id} at checkpoint ${runtime.checkpointHash} (${runtime.status})`);
    }
  }

  const findings = store.repos.findings.listByRun(run.id).map(
    (finding) => `${finding.id} [${finding.status}] ${finding.claim}`,
  );

  const validation = validations.map(
    (item) => `${item.id} finding ${item.findingId}: ${item.verdict}`,
  );

  const convergence: string[] = [];
  for (const round of cleanRounds) {
    const reviewRound = round.reviewRoundIndex;
    const proof = reviews
      .filter(
        (execution) =>
          reviewRound !== undefined &&
          execution.completed &&
          execution.checkpointHash === round.checkpointHash &&
          execution.roundIndex === reviewRound,
      )
      .map((execution) => execution.id);
    const reviewSuffix = reviewRound === undefined ? "" : ` review round ${reviewRound}`;
    const proofSuffix = proof.length > 0 ? ` proof [${proof.join(", ")}]` : "";
    convergence.push(`Round ${round.roundIndex}${reviewSuffix} on ${round.checkpointHash}${proofSuffix}`);
  }

  for (const execution of reviews) {
    if (!convergence.some((line) => line.includes(execution.id))) {
      convergence.push(`Review ${execution.id} ${execution.axis} round ${execution.roundIndex} on ${execution.checkpointHash}`);
    }
  }

  const reasons = whyChainLines(ctx, seedEntityId(candidates, checkpointHash));

  return {
    ...(failure === null ? {} : { outcome: "failed" as const }),
    summary,
    changes,
    reasons,
    rejected,
    checks,
    findings,
    validation,
    convergence,
    evidence,
  };
}

export function buildInterimReportInput(ctx: ReportContext): InterimReportInput {
  const { run, store } = ctx;
  const events = store.events.list(run.id);
  const eventTypes = new Set(events.map((event) => event.type));

  const completed: string[] = [];
  for (const [phase, types] of Object.entries(PHASE_EVENT_TYPES)) {
    if (types.some((type) => eventTypes.has(type))) completed.push(phase);
  }

  const inProgress = [run.phase.toLowerCase().replaceAll("_", " ")];
  return {
    action: `Continue ${run.phase}`,
    completed,
    inProgress,
  };
}

export function buildNeedsHumanReportInput(reason: TerminalReason): NeedsHumanReportInput {
  const question = reason.question ?? reason.summary;
  const options = reason.options ?? ["Clarify and continue", "Stop the run"];
  return {
    question,
    options,
    context: reason.summary,
  };
}

export function mentionedPhases(events: readonly { type: string }[]): string[] {
  const eventTypes = new Set(events.map((event) => event.type));
  return Object.entries(PHASE_EVENT_TYPES)
    .filter(([, types]) => types.some((type) => eventTypes.has(type)))
    .map(([phase]) => phase);
}

function seedEntityId(
  candidates: ReturnType<Store["repos"]["candidates"]["listByRun"]>,
  checkpointHash: string | null,
): string | null {
  const winner = candidates.find((candidate) => candidate.state === "WINNER");
  if (winner !== undefined) return winner.id;
  const withCommit = candidates.find((candidate) => candidate.headCommit !== null);
  if (withCommit !== undefined) return withCommit.id;
  if (checkpointHash !== null) return checkpointHash;
  return null;
}

function whyChainLines(ctx: ReportContext, entityId: string | null): string[] {
  if (entityId === null) return [];
  const chain = new SemanticEventLog(ctx.store.events.list(ctx.run.id)).whyChain(entityId);
  return chain.map((step) => step.summary);
}
