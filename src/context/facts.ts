import { SYSTEM_ACTOR } from "../domain/common.js";
import { FactStrictSchema, promoteToVerified, type Fact } from "../domain/fact.js";
import type { NewEvent } from "../domain/event.js";
import type { Clock } from "../shared/clock.js";
import { PolishError } from "../shared/errors.js";
import { id } from "../shared/ids.js";
import type { Store } from "../store/index.js";

function normalizeStatement(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Event-sourced facts API. Promotion `llm_inferred → verified` requires a deterministic
 * evidence event id; confidence never promotes.
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
    this.append(fact.runId, "fact.recorded", { fact });
    return fact;
  }

  promote(factId: string, evidenceEventId: string): Fact {
    const current = this.requireFact(factId);
    const promoted = promoteToVerified(current, evidenceEventId, this.clock.now());
    this.append(promoted.runId, "fact.promoted", { fact: promoted });
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
    const outdated: Fact = { ...old, supersededBy: neu.id, updatedAt: now };
    this.append(old.runId, "fact.recorded", { fact: neu });
    this.append(old.runId, "fact.superseded", { fact: outdated });
    return neu;
  }

  /**
   * Among current facts, keep the earliest of each normalized statement and supersede duplicates.
   */
  consolidate(runId: string): { kept: number; superseded: number } {
    const current = this.store.repos.facts.listCurrent(runId);
    const byKey = new Map<string, Fact>();
    let superseded = 0;
    for (const f of [...current].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
      const key = normalizeStatement(f.statement);
      const winner = byKey.get(key);
      if (winner === undefined) {
        byKey.set(key, f);
        continue;
      }
      const now = this.clock.now();
      const outdated: Fact = { ...f, supersededBy: winner.id, updatedAt: now };
      this.append(runId, "fact.superseded", { fact: outdated });
      superseded += 1;
    }
    return { kept: byKey.size, superseded };
  }

  listCurrent(runId: string): Fact[] {
    return this.store.repos.facts.listCurrent(runId);
  }

  private requireFact(factId: string): Fact {
    const found = this.store.repos.facts.get(factId);
    if (!found) throw new PolishError("NOT_FOUND", `fact ${factId} not found`);
    return found;
  }

  private append(runId: string, type: string, payload: Record<string, unknown>): void {
    const evt: NewEvent = {
      id: id("evt", this.clock.now()),
      runId,
      ts: this.clock.now(),
      type,
      payload,
      causedBy: [],
      actor: SYSTEM_ACTOR,
      artifacts: [],
    };
    this.store.events.append([evt]);
  }
}
