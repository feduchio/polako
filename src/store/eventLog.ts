import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { EventSchema, type Event, type NewEvent } from "../domain/event.js";
import { PolishError } from "../shared/errors.js";
import { transaction, type Db } from "./db.js";
import { PROJECTED_TABLES, applyProjections } from "./projections.js";

export interface EventLogOptions {
  /** directory for `runs/<runId>/events.jsonl` mirrors; null disables the mirror (tests) */
  runsDir: string | null;
}

interface EventRow {
  json: string;
}

export class EventLog {
  constructor(
    private readonly db: Db,
    private readonly options: EventLogOptions,
  ) {}

  /**
   * Append events and update projections atomically. `seq` is assigned here.
   * Returns the stored events (with seq).
   */
  append(events: readonly NewEvent[]): Event[] {
    if (events.length === 0) return [];
    return transaction(this.db, () => {
      const stored: Event[] = [];
      for (const e of events) {
        const seq = this.nextSeq(e.runId);
        const event = EventSchema.parse({ ...e, seq });
        this.db
          .prepare("INSERT INTO events (id, run_id, seq, ts, type, actor_kind, json) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(event.id, event.runId, event.seq, event.ts, event.type, event.actor.kind, JSON.stringify(event));
        const insertCause = this.db.prepare("INSERT OR IGNORE INTO event_causes (event_id, cause_id) VALUES (?, ?)");
        for (const c of event.causedBy) insertCause.run(event.id, c);
        applyProjections(this.db, event);
        stored.push(event);
      }
      this.mirror(stored);
      return stored;
    });
  }

  get(id: string): Event | null {
    const row = this.db.prepare("SELECT json FROM events WHERE id = ?").get(id) as EventRow | undefined;
    return row ? EventSchema.parse(JSON.parse(row.json)) : null;
  }

  list(runId: string, opts: { afterSeq?: number; types?: readonly string[]; limit?: number } = {}): Event[] {
    const params: (string | number)[] = [runId, opts.afterSeq ?? -1];
    let sql = "SELECT json FROM events WHERE run_id = ? AND seq > ?";
    if (opts.types && opts.types.length > 0) {
      sql += ` AND type IN (${opts.types.map(() => "?").join(", ")})`;
      params.push(...opts.types);
    }
    sql += " ORDER BY seq ASC";
    if (opts.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as unknown as EventRow[];
    return rows.map((r) => EventSchema.parse(JSON.parse(r.json)));
  }

  lastSeq(runId: string): number {
    const row = this.db.prepare("SELECT MAX(seq) AS s FROM events WHERE run_id = ?").get(runId) as { s: number | null } | undefined;
    return row?.s ?? -1;
  }

  /** Walk `causedBy` links backwards (BFS, bounded) — the "why chain". */
  causalChain(eventId: string, maxDepth = 50): Event[] {
    const seen = new Set<string>();
    const out: Event[] = [];
    let frontier = [eventId];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        const e = this.get(id);
        if (!e) continue;
        out.push(e);
        next.push(...e.causedBy);
      }
      frontier = next;
    }
    return out;
  }

  /** Events directly caused by `eventId`. */
  effects(eventId: string): Event[] {
    const rows = this.db
      .prepare("SELECT e.json FROM event_causes c JOIN events e ON e.id = c.event_id WHERE c.cause_id = ? ORDER BY e.seq")
      .all(eventId) as unknown as EventRow[];
    return rows.map((r) => EventSchema.parse(JSON.parse(r.json)));
  }

  /**
   * Rebuild all projections for a run from its events. Used by recovery and by tests
   * asserting replay == live state.
   */
  rebuildProjections(runId: string): number {
    return transaction(this.db, () => {
      for (const table of PROJECTED_TABLES) {
        if (table === "missions" || table === "interpretations") {
          // keyed by mission, not run: delete via the run's mission id
          const run = this.db.prepare("SELECT mission_id FROM runs WHERE id = ?").get(runId) as { mission_id: string } | undefined;
          if (run) {
            if (table === "missions") this.db.prepare("DELETE FROM missions WHERE id = ?").run(run.mission_id);
            else this.db.prepare("DELETE FROM interpretations WHERE mission_id = ?").run(run.mission_id);
          }
          continue;
        }
        if (table === "runs") {
          this.db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
          continue;
        }
        this.db.prepare(`DELETE FROM ${table} WHERE run_id = ?`).run(runId);
      }
      const events = this.list(runId);
      for (const e of events) applyProjections(this.db, e);
      return events.length;
    });
  }

  private nextSeq(runId: string): number {
    return this.lastSeq(runId) + 1;
  }

  private mirror(events: readonly Event[]): void {
    if (this.options.runsDir === null) return;
    const byRun = new Map<string, Event[]>();
    for (const e of events) {
      const list = byRun.get(e.runId) ?? [];
      list.push(e);
      byRun.set(e.runId, list);
    }
    for (const [runId, list] of byRun) {
      const dir = join(this.options.runsDir, runId);
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, "events.jsonl"), list.map((e) => JSON.stringify(e)).join("\n") + "\n");
      } catch (err) {
        throw new PolishError("IO_ERROR", `failed to mirror events for run ${runId}`, { dir }, { cause: err });
      }
    }
  }
}
