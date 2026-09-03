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

export interface VerifierStrategy {
  comparePair(
    a: TournamentCandidate,
    b: TournamentCandidate,
    context: PairwiseContext,
  ): Promise<PairwiseVerdict>;
}
