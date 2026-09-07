export { probeModelCapabilities } from "./capabilityProbe.js";
export type { CapabilityProbeCheck, CapabilityProbeChecks, CapabilityProbeResult, ProbeVerdict } from "./capabilityProbe.js";
export { buildDiscoveryShortlist } from "./discoveryShortlist.js";
export {
  costEligibilityFromConfig,
  FREE_ONLY_COST_ELIGIBILITY,
  isCostEligible,
  isExplicitlyFree,
  UNRESTRICTED_COST_ELIGIBILITY,
} from "./costEligibility.js";
export type { CostEligibilityMode, CostEligibilityPolicy, RoutingCostConfig } from "./costEligibility.js";
export * from "./types.js";
export { ModelCatalog } from "./catalog.js";
export type { CatalogDiscoveryOptions, CatalogEntry, ModelStats } from "./catalog.js";
export { ModelRouter, DEFAULT_ROUTER_POLICY } from "./router.js";
export type { ModelRole, Ranked, RouterPolicy, SelectionRequest } from "./router.js";
export { QuotaTracker, BudgetTracker, isBudgetError } from "./quota.js";
export type { BudgetLimits, BudgetSnapshot, ProviderLimits } from "./quota.js";
export { SecretStore, parseDotenv } from "./secrets.js";
export { ModelBroker, DEFAULT_RETRY_POLICY } from "./broker.js";
export type { BrokerDeps, ModelCallRecord, RetryPolicy } from "./broker.js";
export { ModelObservationRepository, DEFAULT_MIN_SCORES_FOR_ROUTING } from "./observations.js";
export type {
  ModelObservation,
  ModelObservationRepositoryOptions,
  ObservationRestoreOptions,
} from "./observations.js";
export {
  MicroTaskAuditionStrategy,
  ModelAuditioner,
  NoopAuditionStrategy,
  createAuditionStrategyFromConfig,
  exactMatchScorer,
} from "./audition.js";
export type {
  AuditionCompleter,
  AuditionResult,
  AuditionScorer,
  AuditionStrategy,
  AuditionTask,
  AuditionTaskScore,
  ModelAuditionerOptions,
} from "./audition.js";
