import type { ModelCapabilities } from "./types.js";

/**
 * Phase-B cost gate for dynamic routing (not C2 budget, not C8 audition).
 * Unknown/null prices are never treated as free.
 */
export type CostEligibilityMode = "free_only" | "ceiling" | "unrestricted";

export interface CostEligibilityPolicy {
  mode: CostEligibilityMode;
  /** USD per 1M input tokens; used when mode = "ceiling". */
  maxInputCostPerM: number;
  /** USD per 1M output tokens; used when mode = "ceiling". */
  maxOutputCostPerM: number;
}

export const FREE_ONLY_COST_ELIGIBILITY: CostEligibilityPolicy = {
  mode: "free_only",
  maxInputCostPerM: 0,
  maxOutputCostPerM: 0,
};

export const UNRESTRICTED_COST_ELIGIBILITY: CostEligibilityPolicy = {
  mode: "unrestricted",
  maxInputCostPerM: 0,
  maxOutputCostPerM: 0,
};

export interface RoutingCostConfig {
  costEligibility: CostEligibilityMode;
  maxInputCostPerM: number;
  maxOutputCostPerM: number;
}

export function costEligibilityFromConfig(routing: RoutingCostConfig): CostEligibilityPolicy {
  return {
    mode: routing.costEligibility,
    maxInputCostPerM: routing.maxInputCostPerM,
    maxOutputCostPerM: routing.maxOutputCostPerM,
  };
}

/** Both advertised prices must be present and exactly 0. Null is not free. */
export function isExplicitlyFree(capabilities: Pick<ModelCapabilities, "inputCostPerM" | "outputCostPerM">): boolean {
  return capabilities.inputCostPerM === 0 && capabilities.outputCostPerM === 0;
}

export function isCostEligible(
  capabilities: Pick<ModelCapabilities, "inputCostPerM" | "outputCostPerM">,
  policy: CostEligibilityPolicy,
): boolean {
  if (policy.mode === "unrestricted") return true;
  const input = capabilities.inputCostPerM;
  const output = capabilities.outputCostPerM;
  if (!isStatedPrice(input) || !isStatedPrice(output)) return false;
  if (policy.mode === "free_only") return input === 0 && output === 0;
  return input <= policy.maxInputCostPerM && output <= policy.maxOutputCostPerM;
}

/**
 * A price below zero is not a price. `free_only` rejected such a value by asking for exactly 0,
 * so the gap only opened when `ceiling` compared it with `<=` and every negative passed every
 * ceiling. The adapter that produced the sentinel now reports `null`
 * (`src/providers/openaiCompat.ts`); this is the invariant that does not depend on which adapter
 * asked.
 */
function isStatedPrice(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}
