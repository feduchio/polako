import type { ModelRef } from "../domain/common.js";
import { isNovelRound, type CleanRound } from "../domain/convergence.js";
import type { ReviewAxis } from "../domain/finding.js";

export interface EnsembleOption {
  ensemble: ModelRef[];
  quality: number;
}

/**
 * Rotation is only a tie-breaker among the highest-quality eligible options. It never
 * selects a lower-quality ensemble merely to manufacture novelty.
 */
export function preferRotatedEnsemble(
  options: readonly EnsembleOption[],
  previous: readonly CleanRound[],
  checkpointHash: string,
  axes: readonly ReviewAxis[],
  minQualityForRotation: number,
): ModelRef[] | null {
  if (options.length === 0) return null;
  const ranked = [...options].sort((a, b) => b.quality - a.quality);
  const top = ranked[0];
  if (top === undefined) return null;
  const bestQuality = top.quality;
  const best = ranked.filter((option) => option.quality === bestQuality);
  const fallback = best[0];
  if (fallback === undefined) return null;
  if (bestQuality < minQualityForRotation) return fallback.ensemble;
  const selected =
    best.find((option) =>
      isNovelRound(previous, { checkpointHash, axes: [...axes], ensemble: option.ensemble }),
    ) ?? fallback;
  return selected.ensemble;
}
