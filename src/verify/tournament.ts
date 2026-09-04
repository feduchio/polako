import type { BaselineSnapshot } from "../domain/checks.js";
import { dominates, emptyFindingCounts, type EvidenceVector } from "../domain/checkpoint.js";
import { candidateMetrics, type CandidateMetrics, type VerifiableCandidate } from "./metrics.js";
import type {
  PairwiseContext,
  PairwiseVerdict,
  TournamentCandidate,
  VerifierClientKind,
  VerifierStrategy,
} from "./strategy.js";

export interface MatchEvidence {
  a: string;
  b: string;
  verdict: PairwiseVerdict;
}

export interface RankedCandidate {
  candidate: TournamentSourceCandidate;
  metrics: CandidateMetrics;
  points: number;
  wins: number;
  ties: number;
  losses: number;
  rank: number;
}

export interface TournamentResult {
  ranking: RankedCandidate[];
  evidence: MatchEvidence[];
}

export interface RunTournamentInput {
  candidates: readonly TournamentSourceCandidate[];
  baseline: BaselineSnapshot;
  strategy: VerifierStrategy;
  context: PairwiseContext;
  format?: "round-robin" | "swiss";
  swissRounds?: number;
}

export interface TournamentSourceCandidate extends VerifiableCandidate {
  status: string;
}

export type TournamentSelectionMethod = "none" | "deterministic" | "pairwise" | "ppt";

export interface TournamentSelection {
  winnerId: string | null;
  ranking: RankedCandidate[];
  evidence: MatchEvidence[];
  method: TournamentSelectionMethod;
  frontier: string[];
  backend?: "sidecar" | "ts";
  fallback?: boolean;
  logprobScheme?: "direct" | "two_stage";
  criteria?: string[];
  nComparisons?: number;
  client?: VerifierClientKind;
}

/** Candidates that passed independent gates and are not dominated on the evidence vector. */
export function deterministicFrontier(
  candidates: readonly TournamentSourceCandidate[],
  baseline: BaselineSnapshot,
): TournamentSourceCandidate[] {
  const eligible = filterEligible(candidates);
  const entries = eligible.map((source) => ({
    source,
    evidence: evidenceFromSource(source, baseline),
  }));
  return entries
    .filter((entry) =>
      !entries.some((other) =>
        other.source.id !== entry.source.id && dominates(other.evidence, entry.evidence)))
    .map((entry) => entry.source);
}

/**
 * Resolve a winner: deterministic dominance first; pairwise judge only when multiple
 * non-dominated survivors remain.
 */
export async function selectTournamentWinner(
  input: RunTournamentInput & {
    pivotFrom?: number;
    pivots?: number;
    repeats?: number;
    granularity?: number;
  },
): Promise<TournamentSelection> {
  const eligible = filterEligible(input.candidates);
  if (eligible.length === 0) {
    return { winnerId: null, ranking: [], evidence: [], method: "none", frontier: [] };
  }

  const frontier = deterministicFrontier(eligible, input.baseline);
  const frontierIds = frontier.map((candidate) => candidate.id);

  if (frontier.length === 1) {
    const winner = frontier[0];
    if (winner === undefined) {
      return { winnerId: null, ranking: [], evidence: [], method: "none", frontier: frontierIds };
    }
    const metrics = candidateMetrics(winner, input.baseline);
    return {
      winnerId: winner.id,
      ranking: [{
        candidate: winner,
        metrics,
        points: 0,
        wins: 0,
        ties: 0,
        losses: 0,
        rank: 1,
      }],
      evidence: [],
      method: "deterministic",
      frontier: frontierIds,
    };
  }

  if (input.strategy.selectFrontier !== undefined) {
    const tournamentCandidates = frontier.map((candidate) => toTournamentCandidate(candidate, input.baseline));
    const frontierOptions: {
      pivots: number;
      repeats?: number;
      granularity?: number;
    } = { pivots: input.pivots ?? 2 };
    if (input.repeats !== undefined) frontierOptions.repeats = input.repeats;
    if (input.granularity !== undefined) frontierOptions.granularity = input.granularity;
    const selection = await input.strategy.selectFrontier(tournamentCandidates, input.context, frontierOptions);
    const byId = new Map(frontier.map((candidate) => [candidate.id, candidate]));
    const ordered = selection.ranking
      .map((id) => byId.get(id))
      .filter((candidate): candidate is TournamentSourceCandidate => candidate !== undefined);
    const ranking: RankedCandidate[] = ordered.map((candidate, index) => ({
      candidate,
      metrics: candidateMetrics(candidate, input.baseline),
      points: selection.scores[candidate.id] ?? 0,
      wins: 0,
      ties: 0,
      losses: 0,
      rank: index + 1,
    }));
    const evidence: MatchEvidence[] = [{
      a: ordered[0]?.id ?? "ppt",
      b: ordered[1]?.id ?? ordered[0]?.id ?? "ppt",
      verdict: {
        winner: selection.winnerId,
        rationale: selection.rationale,
        scores: selection.scores,
      },
    }];
    return {
      winnerId: selection.winnerId,
      ranking,
      evidence,
      method: selection.method === "ppt" ? "ppt" : "pairwise",
      frontier: frontierIds,
      backend: "sidecar",
      fallback: selection.fallback,
      criteria: selection.criteria,
      nComparisons: selection.nComparisons,
      client: selection.client,
      ...(selection.logprobScheme === undefined ? {} : { logprobScheme: selection.logprobScheme }),
    };
  }

  const format = frontier.length >= (input.pivotFrom ?? 4) ? "swiss" : "round-robin";
  const result = await runTournament({ ...input, candidates: frontier, format });
  return {
    winnerId: result.ranking[0]?.candidate.id ?? null,
    ranking: result.ranking,
    evidence: result.evidence,
    method: "pairwise",
    frontier: frontierIds,
    backend: "ts",
    fallback: false,
    client: "none",
  };
}

