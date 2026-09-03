import type { Actor } from "../domain/common.js";
import type { Event } from "../domain/event.js";
import type { NewEvent } from "../domain/event.js";
import {
  ProtectedChangeWaiverSchema,
  assertValidWaiverActors,
  evidenceScopeMatchesWaiver,
  extractWaiverEvidenceScope,
  isWaiverEvidenceEventType,
  normalizeWaiverPath,
  type ProtectedChangeWaiver,
} from "../domain/protectedChangeWaiver.js";
import { PolishError } from "../shared/errors.js";
import type { Clock } from "../shared/clock.js";
import { id } from "../shared/ids.js";
import type { EventLog } from "./eventLog.js";

interface WaiverStore {
  events: EventLog;
}

function sameActor(a: Actor, b: Actor): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function waiverMatchesRecorded(recorded: ProtectedChangeWaiver, candidate: ProtectedChangeWaiver): boolean {
  return recorded.id === candidate.id
    && recorded.runId === candidate.runId
    && recorded.missionId === candidate.missionId
    && recorded.taskId === candidate.taskId
    && recorded.requirementId === candidate.requirementId
    && recorded.baseCheckpointHash === candidate.baseCheckpointHash
    && recorded.findingKind === candidate.findingKind
    && recorded.causeEventId === candidate.causeEventId
    && recorded.pathScope.length === candidate.pathScope.length
    && recorded.pathScope.every((path, index) => path === candidate.pathScope[index])
    && sameActor(recorded.issuedBy, candidate.issuedBy)
    && sameActor(recorded.validatedBy, candidate.validatedBy)
    && recorded.justification === candidate.justification;
}

function assertEvidenceMatchesWaiver(evidence: Event, waiver: ProtectedChangeWaiver): void {
  if (evidence.runId !== waiver.runId || !isWaiverEvidenceEventType(evidence.type)) {
    throw new PolishError("INVARIANT_VIOLATION", "waiver requires same-run independently validated evidence", {
      causeEventId: waiver.causeEventId,
    });
  }
  if (!sameActor(evidence.actor, waiver.validatedBy)) {
    throw new PolishError("INVARIANT_VIOLATION", "waiver validator must be the actor that produced its evidence");
  }
  const scope = extractWaiverEvidenceScope(evidence);
  if (!scope || !evidenceScopeMatchesWaiver(scope, waiver)) {
    throw new PolishError("INVARIANT_VIOLATION", "waiver evidence scope does not match declared waiver", {
      causeEventId: waiver.causeEventId,
      evidenceType: evidence.type,
    });
  }
}

export class ProtectedChangeWaiverService {
  constructor(
    private readonly store: WaiverStore,
    private readonly clock: Clock,
  ) {}

  record(input: Omit<ProtectedChangeWaiver, "id" | "createdAt"> & { id?: string }): ProtectedChangeWaiver {
    assertValidWaiverActors(input.issuedBy, input.validatedBy);
    const waiver = ProtectedChangeWaiverSchema.parse({
      ...input,
      pathScope: input.pathScope.map((path) => normalizeWaiverPath(path)),
      id: input.id ?? id("waiv", this.clock.now()),
      createdAt: this.clock.now(),
    });
    const evidence = this.store.events.get(waiver.causeEventId);
    if (!evidence) {
      throw new PolishError("INVARIANT_VIOLATION", "waiver requires same-run independently validated evidence", {
        causeEventId: waiver.causeEventId,
      });
    }
    assertEvidenceMatchesWaiver(evidence, waiver);
    const event: NewEvent = {
      id: id("evt", this.clock.now()),
      runId: waiver.runId,
      ts: this.clock.now(),
      type: "protected_change.waiver_recorded",
      payload: { waiver },
      causedBy: [waiver.causeEventId],
      actor: waiver.issuedBy,
      artifacts: [],
    };
    this.store.events.append([event]);
    return waiver;
  }

  /**
   * Store-backed gate authority check. A schema-valid object is insufficient: the causal
   * evidence and the service-recorded waiver event must both still validate.
   */
  isValidated(candidate: ProtectedChangeWaiver): boolean {
    const parsed = ProtectedChangeWaiverSchema.safeParse({
      ...candidate,
      pathScope: candidate.pathScope.map((path) => normalizeWaiverPath(path)),
    });
    if (!parsed.success) return false;
    const waiver = parsed.data;
    const evidence = this.store.events.get(waiver.causeEventId);
    if (!evidence) return false;
    try {
      assertEvidenceMatchesWaiver(evidence, waiver);
    } catch {
      return false;
    }
    return this.store.events.list(waiver.runId, { types: ["protected_change.waiver_recorded"] }).some((recorded) => {
      const recordedWaiver = ProtectedChangeWaiverSchema.safeParse(recorded.payload["waiver"]);
      return recordedWaiver.success &&
        waiverMatchesRecorded(recordedWaiver.data, waiver) &&
        recorded.causedBy.includes(waiver.causeEventId) &&
        sameActor(recorded.actor, waiver.issuedBy);
    });
  }
}
