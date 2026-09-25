import type { CandidateMetrics } from "./metrics.js";
import type { TaskKind } from "../domain/task.js";
import type { ModelRef } from "../domain/common.js";

export interface TournamentCandidate {
  id: string;
  metrics: CandidateMetrics;
  summary?: string;
  diffSummary?: { files: number; insertions: number; deletions: number };
  gateReport?: {
    checks: { name: string; kind: string; status: string }[];
    passed: boolean;
  } | null;
  diff?: string;
}

export interface PairwiseContext {
  runId: string;
  taskId?: string;
  task?: string;
  acceptance?: string[];
  taskKind?: TaskKind;
}

export interface PairwiseVerdict {
  winner: string | null;
  rationale: string;
  scores: Record<string, number>;
}

export type LogprobScheme = "direct" | "two_stage";
export type ScoreScheme = "empirical_repeats";
export type VerifierBackend = "ts" | "empirical";
export type VerifierClientKind = "scripted" | "live" | "none";

export interface FrontierSelectOptions {
  pivots?: number;
  repeats?: number;
  granularity?: number;
  criteria?: string[];
  onError?: "tie" | "raise";
}

export interface FrontierSelection {
  winnerId: string | null;
  ranking: string[];
  scores: Record<string, number>;
  rationale: string;
  method: "ppt" | "pairwise";
  fallback: boolean;
  logprobScheme?: LogprobScheme;
  claimedLogprobScheme?: LogprobScheme;
  scoreScheme?: ScoreScheme;
  backend?: VerifierBackend;
  models?: ModelRef[];
  requestedEvaluations?: number;
  completedEvaluations?: number;
  fallbackReason?: string | null;
  criteria: string[];
  nComparisons: number;
  client: VerifierClientKind;
}

export interface VerifierStrategy {
  comparePair(
    a: TournamentCandidate,
    b: TournamentCandidate,
    context: PairwiseContext,
  ): Promise<PairwiseVerdict>;
  selectFrontier?(
    candidates: readonly TournamentCandidate[],
    context: PairwiseContext,
    options?: FrontierSelectOptions,
  ): Promise<FrontierSelection>;
  /** Release a held sidecar child. Production COMPARING must call this after the phase. */
  close?(): void;
}
