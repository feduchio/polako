export { assertCodeChangeMissionMayComplete, missionRequiresCodeChange, type MissionCompletionEvidence, type MissionMayCompleteResult } from "./antiFakeDone.js";
export { ConvergenceController, type ConvergenceDecision, type ConvergenceState } from "./controller.js";
export { rollbackIfDominated, rollbackTarget } from "./dominance.js";
export {
  buildCleanRoundFromReview,
  cleanRoundsHaveReviewProof,
  completedReviewRoundIndexes,
  latestCompletedReviewRound,
  nextUnconsumedCompletedReviewRound,
  recordCleanRoundEvent,
  type RecordCleanRoundInput,
} from "./record.js";
export { createRollbackCheckpoint, type RollbackCheckpointInput, type RollbackCheckpointResult, type RunHead } from "./rollback.js";
export { CleanRoundTracker, preferRotatedEnsemble, type CleanRoundDraft, type EnsembleOption } from "./tracker.js";
