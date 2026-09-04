import type { CandidateMetrics } from "./metrics.js";

export interface TournamentCandidate {
  id: string;
  metrics: CandidateMetrics;
  summary?: string;
  diffSummary?: { files: number; insertions: number; deletions: number };
  gateReport?: {
    checks: { name: string; kind: string; status: string }[];
    passed: boolean;
  } | null;
}

export interface PairwiseContext {
  runId: string;
  task?: string;
  acceptance?: string[];
}

export interface PairwiseVerdict {
  winner: string | null;
  rationale: string;
  scores: Record<string, number>;
}

export type LogprobScheme = "direct" | "two_stage";
export type VerifierBackend = "sidecar" | "ts";
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
}
