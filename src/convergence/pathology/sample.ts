import type { Checkpoint, EvidenceVector } from "../../domain/checkpoint.js";
import type { CleanRound } from "../../domain/convergence.js";
import type { Event } from "../../domain/event.js";
import type { Finding, FindingValidation } from "../../domain/finding.js";
import type { ReviewExecution } from "../../domain/review.js";
import type { Task } from "../../domain/task.js";
import { defaultConfig, type PolishConfig } from "../../domain/config.js";
import { hashJson } from "../../shared/hash.js";
import { isReviewRoundComplete } from "../../domain/review.js";
import { buildPathologyBudgetSnapshot } from "./budget.js";
import {
  PATHOLOGY_SAMPLE_VERSION,
  type CanonicalProgressVector,
  type DisagreementRound,
  type FindingObservation,
  type PathologySample,
  type TaskWorkClassRecord,
} from "./types.js";

const OBSERVATION_TYPES = new Set([
  "review.finished",
  "finding.validated",
  "clean_round.recorded",
  "checkpoint.created",
  "checkpoint.rolled_back",
  "pathology.effect_completed",
  "budget.evaluated",
]);

export interface FoldedPrefix {
  runId: string;
  runCreatedAt: number;
  missionId: string | null;
  checkpointHash: string | null;
  checkpoints: Checkpoint[];
  findings: Finding[];
  validations: FindingValidation[];
  tasks: Task[];
  cleanRounds: CleanRound[];
  reviewExecutions: ReviewExecution[];
  findingObservations: FindingObservation[];
  acceptedEvidenceRefs: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sortById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

export function eventsThroughBoundary(events: readonly Event[], boundaryEventId: string): Event[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  const end = ordered.findIndex((event) => event.id === boundaryEventId);
  if (end < 0) return [];
  return ordered.slice(0, end + 1);
}

function requiredReviewersOf(requiredReviewers?: number): number {
  return requiredReviewers ?? defaultConfig().review.reviewersPerRound;
}

function reviewExecutionsIn(prefix: readonly Event[]): ReviewExecution[] {
  return prefix.flatMap((item) => {
    if (item.type !== "review.finished" && item.type !== "review.started") return [];
    const row = asRecord(item.payload["execution"]) as ReviewExecution | null;
    return row === null ? [] : [row];
  });
}

export function isObservationBoundary(event: Event, prefix: readonly Event[], requiredReviewers?: number): boolean {
  if (!OBSERVATION_TYPES.has(event.type)) return false;
  const required = requiredReviewersOf(requiredReviewers);
  if (event.type === "review.finished") {
    const execution = asRecord(event.payload["execution"]) as ReviewExecution | null;
    if (!execution?.completed) return false;
    return isReviewRoundComplete(reviewExecutionsIn(prefix), execution.checkpointHash, execution.roundIndex, required);
  }
  if (event.type === "finding.validated") {
    return completesValidationRound(event, prefix, required);
  }
  return true;
}

function completesValidationRound(event: Event, prefix: readonly Event[], requiredReviewers: number): boolean {
  const validation = asRecord(event.payload["validation"]) as FindingValidation | null;
  if (validation === null) return false;
  const fold = foldPrefix(prefix);
  const finding = fold.findings.find((item) => item.id === validation.findingId);
  if (finding === undefined) return false;
  const roundIndex = validationRoundIndex(validation, fold);
  if (roundIndex === null) return false;
  if (!isReviewRoundComplete(fold.reviewExecutions, finding.checkpointHash, roundIndex, requiredReviewers)) {
    return false;
  }
  const validationsForRound = fold.validations.filter((item) => {
    const owner = fold.findings.find((row) => row.id === item.findingId);
    if (owner?.checkpointHash !== finding.checkpointHash) return false;
    return validationRoundIndex(item, fold) === roundIndex;
  });
  const independent = new Set(
    validationsForRound.map((item) => {
      const model = item.performedBy.model;
      return model === undefined ? item.id : `${item.performedBy.kind}:${model.provider}:${model.model}`;
    }),
  );
  return independent.size >= requiredReviewers;
}

export function resolveObservationBoundary(events: readonly Event[], requiredReviewers?: number): Event | null {
  const ordered = [...events].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  const required = requiredReviewersOf(requiredReviewers);
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const event = ordered[i];
    if (event === undefined) continue;
    if (isObservationBoundary(event, ordered.slice(0, i + 1), required)) return event;
  }
  return null;
}