/** Compare only independently gated candidates and retain every verdict as ranking evidence. */
export async function runTournament(input: RunTournamentInput): Promise<TournamentResult> {
  const eligible = filterEligible(input.candidates)
    .map((candidate) => ({
      source: candidate,
      tournament: toTournamentCandidate(candidate, input.baseline),
      points: 0,
      wins: 0,
      ties: 0,
      losses: 0,
    }));
  const evidence: MatchEvidence[] = [];

  if ((input.format ?? "round-robin") === "round-robin") {
    for (let i = 0; i < eligible.length; i++) {
      for (let j = i + 1; j < eligible.length; j++) {
        const a = eligible[i];
        const b = eligible[j];
        if (a !== undefined && b !== undefined) await play(a, b, input, evidence);
      }
    }
  } else {
    const rounds = input.swissRounds ?? Math.max(1, Math.ceil(Math.log2(Math.max(eligible.length, 2))));
    const played = new Set<string>();
    for (let round = 0; round < rounds; round++) {
      const ordered = [...eligible].sort(compareEntries);
      const paired = new Set<string>();
      for (let i = 0; i < ordered.length; i++) {
        const a = ordered[i];
        if (a === undefined || paired.has(a.source.id)) continue;
        const b = ordered.slice(i + 1).find((entry) =>
          !paired.has(entry.source.id) && !played.has(pairKey(a.source.id, entry.source.id)));
        if (b === undefined) continue;
        paired.add(a.source.id);
        paired.add(b.source.id);
        played.add(pairKey(a.source.id, b.source.id));
        await play(a, b, input, evidence);
      }
    }
  }

  const ordered = [...eligible].sort(compareEntries);
  return {
    ranking: ordered.map((entry, index) => ({
      candidate: entry.source,
      metrics: entry.tournament.metrics,
      points: entry.points,
      wins: entry.wins,
      ties: entry.ties,
      losses: entry.losses,
      rank: index + 1,
    })),
    evidence,
  };
}

function filterEligible(candidates: readonly TournamentSourceCandidate[]): TournamentSourceCandidate[] {
  return candidates.filter((candidate) => candidate.status === "passed" && candidate.gateResult?.passed === true);
}

function evidenceFromSource(candidate: TournamentSourceCandidate, baseline: BaselineSnapshot): EvidenceVector {
  const checks = candidate.gateResult?.checks ?? [];
  const gates: EvidenceVector["gates"] = {};
  for (const check of checks) gates[check.name] = check.status;
  const tests = checks.filter((check) => check.kind === "test");
  const metrics = candidateMetrics(candidate, baseline);
  return {
    gates,
    testsPassed: tests.filter((check) => check.status === "pass").length,
    testsFailed: tests.filter((check) =>
      check.status === "fail" || check.status === "error" || check.status === "timeout").length,
    testsTotal: tests.length,
    openValidatedFindings: emptyFindingCounts(),
    diffLinesFromBaseline: metrics.linesChanged,
  };
}

interface Entry {
  source: TournamentSourceCandidate;
  tournament: TournamentCandidate;
  points: number;
  wins: number;
  ties: number;
  losses: number;
}

async function play(
  a: Entry,
  b: Entry,
  input: RunTournamentInput,
  evidence: MatchEvidence[],
): Promise<void> {
  const verdict = await input.strategy.comparePair(a.tournament, b.tournament, input.context);
  if (verdict.winner !== null && verdict.winner !== a.source.id && verdict.winner !== b.source.id) {
    throw new TypeError(`verifier selected candidate outside pair: ${verdict.winner}`);
  }
  if (verdict.rationale.trim() === "") throw new TypeError("verifier rationale must not be empty");
  evidence.push({ a: a.source.id, b: b.source.id, verdict });
  if (verdict.winner === null) {
    a.points += 1;
    b.points += 1;
    a.ties++;
    b.ties++;
  } else if (verdict.winner === a.source.id) {
    a.points += 2;
    a.wins++;
    b.losses++;
  } else {
    b.points += 2;
    b.wins++;
    a.losses++;
  }
}

function toTournamentCandidate(candidate: TournamentSourceCandidate, baseline: BaselineSnapshot): TournamentCandidate {
  return {
    id: candidate.id,
    metrics: candidateMetrics(candidate, baseline),
    diffSummary: candidate.diffSummary,
    gateReport: candidate.gateResult === null
      ? null
      : {
          checks: candidate.gateResult.checks.map((check) => ({
            name: check.name,
            kind: check.kind,
            status: check.status,
          })),
          passed: candidate.gateResult.passed,
        },
  };
}

function compareEntries(a: Entry, b: Entry): number {
  return (
    b.points - a.points ||
    b.wins - a.wins ||
    a.tournament.metrics.newFailures - b.tournament.metrics.newFailures ||
    b.tournament.metrics.checksPassed - a.tournament.metrics.checksPassed ||
    a.tournament.metrics.linesChanged - b.tournament.metrics.linesChanged ||
    a.source.id.localeCompare(b.source.id)
  );
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}
