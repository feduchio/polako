import { modelRefKey, type ModelRef } from "../domain/common.js";
import {
  UNRESTRICTED_COST_ELIGIBILITY,
  isCostEligible,
  isExplicitlyFree,
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
  // `NaN` is not a small number, and a comparator that lets one through is not antisymmetric:
  // NaN < x and NaN > x are both false, so both orderings would return the same answer.
  if (!Number.isFinite(input) || !Number.isFinite(output)) return Number.POSITIVE_INFINITY;
  return (input ?? 0) + (output ?? 0);
}

/**
 * Build the bounded probe shortlist for one provider: pinned supervisor models first (never
 * dropped, even if paid), then declared-tool models that pass cost eligibility, up to
 * maxProbesPerProvider.
 *
 * The order is by family, not by price alone. Cheapest-first filled every slot with `:free`
 * routes, which share one account allowance and mostly lack strict schemas, so one family passed
 * and every cross-model check ran on one model (`docs/ledger/R11-I9.md`). Each family gets a slot
 * before any family gets a second, and explicitly free and priced routes alternate, so a ceiling
 * that admits paid models actually probes some.
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

  return [...pinned, ...diverseOrder(ranked, maxProbesPerProvider, pinned)];
}

function diverseOrder(ranked: readonly ModelInfo[], limit: number, pinned: readonly ModelInfo[]): ModelInfo[] {
  const free = ranked.filter((model) => isExplicitlyFree(model.capabilities));
  const priced = ranked.filter((model) => !isExplicitlyFree(model.capabilities));
  const queues = [free, priced];
  const picked: ModelInfo[] = [];
  const pickedKeys = new Set<string>();
  const families = new Set<string>(pinned.map((model) => model.capabilities.family));
  const take = (model: ModelInfo): void => {
    picked.push(model);
    pickedKeys.add(modelRefKey(model.ref));
    families.add(model.capabilities.family);
  };
  // First pass: one model per family, alternating free and priced.
  const cursors = [0, 0];
  let progressed = true;
  while (picked.length < limit && progressed) {
    progressed = false;
    for (const [index, queue] of queues.entries()) {
      if (picked.length >= limit) break;
      let cursor = cursors[index] ?? 0;
      while (cursor < queue.length && families.has(queue[cursor]?.capabilities.family ?? "")) cursor += 1;
      cursors[index] = cursor + 1;
      const model = queue[cursor];
      if (model === undefined) continue;
      take(model);
      progressed = true;
    }
  }
  // Second pass: the rest in rank order, once every family has had its slot.
  for (const model of ranked) {
    if (picked.length >= limit) break;
    if (!pickedKeys.has(modelRefKey(model.ref))) take(model);
  }
  return picked;
}
