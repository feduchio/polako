import { dominates, type Checkpoint } from "../domain/checkpoint.js";

/** Most recent prior checkpoint whose evidence strictly dominates the current checkpoint. */
export function rollbackTarget(current: Checkpoint, prior: readonly Checkpoint[]): Checkpoint | null {
  return (
    prior
      .filter(
        (candidate) =>
          candidate.runId === current.runId &&
          candidate.seq < current.seq &&
          dominates(candidate.evidence, current.evidence),
      )
      .sort((a, b) => b.seq - a.seq)[0] ?? null
  );
}

/**
 * Roll back only when strict evidence dominance proves the current state is worse.
 * Incomparable checkpoints are intentionally left for human/ensemble judgment.
 */
export async function rollbackIfDominated(
  current: Checkpoint,
  prior: readonly Checkpoint[],
  applyRollback: (target: Checkpoint) => void | Promise<void>,
): Promise<Checkpoint | null> {
  const target = rollbackTarget(current, prior);
  if (target !== null) await applyRollback(target);
  return target;
}
