export {
  ProjectRegistry,
  defaultCheckCommands,
  ProfileScoutFindingSchema,
  ProjectProfileSchema,
  type ProfileScoutFinding,
  type ProjectProfile,
  type RegistryEntry,
} from "./profile.js";
export { discoverProject, inspectManifestHashes, ProfileCache, profileCacheKey } from "./discovery.js";
export { parseTestOutput, statusFromProcess } from "./parsers.js";
export {
  assertRepositoryClean,
  checkRepositoryClean,
  isRepositoryDirty,
  type RepositoryCleanliness,
  type RepositoryStartPolicy,
} from "./cleanliness.js";
export {
  assessBaselineStability,
  buildBaselineSnapshot,
  createCheckOutputPersister,
  detectSilencing,
  inspectCanonicalAcceptance,
  runChecks,
  runIndependentGates,
  type CheckRunOptions,
  type BaselineCheckRunOptions,
  type CheckRunEvaluation,
  type CheckOutputPersister,
  type ForensicCheckOutput,
  type GateResult,
  type BaselineFlakinessEvidence,
  type BaselineStabilityResult,
  type SilencingFinding,
} from "./checkRunner.js";
