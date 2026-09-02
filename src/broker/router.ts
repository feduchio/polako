import { modelRefKey, type ModelRef } from "../domain/common.js";
import type { CatalogEntry, ModelCatalog } from "./catalog.js";
import { TIER_RANK, type ModelTier } from "./types.js";

export type ModelRole = "worker" | "reviewer" | "verifier" | "judge" | "supervisor" | "scout" | "evidence";

export interface SelectionRequest {
  role: ModelRole;
  count: number;
  minTier?: ModelTier;
  requireTools?: boolean;
  requireJson?: boolean;
  minContextWindow?: number;
  /** models that must not be selected (e.g. the implementer, when picking its reviewers) */
  exclude?: ModelRef[];
  /** families to steer away from as a soft preference (novelty across rounds) */
  avoidFamilies?: string[];
  /** explicit user-pinned choices (config); returned first if eligible */
  pinned?: ModelRef[];
}

export interface RouterPolicy {
  /** quality prior per tier used until observations exist */
  priorByTier: Record<ModelTier, number>;
  /** below this expected quality a model is never picked just for diversity */
  minQualityForRotation: number;
  /** weight of cost in the score (0 = ignore cost) */
  costWeight: number;
  /** penalty applied per recent failure ratio */
  failurePenalty: number;
  /** bonus for a family not in `avoidFamilies` / not already chosen */
  diversityBonus: number;
}

export const DEFAULT_ROUTER_POLICY: RouterPolicy = {
  priorByTier: { frontier: 0.85, strong: 0.7, fast: 0.5 },
  minQualityForRotation: 0.6,
  costWeight: 0.05,
  failurePenalty: 0.5,
  diversityBonus: 0.08,
};

export interface Ranked {
  entry: CatalogEntry;
  score: number;
  reasons: string[];
}

/**
 * Capability- and evidence-driven selection. No model names in code. Diversity (family
 * rotation, "not the implementer") is a soft bonus applied only above `minQualityForRotation`,
 * so novelty never forces a known-worse model.
 */
export class ModelRouter {
  constructor(
    private readonly catalog: ModelCatalog,
    private readonly policy: RouterPolicy = DEFAULT_ROUTER_POLICY,
  ) {}

  rank(req: SelectionRequest): Ranked[] {
    const excluded = new Set((req.exclude ?? []).map(modelRefKey));
    const avoid = new Set(req.avoidFamilies ?? []);
    const eligible = this.catalog.list().filter((e) => {
      if (!e.available || excluded.has(modelRefKey(e.info.ref))) return false;
      const c = e.info.capabilities;
      if (req.minTier && TIER_RANK[c.tier] < TIER_RANK[req.minTier]) return false;
      if (req.requireTools && !c.supportsTools) return false;
      if (req.requireJson && !c.supportsJson) return false;
      if (req.minContextWindow !== undefined && c.contextWindow < req.minContextWindow) return false;
      return true;
    });

    return eligible
      .map((entry) => {
        const reasons: string[] = [];
        const base = this.expectedQuality(entry);
        reasons.push(`quality=${base.toFixed(2)}${entry.stats.quality === null ? " (prior)" : ""}`);
        let score = base;
        const failRatio = entry.stats.calls > 0 ? entry.stats.failures / entry.stats.calls : 0;
        if (failRatio > 0) {
          score -= failRatio * this.policy.failurePenalty;
          reasons.push(`failures=${(failRatio * 100).toFixed(0)}%`);
        }
        const cost = (entry.info.capabilities.inputCostPerM ?? 0) + (entry.info.capabilities.outputCostPerM ?? 0);
        if (cost > 0 && this.policy.costWeight > 0) {
          const penalty = Math.min(0.3, Math.log10(1 + cost) * this.policy.costWeight);
          score -= penalty;
          reasons.push(`cost-${penalty.toFixed(2)}`);
        }
        if (base >= this.policy.minQualityForRotation && !avoid.has(entry.info.capabilities.family)) {
          score += this.policy.diversityBonus;
          reasons.push("diverse-family");
        }
        return { entry, score, reasons };
      })
      .sort((a, b) => b.score - a.score || modelRefKey(a.entry.info.ref).localeCompare(modelRefKey(b.entry.info.ref)));
  }

  /**
   * Pick `count` models. Pinned eligible models come first; the rest are the top-ranked with a
   * greedy family-spread: after each pick, same-family candidates lose the diversity bonus.
   */
  select(req: SelectionRequest): Ranked[] {
    const ranked = this.rank(req);
    const picked: Ranked[] = [];
    const pinnedKeys = new Set((req.pinned ?? []).map(modelRefKey));
    for (const r of ranked) if (pinnedKeys.has(modelRefKey(r.entry.info.ref)) && picked.length < req.count) picked.push(r);

    const chosenFamilies = new Set(picked.map((p) => p.entry.info.capabilities.family));
    const rest = ranked.filter((r) => !picked.includes(r));
    while (picked.length < req.count && rest.length > 0) {
      let bestIdx = 0;
      let bestScore = -Infinity;
      rest.forEach((r, i) => {
        const dup = chosenFamilies.has(r.entry.info.capabilities.family);
        const s = dup && r.reasons.includes("diverse-family") ? r.score - this.policy.diversityBonus : r.score;
        if (s > bestScore) {
          bestScore = s;
          bestIdx = i;
        }
      });
      const [chosen] = rest.splice(bestIdx, 1);
      if (!chosen) break;
      picked.push(chosen);
      chosenFamilies.add(chosen.entry.info.capabilities.family);
    }
    return picked;
  }

  private expectedQuality(e: CatalogEntry): number {
    return e.stats.quality ?? this.policy.priorByTier[e.info.capabilities.tier];
  }
}
