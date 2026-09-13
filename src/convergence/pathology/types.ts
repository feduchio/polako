import type { EvidenceVector } from "../../domain/checkpoint.js";
import type { Severity } from "../../domain/common.js";
import type { FindingStatus } from "../../domain/finding.js";
import type { C2StrategyAction, Pathology } from "../../domain/convergence.js";
import type { CheckpointChangeRecord } from "../../domain/convergence.js";
import type { ModelRef } from "../../domain/common.js";
import type { TaskWorkClass } from "../../domain/task.js";

export const PATHOLOGY_SAMPLE_VERSION = 2;

export interface FindingObservation {
  findingId?: string;
  fingerprint: string;
  status: FindingStatus;
  blocking: boolean;
  severity: Severity;
  checkpointHash: string;
  causalEventId: string;
  seq?: number;
}

export interface TaskWorkClassRecord {
  taskId: string;
  workClass: TaskWorkClass;
  classifiedBy: string | null;
  sourceRef: string | null;
  classificationEventId: string | null;
  kind: string;
  originKind: string;
  originFindingId?: string | null;
}

export interface CanonicalProgressVector {
  checkpointHash: string | null;
  evidence: EvidenceVector | null;
  integratedTaskIds: string[];
  resolvedValidBlockingFingerprints: string[];
  successfulGateFingerprints: string[];
  acceptedEvidenceRefs: string[];
  cleanRoundKeys: string[];
}

export interface DisagreementRound {
  checkpointHash: string;
  roundIndex: number;
  fingerprints: string[];
}

export interface PathologyBudgetLimits {
  maxRunTokens: number | null;
  maxRunUsd: number | null;
  maxTaskTokens: number | null;
  maxRunWallClockMinutes: number | null;
}

/**
 * The run's CLI budget as C2 sees it. Named for the era when it was never applied; the name
 * is load-bearing because these snapshots are persisted and read back unvalidated.
 */
export interface UnusedCliBudgetMetadata {
  budgetTokens: number | null;
  budgetUsd: number | null;
  applied: boolean;
}

export interface CanonicalBudgetUsage {
  runTokens: number;
  knownRunUsd: number;
  unknownCostCalls: string[];
  perTask: Record<string, number>;
  sourceWatermark: { seq: number; eventId: string } | null;
  usageConflict: boolean;
}

export interface PathologyBudgetSnapshot extends CanonicalBudgetUsage {
  elapsedMs: number;
  limits: PathologyBudgetLimits;
  unusedCliMetadata: UnusedCliBudgetMetadata;
  exhaustedDimensions: string[];
}

export interface PathologySample {
  version: 1 | typeof PATHOLOGY_SAMPLE_VERSION;
  runId: string;
  boundaryEventId: string;
  boundarySeq: number;
  observedAt: number;
  checkpointHash: string | null;
  findingObservations: FindingObservation[];
  progress: CanonicalProgressVector;
  disagreementRounds: DisagreementRound[];
  taskIds: string[];
  taskWorkClasses: TaskWorkClassRecord[];
  checkpointChanges?: CheckpointChangeRecord[];
  budget: PathologyBudgetSnapshot;
}

export interface DetectorFinding {
  kind: Pathology;
  sampleKeys: string[];
  evidenceRefs: string[];
  reason: string;
}

export type DecisionRecoveryState = "decided" | "effect_started" | "effect_completed";

export interface PathologyDecision {
  version: 1;
  runId: string;
  boundaryEventId: string;
  decisionVersion: 1;
  findings: DetectorFinding[];
  action: C2StrategyAction | null;
  reason: string;
  budget: PathologyBudgetSnapshot;
  targetCheckpointHash: string | null;
  targetEnsemble: ModelRef[] | null;
  targetReviewRoundIndex: number | null;
  causalEventIds: string[];
}

export function sampleKey(runId: string, boundaryEventId: string): string {
  return `${runId}:${boundaryEventId}`;
}

export function decisionKey(runId: string, boundaryEventId: string): string {
  return `${runId}:${boundaryEventId}:1`;
}
