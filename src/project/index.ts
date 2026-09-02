export { ProjectRegistry, defaultCheckCommands, ProjectProfileSchema, type ProjectProfile, type RegistryEntry } from "./profile.js";
export { discoverProject, ProfileCache, profileCacheKey } from "./discovery.js";
export { parseTestOutput, statusFromProcess } from "./parsers.js";
export {
  buildBaselineSnapshot,
  detectSilencing,
  runChecks,
  runIndependentGates,
  type CheckRunOptions,
  type GateResult,
  type SilencingFinding,
} from "./checkRunner.js";