export function foldPrefix(events: readonly Event[]): FoldedPrefix {
  const ordered = [...events].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  let runId = "";
  let runCreatedAt = 0;
  let missionId: string | null = null;
  let checkpointHash: string | null = null;
  const checkpoints = new Map<string, Checkpoint>();
  const findings = new Map<string, Finding>();
  const validations = new Map<string, FindingValidation>();
  const tasks = new Map<string, Task>();
  const cleanRounds = new Map<string, CleanRound>();
  const reviews = new Map<string, ReviewExecution>();
  const findingObservations: FindingObservation[] = [];
  const acceptedEvidenceRefs = new Set<string>();

  for (const event of ordered) {
    runId = event.runId;
    const payload = event.payload;
    if (event.type === "run.created" || event.type === "run.phase_changed" || event.type === "run.terminated") {
      const run = asRecord(payload["run"]);
      if (run !== null) {
        if (typeof run["createdAt"] === "number") runCreatedAt = run["createdAt"];
        if (typeof run["missionId"] === "string") missionId = run["missionId"];
        const hash = run["currentCheckpointHash"];
        checkpointHash = typeof hash === "string" ? hash : null;
      }
    }
    if (event.type === "checkpoint.created") {
      const checkpoint = asRecord(payload["checkpoint"]) as Checkpoint | null;
      if (checkpoint !== null) {
        checkpoints.set(checkpoint.id, checkpoint);
        checkpointHash = checkpoint.commitHash;
      }
    }
    if (event.type === "finding.raised" || event.type === "finding.status_changed" || event.type === "finding.validated") {
      const finding = asRecord(payload["finding"]) as Finding | null;
      if (finding !== null) {
        findings.set(finding.id, finding);
        findingObservations.push({
          fingerprint: finding.fingerprint,
          status: finding.status,
          blocking: finding.blocking,
          severity: finding.severity,
          checkpointHash: finding.checkpointHash,
          causalEventId: event.id,
        });
      }
    }
    if (event.type === "finding.validated") {
      const validation = asRecord(payload["validation"]) as FindingValidation | null;
      if (validation !== null) validations.set(validation.id, validation);
    }
    if (event.type === "task.created" || event.type === "task.state_changed") {
      const task = asRecord(payload["task"]) as Task | null;
      if (task !== null) tasks.set(task.id, task);
    }
    if (event.type === "clean_round.recorded") {
      const cleanRound = asRecord(payload["cleanRound"]) as CleanRound | null;
      if (cleanRound !== null) cleanRounds.set(cleanRound.id, cleanRound);
    }
    if (event.type === "review.started" || event.type === "review.finished") {
      const execution = asRecord(payload["execution"]) as ReviewExecution | null;
      if (execution !== null) reviews.set(execution.id, execution);
    }
    if (event.type === "corpus.entry_added") {
      const entry = asRecord(payload["entry"]);
      const entryId = entry?.["id"];
      if (typeof entryId === "string") acceptedEvidenceRefs.add(entryId);
    }
    if (event.type === "acceptance.recorded") {
      const artifact = asRecord(payload["artifact"]);
      const artifactId = artifact?.["id"];
      if (typeof artifactId === "string") acceptedEvidenceRefs.add(artifactId);
    }
  }

  return {
    runId,
    runCreatedAt,
    missionId,
    checkpointHash,
    checkpoints: sortById([...checkpoints.values()]).sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id)),
    findings: sortById([...findings.values()]),
    validations: sortById([...validations.values()]),
    tasks: sortById([...tasks.values()]),
    cleanRounds: [...cleanRounds.values()].sort((a, b) => a.roundIndex - b.roundIndex || a.id.localeCompare(b.id)),
    reviewExecutions: sortById([...reviews.values()]),
    findingObservations,
    acceptedEvidenceRefs: [...acceptedEvidenceRefs].sort(),
  };
}

function currentEvidence(fold: FoldedPrefix): EvidenceVector | null {
  if (fold.checkpointHash === null) return null;
  const current = [...fold.checkpoints].reverse().find((checkpoint) => checkpoint.commitHash === fold.checkpointHash);
  return current?.evidence ?? null;
}

