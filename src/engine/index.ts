export { RunEngine } from "./engine.js";
export { installStubDrivers, stubDriverFor, STUB_NEXT } from "./stubs.js";
export {
  runCandidatesParallel,
  ScriptedCandidateWorker,
  type CandidateGates,
  type CandidateResult,
  type CandidateResultStatus,
  type CandidateWorker,
  type CandidateWorkerFactory,
  type RunCandidatesParallelInput,
  type WorkerOutcome,
} from "./candidates.js";
export {
  GitBranchRunHead,
  integrateWinner,
  type IntegrateWinnerInput,
  type IntegrationResult,
  type IntegrationStatus,
  type RunHead,
} from "./integration.js";
export type { EngineOptions, PhaseContext, PhaseDriver, PhaseDriverResult } from "./types.js";
