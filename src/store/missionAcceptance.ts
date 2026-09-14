import {
  AcceptanceArtifactSchema,
  CORPUS_EXECUTABLE_STATUS,
  CorpusEntrySchema,
  RuntimeEvidenceSchema,
  type AcceptanceArtifact,
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

const NON_EXECUTABLE_TERMINAL_STATUSES = new Set<string>([
  CORPUS_EXECUTABLE_STATUS.noTestFile,
  CORPUS_EXECUTABLE_STATUS.noFixingTask,
  CORPUS_EXECUTABLE_STATUS.runtimeOnly,
]);

export class MissionAcceptanceService {
  constructor(
    private readonly store: MissionAcceptanceStore,
    private readonly clock: Clock,
  ) {}

  record(input: Omit<CorpusEntry, "id" | "createdAt" | "executable"> & { id?: string; executable?: CorpusEntry["executable"] }): CorpusEntry {
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
      metadata: {
        scenarioId: input.scenarioId,
        ...(input.metadata ?? {}),
        executableStatus: CORPUS_EXECUTABLE_STATUS.runtimeOnly,
      },
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
        executableStatus: CORPUS_EXECUTABLE_STATUS.runtimeOnly,
      },
      runtimeEvidence: evidence,
    });
  }

  /**
   * Attach the executable artifact to an existing entry, after the fixing task has integrated.
   *
   * The artifact event and the amended entry are appended in **one** `append`, which runs in a
   * transaction, so a failure leaves neither. `acceptance.recorded` is the event
   * `acceptance_artifacts` is projected from, and nothing else in the tree emits it — see
   * finding 53 — so this is where a protected artifact first comes into existence.
   */
  admitExecutable(input: { entryId: string; artifact: AcceptanceArtifact }): CorpusEntry {
    const existing = this.store.repos.acceptanceCorpus.get(input.entryId);
    if (existing === null) {
      throw new PolishError("INVARIANT_VIOLATION", "corpus entry to admit an executable for does not exist", {
        entryId: input.entryId,
      });
    }
    const artifact = AcceptanceArtifactSchema.parse(input.artifact);
    const entry = CorpusEntrySchema.parse({
      ...existing,
      executable: {
        artifactId: artifact.id,
        relativePath: artifact.relativePath,
        sha256: artifact.sha256,
      },
      metadata: { ...existing.metadata, executableStatus: CORPUS_EXECUTABLE_STATUS.admitted },
    });
    this.store.events.append([
      {
        id: id("evt", this.clock.now()),
        runId: artifact.runId,
        ts: this.clock.now(),
        type: "acceptance.recorded",
        payload: { artifact },
        causedBy: [],
        actor: SYSTEM_ACTOR,
        artifacts: [],
      },
      {
        id: id("evt", this.clock.now()),
        runId: entry.sourceRunId,
        ts: this.clock.now(),
        type: "corpus.entry_added",
        payload: { entry },
        causedBy: [],
        actor: SYSTEM_ACTOR,
        artifacts: [],
      },
    ]);
    return entry;
  }

  /**
   * Record a terminal non-executable outcome or an admission error. Recognised absence statuses
   * are skipped; every other status remains fail-closed at the next gate.
   */
  recordExecutableAbsent(input: { entryId: string; reason: string }): CorpusEntry {
    const existing = this.store.repos.acceptanceCorpus.get(input.entryId);
    if (existing === null) {
      throw new PolishError("INVARIANT_VIOLATION", "corpus entry to record an absent executable for does not exist", {
        entryId: input.entryId,
      });
    }
    const entry = CorpusEntrySchema.parse({
      ...existing,
      executable: null,
      metadata: { ...existing.metadata, executableStatus: input.reason },
    });
    this.store.events.append([{
      id: id("evt", this.clock.now()),
      runId: entry.sourceRunId,
      ts: this.clock.now(),
      type: "corpus.entry_added",
      payload: { entry },
      causedBy: [],
      actor: SYSTEM_ACTOR,
      artifacts: [],
    }]);
    return entry;
  }

  get(missionId: string): MissionAcceptanceCorpus {
    return this.store.repos.acceptanceCorpus.forMission(missionId);
  }
}

/**
 * The artifacts a candidate's gate must inject, protect and hash-verify: the task's own plus
 * every executable the mission corpus has admitted.
 *
 * A **legacy** entry — one with no `executable` and no recognised status — throws. The current
 * fixing task may pass its own `pending_integration` entry; a different task may not. `docs/PLAN.md`
 * P1.8 says to fail closed on an entry that cannot be mapped to a path rather than guess one.
 */
export function acceptanceArtifactsForGate(
  taskArtifacts: readonly AcceptanceArtifact[],
  corpus: MissionAcceptanceCorpus | undefined,
  resolveArtifact: (artifactId: string) => AcceptanceArtifact | undefined,
  pendingFindingId?: string,
): AcceptanceArtifact[] {
  const byId = new Map(taskArtifacts.map((artifact) => [artifact.id, artifact]));
  for (const entry of corpus?.entries ?? []) {
    if (entry.executable === null) {
      const status = entry.metadata["executableStatus"];
      if (typeof status === "string" && NON_EXECUTABLE_TERMINAL_STATUSES.has(status)) continue;
      if (
        status === CORPUS_EXECUTABLE_STATUS.pendingIntegration &&
        entry.metadata["findingId"] === pendingFindingId
      ) {
        continue;
      }
      throw new PolishError("INVARIANT_VIOLATION", `unmappable_legacy_corpus_entry: ${entry.id}`, {
        entryId: entry.id,
        kind: entry.kind,
        ...(typeof status === "string" ? { executableStatus: status } : {}),
      });
    }
    const artifact = resolveArtifact(entry.executable.artifactId);
    if (artifact === undefined) {
      throw new PolishError("INVARIANT_VIOLATION", `unmappable_legacy_corpus_entry: ${entry.id}`, {
        entryId: entry.id,
        artifactId: entry.executable.artifactId,
        reason: "admitted artifact is not in the store",
      });
    }
    byId.set(artifact.id, artifact);
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
