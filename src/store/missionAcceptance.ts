import {
  CorpusEntrySchema,
  RuntimeEvidenceSchema,
  type CorpusEntry,
  type MissionAcceptanceCorpus,
  type RuntimeEvidence,
} from "../domain/acceptance.js";
import { SYSTEM_ACTOR } from "../domain/common.js";
import type { NewEvent } from "../domain/event.js";
import { PolishError } from "../shared/errors.js";
import type { Clock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import type { EventLog } from "./eventLog.js";
import type { Repositories } from "./repositories.js";

interface MissionAcceptanceStore {
  events: EventLog;
  repos: Repositories;
}

export class MissionAcceptanceService {
  constructor(
    private readonly store: MissionAcceptanceStore,
    private readonly clock: Clock,
  ) {}

  record(input: Omit<CorpusEntry, "id" | "createdAt"> & { id?: string }): CorpusEntry {
    const sourceRun = this.store.repos.runs.get(input.sourceRunId);
    if (sourceRun?.missionId !== input.missionId) {
      throw new PolishError(
        "INVARIANT_VIOLATION",
        "corpus source run must belong to the entry mission",
        { sourceRunId: input.sourceRunId, missionId: input.missionId },
      );
    }
    for (const evidenceId of input.evidenceRefs) {
      const evidence = this.store.events.get(evidenceId);
      if (evidence?.runId !== input.sourceRunId) {
        throw new PolishError("INVARIANT_VIOLATION", "corpus evidence must exist in the source run", { evidenceId });
      }
    }
    const entry = CorpusEntrySchema.parse({
      ...input,
      id: input.id ?? id("corp", this.clock.now()),
      createdAt: this.clock.now(),
    });
    const event: NewEvent = {
      id: id("evt", this.clock.now()),
      runId: entry.sourceRunId,
      ts: this.clock.now(),
      type: "corpus.entry_added",
      payload: { entry },
      causedBy: entry.evidenceRefs,
      actor: SYSTEM_ACTOR,
      artifacts: [],
    };
    this.store.events.append([event]);
    return entry;
  }

  recordRuntimeScenario(input: {
    missionId: string;
    sourceRunId: string;
    requirementRef: string;
    scenarioId: string;
    summary: string;
    metadata?: Record<string, unknown>;
    evidenceRefs?: string[];
    artifactHashes?: string[];
  }): CorpusEntry {
    return this.record({
      missionId: input.missionId,
      sourceRunId: input.sourceRunId,
      requirementRef: input.requirementRef,
      kind: "runtime_scenario",
      summary: input.summary,
      evidenceRefs: input.evidenceRefs ?? [],
      artifactHashes: input.artifactHashes ?? [],
      metadata: { scenarioId: input.scenarioId, ...(input.metadata ?? {}) },
    });
  }

  recordRuntimeEvidence(input: {
    missionId: string;
    requirementRef: string;
    evidence: RuntimeEvidence;
    evidenceRefs?: string[];
    summary?: string;
    /** When set, evidence for any other checkpoint is rejected rather than recorded. */
    expectedCheckpointHash?: string;
  }): CorpusEntry {
    const evidence = RuntimeEvidenceSchema.parse(input.evidence);
    if (input.expectedCheckpointHash !== undefined && evidence.checkpointHash !== input.expectedCheckpointHash) {
      throw new PolishError("INVARIANT_VIOLATION", "runtime evidence checkpoint does not match the expected checkpoint", {
        expectedCheckpointHash: input.expectedCheckpointHash,
        evidenceCheckpointHash: evidence.checkpointHash,
      });
    }
    return this.record({
      missionId: input.missionId,
      sourceRunId: evidence.runId,
      requirementRef: input.requirementRef,
      kind: "runtime_evidence",
      summary: input.summary ?? evidence.summary,
      evidenceRefs: input.evidenceRefs ?? [],
      artifactHashes: evidence.artifactHashes,
      metadata: {
        scenarioId: evidence.scenarioId,
        validator: evidence.validator,
        status: evidence.status,
        checkpointHash: evidence.checkpointHash,
      },
      runtimeEvidence: evidence,
    });
  }

  get(missionId: string): MissionAcceptanceCorpus {
    return this.store.repos.acceptanceCorpus.forMission(missionId);
  }
}
