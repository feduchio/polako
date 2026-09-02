import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventSchema, type Event, type NewEvent } from "../domain/event.js";
import type { Db, TxManager } from "./db.js";
import { PROJECTED_TABLES, PROJECTION_RULES, applyProjections } from "./projections.js";

export interface EventLogOptions {
  /** directory for `runs/<runId>/events.jsonl` mirrors; null disables the mirror (tests) */
  runsDir: string | null;
}

interface EventRow {
  json: string;
}

const rulesByType = new Map<string, typeof PROJECTION_RULES[number][]>();
for (const rule of PROJECTION_RULES) {
  const list = rulesByType.get(rule.eventType) ?? [];
  list.push(rule);
  rulesByType.set(rule.eventType, list);
}

/** Run-scoped tables cleared wholesale on rebuild; mission tables only by entity id from ruled events. */
const RUN_SCOPED_TABLES = new Set<typeof PROJECTED_TABLES[number]>([
  "baselines",
  "tasks",
  "candidates",
  "checkpoints",
  "findings",
  "finding_validations",
  "clean_rounds",
  "facts",
  "acceptance_artifacts",
  "jobs",
]);

export class EventLog {
  private readonly db: Db;

  constructor(
    private readonly tx: TxManager,
    private readonly options: EventLogOptions,
  ) {
    this.db = tx.db;
  }

  /**
   * Append events and update projections atomically. `seq` is assigned here.
   * The JSONL mirror is written only after the outermost transaction commits; mirror
   * failures are non-fatal (recorded in `tx.drainMirrorFailures()`, rebuildable from DB).
   */
  append(events: readonly NewEvent[]): Event[] {
    if (events.length === 0) return [];
    return this.tx.run(() => {
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
      this.tx.onCommit(() => {
        this.mirror(stored);
      });
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
   * Rebuild all projections for a run from its events. Run-scoped rows are cleared by `run_id`.
   * Mission-scoped rows: delete entity ids this run will re-upsert, then purge any row whose id
   * appears in no ruled event anywhere (stale manual inserts). Rows backed by other runs' events
   * are preserved (shared-mission case).
   */
  rebuildProjections(runId: string): number {
    return this.tx.run(() => {
      const events = this.list(runId);
      const missionIds = new Set<string>();
      const interpretationIds = new Set<string>();
      for (const e of events) {
        for (const rule of rulesByType.get(e.type) ?? []) {
          const entity = e.payload[rule.payloadField] as Record<string, unknown> | undefined;
          if (!entity || typeof entity["id"] !== "string") continue;
          if (rule.table === "missions") missionIds.add(entity["id"]);
          if (rule.table === "interpretations") interpretationIds.add(entity["id"]);
        }
      }
      const globalMissionIds = this.ruledEntityIds("missions");
      const globalInterpretationIds = this.ruledEntityIds("interpretations");

      for (const table of PROJECTED_TABLES) {
        if (table === "runs") {
          this.db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
        } else if (table === "missions") {
          for (const mid of missionIds) this.db.prepare("DELETE FROM missions WHERE id = ?").run(mid);
          this.deleteOrphanMissionRows(globalMissionIds);
        } else if (table === "interpretations") {
          for (const iid of interpretationIds) this.db.prepare("DELETE FROM interpretations WHERE id = ?").run(iid);
          this.deleteOrphanInterpretationRows(globalInterpretationIds);
        } else if (RUN_SCOPED_TABLES.has(table)) {
          this.db.prepare(`DELETE FROM ${table} WHERE run_id = ?`).run(runId);
        }
      }
      for (const e of events) applyProjections(this.db, e);
      return events.length;
    });
  }

  /** Entity ids that appear in at least one ruled event in the entire log. */
  private ruledEntityIds(table: "missions" | "interpretations"): Set<string> {
    const ids = new Set<string>();
    const rows = this.db.prepare("SELECT json FROM events").all() as unknown as EventRow[];
    for (const row of rows) {
      const e = EventSchema.parse(JSON.parse(row.json));
      for (const rule of rulesByType.get(e.type) ?? []) {
        if (rule.table !== table) continue;
        const entity = e.payload[rule.payloadField] as Record<string, unknown> | undefined;
        if (entity && typeof entity["id"] === "string") ids.add(entity["id"]);
      }
    }
    return ids;
  }

  private deleteOrphanMissionRows(globalIds: Set<string>): void {
    const rows = this.db.prepare("SELECT id FROM missions").all() as { id: string }[];
    for (const row of rows) {
      if (!globalIds.has(row.id)) this.db.prepare("DELETE FROM missions WHERE id = ?").run(row.id);
    }
  }

  private deleteOrphanInterpretationRows(globalIds: Set<string>): void {
    const rows = this.db.prepare("SELECT id FROM interpretations").all() as { id: string }[];
    for (const row of rows) {
      if (!globalIds.has(row.id)) this.db.prepare("DELETE FROM interpretations WHERE id = ?").run(row.id);
    }
  }

  /** Rewrite the JSONL mirror for one run from the authoritative event log. */
  rebuildMirror(runId: string): void {
    if (this.options.runsDir === null) return;
    const events = this.list(runId);
    const dir = join(this.options.runsDir, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + (events.length > 0 ? "\n" : ""));
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
      try {
        const dir = join(this.options.runsDir, runId);
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, "events.jsonl"), list.map((e) => JSON.stringify(e)).join("\n") + "\n");
      } catch (err) {
        this.tx.mirrorFailures.push({ runId, error: err, at: Date.now() });
      }
    }
  }
}
