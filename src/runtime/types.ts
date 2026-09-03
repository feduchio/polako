import type { RuntimeCapabilityClass, RuntimeEvidence, RuntimeValidationMode } from "../domain/acceptance.js";

export type RuntimeCapabilityMode = RuntimeValidationMode;
export type RuntimeSideEffectPolicy = "safe" | "explicit";

interface RuntimeScenarioBase {
  id: string;
  runId: string;
  /** Commit the scenario must execute against. */
  checkpointHash: string;
  timeoutMs?: number;
  sideEffectPolicy?: RuntimeSideEffectPolicy;
  /** Non-loopback hosts require explicit policy plus an exact hostname grant. */
  allowedNetworkHosts?: string[];
}

export interface NodeScriptScenario extends RuntimeScenarioBase {
  kind: "node_script";
  fixtureRoot: string;
  script: string;
  args?: string[];
}

export interface HttpSmokeScenario extends RuntimeScenarioBase {
  kind: "http_smoke";
  url: string;
  expectedStatus?: number;
  expectedBodyIncludes?: string;
}

export type RuntimeScenario = NodeScriptScenario | HttpSmokeScenario;

export interface RuntimeAvailability {
  available: boolean;
  capability: RuntimeCapabilityClass;
  reason?: string;
}

export interface RuntimeValidator {
  readonly id: string;
  supports(scenario: RuntimeScenario): boolean;
  availability(scenario: RuntimeScenario, signal?: AbortSignal): Promise<RuntimeAvailability>;
  validate(scenario: RuntimeScenario, signal?: AbortSignal): Promise<RuntimeEvidence>;
}

export interface RuntimeSelection {
  mode: RuntimeCapabilityMode;
  capability: RuntimeCapabilityClass;
  validator: RuntimeValidator | null;
  reason: string;
}

export class RuntimeUnavailableError extends Error {
  constructor(readonly reasons: string[]) {
    super(`runtime validation required but unavailable: ${reasons.join("; ")}`);
    this.name = "RuntimeUnavailableError";
  }
}

export interface ProjectRuntimeDiscovery {
  capability: RuntimeCapabilityClass;
  reason: string;
  templates: readonly DiscoveredRuntimeTemplate[];
}

export interface DiscoveredRuntimeTemplate {
  id: string;
  kind: "node_script";
  relativeScript: string;
  sideEffectPolicy: RuntimeSideEffectPolicy;
}
