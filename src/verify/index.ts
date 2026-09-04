export { candidateMetrics, type CandidateMetrics, type VerifiableCandidate } from "./metrics.js";
export { PairwiseJudge, heuristicVerdict, type PairwiseJudgeOptions } from "./pairwise.js";
export {
  VerifierAdapter,
  createVerifierStrategy,
  decomposeCriteria,
  defaultPython,
  sidecarScriptPath,
  type VerifierProvenance,
  type VerifierSidecarOptions,
} from "./sidecar.js";
export type {
  FrontierSelectOptions,
  FrontierSelection,
  LogprobScheme,
  PairwiseContext,
  PairwiseVerdict,
  TournamentCandidate,
  VerifierBackend,
  VerifierClientKind,
  VerifierStrategy,
} from "./strategy.js";
export {
  deterministicFrontier,
  runTournament,
  selectTournamentWinner,
  type MatchEvidence,
  type RankedCandidate,
  type RunTournamentInput,
  type TournamentSelection,
  type TournamentSelectionMethod,
  type TournamentSourceCandidate,
  type TournamentResult,
} from "./tournament.js";
