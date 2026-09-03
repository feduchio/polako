import type { Checkpoint } from "../domain/checkpoint.js";
import { Git } from "../sandbox/git.js";

export interface CheckpointReviewArtifact {
  commitHash: string;
  diffBase: string | null;
  diff: string;
  checkpoint: Checkpoint;
}

/** Build the integrated checkpoint artifact reviewers must see (never a candidate worktree). */
export async function buildCheckpointReviewArtifact(input: {
  projectPath: string;
  checkpoint: Checkpoint;
  baselineCommit: string | null;
  parentCommit: string | null;
}): Promise<CheckpointReviewArtifact> {
  const diffBase = input.parentCommit ?? input.baselineCommit;
  const git = new Git(input.projectPath);
  const diff = diffBase === null ? "" : await git.diff(diffBase, input.checkpoint.commitHash);
  return {
    commitHash: input.checkpoint.commitHash,
    diffBase,
    diff,
    checkpoint: input.checkpoint,
  };
}