function successfulGateFingerprints(fold: FoldedPrefix): string[] {
  const out: string[] = [];
  for (const checkpoint of fold.checkpoints) {
    for (const name of Object.keys(checkpoint.evidence.gates).sort()) {
      if (checkpoint.evidence.gates[name] === "pass") out.push(`${checkpoint.commitHash}:${name}:pass`);
    }
  }
  return [...new Set(out)].sort();
}

function resolvedValidBlocking(fold: FoldedPrefix): string[] {
  const validBlocking = new Set<string>();
  const resolved = new Set<string>();
  for (const finding of fold.findings) {
    if (finding.blocking && (finding.status === "VALID" || finding.status === "RESOLVED")) {
      validBlocking.add(finding.fingerprint);
    }
    if (finding.status === "RESOLVED") resolved.add(finding.fingerprint);
  }
  return [...validBlocking].filter((fingerprint) => resolved.has(fingerprint)).sort();
}

export function progressVectorOf(fold: FoldedPrefix): CanonicalProgressVector {
  return {
    checkpointHash: fold.checkpointHash,
    evidence: currentEvidence(fold),
    integratedTaskIds: fold.tasks.filter((task) => task.state === "INTEGRATED").map((task) => task.id).sort(),
    resolvedValidBlockingFingerprints: resolvedValidBlocking(fold),
    successfulGateFingerprints: successfulGateFingerprints(fold),
    acceptedEvidenceRefs: fold.acceptedEvidenceRefs,
    cleanRoundKeys: fold.cleanRounds
      .filter((round) => fold.checkpointHash === null || round.checkpointHash === fold.checkpointHash)
      .map((round) => `${round.checkpointHash}:${round.roundIndex}:${round.reviewRoundIndex ?? 0}`)
      .sort(),
  };
}

