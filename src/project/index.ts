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
export { parseTestOutput, parseNodeTest, statusFromProcess } from "./parsers.js";
export { buildBaselineEvidenceView } from "./baselineEvidence.js";
export type { BaselineCheckEvidence, CheckOutputReader } from "./baselineEvidence.js";
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
  dependenciesUnavailableFor,
  ensureProjectDependencies,
  EnvironmentNotReadyError,
  runChecks,
  runIndependentGates,
  untrustedChecks,
  type CheckRunOptions,
  type DependencyPreparation,
  type EnsureDependenciesResult,
  type BaselineCheckRunOptions,
  type CheckRunEvaluation,
  type CheckOutputPersister,
  type ForensicCheckOutput,
  type GateResult,
  type BaselineFlakinessEvidence,
  type BaselineStabilityResult,
  type SilencingFinding,
} from "./checkRunner.js";
