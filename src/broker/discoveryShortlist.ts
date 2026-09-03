import { modelRefKey, type ModelRef } from "../domain/common.js";
import {
  UNRESTRICTED_COST_ELIGIBILITY,
  isCostEligible,
  type CostEligibilityPolicy,
} from "./costEligibility.js";
import type { ModelInfo } from "./types.js";

function estimatedCostPerM(cap: ModelInfo["capabilities"]): number {
  return (cap.inputCostPerM ?? 0) + (cap.outputCostPerM ?? 0);
}

/**
 * Build the bounded probe shortlist for one provider: pinned supervisor models first
 * (never dropped, even if paid), then cheapest declared-tool models that pass cost
 * eligibility, up to maxProbesPerProvider. Cataloging of paid models happens elsewhere.
 */
export function buildDiscoveryShortlist(
  models: readonly ModelInfo[],
  providerId: string,
  pinnedRefs: readonly ModelRef[],
  maxProbesPerProvider: number,
  costEligibility: CostEligibilityPolicy = UNRESTRICTED_COST_ELIGIBILITY,
): ModelInfo[] {
  const byKey = new Map(models.map((model) => [modelRefKey(model.ref), model]));
  const pinned: ModelInfo[] = [];
  const pinnedKeys = new Set<string>();
  for (const ref of pinnedRefs) {
    if (ref.provider !== providerId) continue;
    const model = byKey.get(modelRefKey(ref));
    if (model === undefined) continue;
    pinned.push(model);
    pinnedKeys.add(modelRefKey(ref));
  }

  const ranked = models
    .filter((model) => !pinnedKeys.has(modelRefKey(model.ref)))
    .filter((model) => model.capabilities.supportsTools)
    .filter((model) => isCostEligible(model.capabilities, costEligibility))
    .sort((left, right) => {
      const costDelta = estimatedCostPerM(left.capabilities) - estimatedCostPerM(right.capabilities);
      if (costDelta !== 0) return costDelta;
      return left.ref.model.localeCompare(right.ref.model);
    });

  return [...pinned, ...ranked.slice(0, maxProbesPerProvider)];
}