function workClassRecords(fold: FoldedPrefix): TaskWorkClassRecord[] {
  return fold.tasks
    .map((task) => ({
      taskId: task.id,
      workClass: task.workClass ?? "functional",
      classifiedBy: task.classifiedBy ?? null,
      sourceRef: task.sourceRef ?? null,
      classificationEventId: task.classificationEventId ?? null,
      kind: task.kind,
      originKind: task.origin.kind,
    }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
}

function validationRoundIndex(validation: FindingValidation, fold: FoldedPrefix): number | null {
  const finding = fold.findings.find((item) => item.id === validation.findingId);
  if (finding === undefined) return null;
  const reviews = fold.reviewExecutions
    .filter((execution) => execution.checkpointHash === finding.checkpointHash && execution.completed)
    .sort((a, b) => a.roundIndex - b.roundIndex);
  const matching = reviews.filter((execution) => execution.finishedAt !== null && execution.finishedAt <= validation.createdAt);
  return matching.at(-1)?.roundIndex ?? reviews[0]?.roundIndex ?? null;
}

function opposingPositions(validations: readonly FindingValidation[]): boolean {
  const verdicts = new Set(validations.map((item) => item.verdict));
  if (verdicts.has("VALID") && verdicts.has("REJECTED")) return true;
  const uncertain = validations.filter((item) => item.verdict === "UNCERTAIN");
  if (uncertain.length === 0) return false;
  const validIds = new Set(validations.filter((item) => item.verdict === "VALID").flatMap((item) => [item.id, ...item.evidenceRefs.map((ref) => ref.sha256)]));
  const rejectedIds = new Set(
    validations.filter((item) => item.verdict === "REJECTED").flatMap((item) => [item.id, ...item.evidenceRefs.map((ref) => ref.sha256)]),
  );
  return uncertain.some((item) => {
    const refs = new Set([item.id, ...item.evidenceRefs.map((ref) => ref.sha256)]);
    const seesValid = [...refs].some((ref) => validIds.has(ref));
    const seesRejected = [...refs].some((ref) => rejectedIds.has(ref));
    return seesValid && seesRejected;
  });
}

export function disagreementRoundsOf(fold: FoldedPrefix, requiredReviewers?: number): DisagreementRound[] {
  const required = requiredReviewersOf(requiredReviewers);
  const byRound = new Map<string, { checkpointHash: string; roundIndex: number; validations: FindingValidation[] }>();
  for (const validation of fold.validations) {
    const finding = fold.findings.find((item) => item.id === validation.findingId);
    if (finding === undefined) continue;
    const roundIndex = validationRoundIndex(validation, fold);
    if (roundIndex === null) continue;
    const key = `${finding.checkpointHash}:${roundIndex}`;
    const bucket = byRound.get(key) ?? { checkpointHash: finding.checkpointHash, roundIndex, validations: [] };
    bucket.validations.push(validation);
    byRound.set(key, bucket);
  }

  const rounds: DisagreementRound[] = [];
  for (const key of [...byRound.keys()].sort()) {
    const bucket = byRound.get(key);
    if (bucket === undefined) continue;
    if (!isReviewRoundComplete(fold.reviewExecutions, bucket.checkpointHash, bucket.roundIndex, required)) continue;
    const byFingerprint = new Map<string, FindingValidation[]>();
    for (const validation of bucket.validations) {
      const finding = fold.findings.find((item) => item.id === validation.findingId);
      if (finding === undefined) continue;
      const list = byFingerprint.get(finding.fingerprint) ?? [];
      list.push(validation);
      byFingerprint.set(finding.fingerprint, list);
    }
    const fingerprints = [...byFingerprint.entries()]
      .filter(([, validations]) => opposingPositions(validations))
      .map(([fingerprint]) => fingerprint)
      .sort();
    rounds.push({ checkpointHash: bucket.checkpointHash, roundIndex: bucket.roundIndex, fingerprints });
  }
  return rounds.sort((a, b) => a.checkpointHash.localeCompare(b.checkpointHash) || a.roundIndex - b.roundIndex);
}

export function buildPathologySample(input: {
  events: readonly Event[];
  boundary: Event;
  config: Pick<PolishConfig, "budget" | "review">;
  cliBudget?: { budgetTokens?: number | null; budgetUsd?: number | null } | undefined;
}): PathologySample {
  const prefix = eventsThroughBoundary(input.events, input.boundary.id);
  const fold = foldPrefix(prefix);
  const observations = [...fold.findingObservations].sort(
    (a, b) => a.fingerprint.localeCompare(b.fingerprint) || a.causalEventId.localeCompare(b.causalEventId),
  );
  return {
    version: PATHOLOGY_SAMPLE_VERSION,
    runId: fold.runId || input.boundary.runId,
    boundaryEventId: input.boundary.id,
    boundarySeq: input.boundary.seq,
    observedAt: input.boundary.ts,
    checkpointHash: fold.checkpointHash,
    findingObservations: observations,
    progress: progressVectorOf(fold),
    disagreementRounds: disagreementRoundsOf(fold, input.config.review.reviewersPerRound),
    taskIds: fold.tasks.map((task) => task.id).sort(),
    taskWorkClasses: workClassRecords(fold),
    budget: buildPathologyBudgetSnapshot({
      events: prefix,
      observedAt: input.boundary.ts,
      runCreatedAt: fold.runCreatedAt || input.boundary.ts,
      config: input.config,
      cliBudget: input.cliBudget,
    }),
  };
}

export function hashPathologySample(sample: PathologySample): string {
  return hashJson(sample);
}

export function progressImproved(previous: CanonicalProgressVector, next: CanonicalProgressVector): boolean {
  if (hashJson(previous) === hashJson(next)) return false;
  const prevGates = new Set(previous.successfulGateFingerprints);
  const prevTasks = new Set(previous.integratedTaskIds);
  const prevFindings = new Set(previous.resolvedValidBlockingFingerprints);
  const prevEvidence = new Set(previous.acceptedEvidenceRefs);
  const prevClean = new Set(previous.cleanRoundKeys);
  if (next.successfulGateFingerprints.some((item) => !prevGates.has(item))) return true;
  if (next.integratedTaskIds.some((item) => !prevTasks.has(item))) return true;
  if (next.resolvedValidBlockingFingerprints.some((item) => !prevFindings.has(item))) return true;
  if (next.acceptedEvidenceRefs.some((item) => !prevEvidence.has(item))) return true;
  if (next.cleanRoundKeys.some((item) => !prevClean.has(item))) return true;
  if (previous.evidence !== null && next.evidence !== null && hashJson(next.evidence) !== hashJson(previous.evidence)) {
    return next.evidence.testsPassed > previous.evidence.testsPassed || next.evidence.testsFailed < previous.evidence.testsFailed;
  }
  return false;
}
