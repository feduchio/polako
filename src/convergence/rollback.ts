import { SYSTEM_ACTOR } from "../domain/common.js";
import type { Checkpoint } from "../domain/checkpoint.js";
import type { NewEvent } from "../domain/event.js";
import type { Run } from "../domain/run.js";
import { id } from "../shared/ids.js";

export interface RunHead {
  read(): Promise<string>;
  compareAndSet(expected: string, next: string): Promise<boolean>;
}

export interface RollbackCheckpointInput {
  run: Run;
  current: Checkpoint;
  target: Checkpoint;
  runHead: RunHead;
  now: number;
}

export interface RollbackCheckpointResult {
  checkpoint: Checkpoint | null;
  events: NewEvent[];
  advanced: boolean;
}

/**
 * Advances the durable run head to the dominating prior commit, then records a rollback
 * checkpoint. Does not stash or reset the user's working tree. Callers must serialize this
 * through the integration lane. CAS failure does not emit a checkpoint or move the run hash.
 */
export async function createRollbackCheckpoint(input: RollbackCheckpointInput): Promise<RollbackCheckpointResult> {
  const previousHead = await input.runHead.read();
  const advanced = await input.runHead.compareAndSet(previousHead, input.target.commitHash);
  if (!advanced) {
    return { checkpoint: null, events: [], advanced: false };
  }
  const checkpoint: Checkpoint = {
    id: id("cp", input.now),
    runId: input.run.id,
    seq: input.current.seq + 1,
    commitHash: input.target.commitHash,
    parentId: input.current.id,
    source: "rollback",
    taskId: null,
    evidence: input.target.evidence,
    createdAt: input.now,
  };
  const updatedRun: Run = {
    ...input.run,
    currentCheckpointHash: checkpoint.commitHash,
    updatedAt: input.now,
  };
  const events: NewEvent[] = [
    {
      id: id("evt", input.now),
      runId: input.run.id,
      ts: input.now,
      type: "checkpoint.created",
      payload: { checkpoint },
      causedBy: [],
      actor: SYSTEM_ACTOR,
      artifacts: [],
    },
    {
      id: id("evt", input.now + 1),
      runId: input.run.id,
      ts: input.now + 1,
      type: "run.phase_changed",
      payload: { run: updatedRun },
      causedBy: [],
      actor: SYSTEM_ACTOR,
      artifacts: [],
    },
  ];
  return { checkpoint, events, advanced: true };
}
