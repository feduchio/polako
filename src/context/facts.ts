import { SYSTEM_ACTOR } from "../domain/common.js";
import {
  FactStrictSchema,
  assertVerifiedFactEvidence,
  filterResolvableProvenanceRefs,
  filterVerifiedEvidenceRefs,
  isFactPromotionEvidenceType,
  promoteToVerified,
  provenanceStrength,
  type Fact,
} from "../domain/fact.js";
import type { NewEvent } from "../domain/event.js";
import type { Clock } from "../shared/clock.js";
import { PolishError } from "../shared/errors.js";
import { id } from "../shared/ids.js";
import type { Store } from "../store/index.js";

function normalizeStatement(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function sameIdList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

/**
 * Event-sourced facts API. Promotion `llm_inferred → verified` requires a deterministic
 * evidence event id; confidence never promotes. Direct `verified` records are rejected unless
 * every evidence ref is valid same-run allowlisted evidence.
 */
export class FactsService {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
  ) {}

  record(input: Omit<Fact, "id" | "createdAt" | "updatedAt" | "supersededBy"> & { id?: string }): Fact {
    const now = this.clock.now();
    const fact = FactStrictSchema.parse({
      ...input,
      id: input.id ?? id("fact", now),
      supersededBy: null,
      createdAt: now,
      updatedAt: now,
    });
    assertVerifiedFactEvidence(fact, this.store.events);
    this.append(fact.runId, "fact.recorded", { fact });
    return fact;
  }

  promote(factId: string, evidenceEventId: string): Fact {
    const current = this.requireFact(factId);
    const evidence = this.store.events.get(evidenceEventId);
    if (evidence?.runId !== current.runId || !isFactPromotionEvidenceType(evidence.type)) {
      throw new PolishError("INVARIANT_VIOLATION", "fact promotion requires allowlisted same-run evidence", {
        factId,
        evidenceEventId,
        evidenceType: evidence?.type ?? null,
      });
    }
    const promoted = promoteToVerified(current, evidenceEventId, this.clock.now());
    this.append(promoted.runId, "fact.promoted", { fact: promoted }, [evidenceEventId]);
    return this.requireFact(factId);
  }

  supersede(
    oldFactId: string,
    replacement: Omit<Fact, "id" | "createdAt" | "updatedAt" | "supersededBy" | "runId"> & {
      id?: string;
      runId?: string;
    },
  ): Fact {
    const old = this.requireFact(oldFactId);
    const now = this.clock.now();
    const neu = FactStrictSchema.parse({
      ...replacement,
      id: replacement.id ?? id("fact", now),
      runId: replacement.runId ?? old.runId,
      supersededBy: null,
      createdAt: now,
      updatedAt: now,
    });
    assertVerifiedFactEvidence(neu, this.store.events);
    const outdated: Fact = { ...old, supersededBy: neu.id, updatedAt: now };
    this.appendBatch(old.runId, [
      this.newEvent(old.runId, "fact.recorded", { fact: neu }),
      this.newEvent(old.runId, "fact.superseded", { fact: outdated }),
    ]);
    return neu;
  }

  /**
   * Keep the strongest normalized semantic duplicate, then the newest/id-stable winner.
   * Evidence and provenance references are unioned onto that winner after validation.
   */
  consolidate(runId: string): { kept: number; superseded: number } {
    const current = this.store.repos.facts.listCurrent(runId);
    const groups = new Map<string, Fact[]>();
    for (const fact of current) {
      const key = normalizeStatement(fact.statement);
      groups.set(key, [...(groups.get(key) ?? []), fact]);
    }
    let superseded = 0;
    for (const duplicates of groups.values()) {
      duplicates.sort(
        (a, b) =>
          provenanceStrength(b.provenanceKind) - provenanceStrength(a.provenanceKind)
          || b.updatedAt - a.updatedAt
          || a.id.localeCompare(b.id),
      );
      const [winner, ...losers] = duplicates;
      if (winner === undefined) continue;
      if (losers.length === 0) continue;
      const now = this.clock.now();
      const mergedEvidence = filterVerifiedEvidenceRefs(
        runId,
        duplicates.flatMap((f) => f.evidenceRefs),
        this.store.events,
      );
      const mergedProvenance = filterResolvableProvenanceRefs(
        runId,
        duplicates.flatMap((f) => f.provenanceRefs),
        this.store.events,
      );
      const batch: NewEvent[] = [];
      if (mergedProvenance.length > 0) {
        const merged: Fact = FactStrictSchema.parse({
          ...winner,
          provenanceRefs: mergedProvenance,
          evidenceRefs: mergedEvidence,
          updatedAt: now,
        });
        assertVerifiedFactEvidence(merged, this.store.events);
        if (
          !sameIdList(merged.provenanceRefs, winner.provenanceRefs)
          || !sameIdList(merged.evidenceRefs, winner.evidenceRefs)
        ) {
          batch.push(this.newEvent(runId, "fact.recorded", { fact: merged }));
        }
      }
      for (const loser of losers) {
        const outdated: Fact = { ...loser, supersededBy: winner.id, updatedAt: now };
        batch.push(this.newEvent(runId, "fact.superseded", { fact: outdated }));
        superseded += 1;
      }
      if (batch.length > 0) this.appendBatch(runId, batch);
    }
    return { kept: groups.size, superseded };
  }

  listCurrent(runId: string): Fact[] {
    return this.store.repos.facts.listCurrent(runId);
  }

  private requireFact(factId: string): Fact {
    const found = this.store.repos.facts.get(factId);
    if (!found) throw new PolishError("NOT_FOUND", `fact ${factId} not found`);
    return found;
  }

  private append(runId: string, type: string, payload: Record<string, unknown>, causedBy: string[] = []): void {
    this.appendBatch(runId, [this.newEvent(runId, type, payload, causedBy)]);
  }

  private appendBatch(_runId: string, events: NewEvent[]): void {
    this.store.events.append(events);
  }

  private newEvent(
    runId: string,
    type: string,
    payload: Record<string, unknown>,
    causedBy: string[] = [],
  ): NewEvent {
    return {
      id: id("evt", this.clock.now()),
      runId,
      ts: this.clock.now(),
      type,
      payload,
      causedBy,
      actor: SYSTEM_ACTOR,
      artifacts: [],
    };
  }
}
