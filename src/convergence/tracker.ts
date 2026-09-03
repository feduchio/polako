import type { ModelRef } from "../domain/common.js";
import { CleanRoundSchema, cleanRoundsFor, hasConverged, isNovelRound, type CleanRound } from "../domain/convergence.js";
import type { ReviewAxis } from "../domain/finding.js";
import type { Clock } from "../shared/clock.js";
import { id } from "../shared/ids.js";

export interface CleanRoundDraft {
  checkpointHash: string;
  axes: ReviewAxis[];
  ensemble: ModelRef[];
  rawFindings: number;
}

/**
 * Keeps historical rounds for reporting, while every count is scoped to the active hash.
 * Calling setCheckpoint after any integration, simplification, or rollback therefore
 * invalidates the old count without destroying audit history.
 */
export class CleanRoundTracker {
  private checkpointHash: string;
  private readonly history: CleanRound[];

  constructor(
    private readonly runId: string,
    checkpointHash: string,
    private readonly clock: Clock,
    initial: readonly CleanRound[] = [],
  ) {
    this.checkpointHash = checkpointHash;
    this.history = [...initial];
  }

  setCheckpoint(checkpointHash: string): void {
    this.checkpointHash = checkpointHash;
  }

  currentCheckpoint(): string {
    return this.checkpointHash;
  }

  record(draft: CleanRoundDraft): CleanRound {
    if (draft.checkpointHash !== this.checkpointHash) {
      throw new Error(`cannot record clean round for stale checkpoint ${draft.checkpointHash}`);
    }
    const current = this.currentRounds();
    const basis = {
      checkpointHash: draft.checkpointHash,
      axes: draft.axes,
      ensemble: draft.ensemble,
    };
    const round = CleanRoundSchema.parse({
      id: id("cr", this.clock.now()),
      runId: this.runId,
      ...draft,
      roundIndex: (current.at(-1)?.roundIndex ?? 0) + 1,
      validatedBlocking: 0,
      novel: isNovelRound(this.history, basis),
      createdAt: this.clock.now(),
    });
    this.history.push(round);
    return round;
  }

  currentRounds(): CleanRound[] {
    return cleanRoundsFor(this.history, this.checkpointHash);
  }

  allRounds(): readonly CleanRound[] {
    return this.history;
  }

  hasRequired(requiredCleanRounds: number): boolean {
    if (!Number.isInteger(requiredCleanRounds) || requiredCleanRounds < 1) {
      throw new RangeError("requiredCleanRounds must be a positive integer");
    }
    return hasConverged(this.history, this.checkpointHash, requiredCleanRounds);
  }
}

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
