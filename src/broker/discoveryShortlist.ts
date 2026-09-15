import { modelRefKey, type ModelRef } from "../domain/common.js";
import {
  UNRESTRICTED_COST_ELIGIBILITY,
  isCostEligible,
  type CostEligibilityPolicy,
} from "./costEligibility.js";
import type { ModelInfo } from "./types.js";

/**
 * Cheapest first, and a model whose price is unknown is not cheap. Treating `null` as 0 sorted
 * unpriced routes ahead of free ones, which is how `openrouter/fusion` came to be probed first
 * and billed at 17x the ceiling (`docs/ledger/R0-run.md`). Under `free_only` and `ceiling` the
 * eligibility filter has already removed them; this is what `unrestricted` needs.
 */
function estimatedCostPerM(cap: ModelInfo["capabilities"]): number {
  const input = cap.inputCostPerM;
  const output = cap.outputCostPerM;
  if (input === null || output === null) return Number.POSITIVE_INFINITY;
  return input + output;
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
      // Compared, not subtracted: two unknown prices are both Infinity, and Infinity - Infinity is
      // NaN, which `sort` reads as "equal" and which silently skips the name tie-break.
      const leftCost = estimatedCostPerM(left.capabilities);
      const rightCost = estimatedCostPerM(right.capabilities);
      if (leftCost !== rightCost) return leftCost < rightCost ? -1 : 1;
      return left.ref.model.localeCompare(right.ref.model);
    });

  return [...pinned, ...ranked.slice(0, maxProbesPerProvider)];
}
