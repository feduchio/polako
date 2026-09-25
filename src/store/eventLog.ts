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
  "review_executions",
  "facts",
  "acceptance_artifacts",
  "protected_change_waivers",
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
          .prepare(
            "INSERT INTO events (id, run_id, seq, ts, type, actor_kind, schema_version, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(event.id, event.runId, event.seq, event.ts, event.type, event.actor.kind, event.schemaVersion, JSON.stringify(event));
        const insertCause = this.db.prepare("INSERT OR IGNORE INTO event_causes (event_id, cause_id) VALUES (?, ?)");
        for (const c of event.causedBy) insertCause.run(event.id, c);
        applyProjections(this.db, event, this);
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

  /** Events directly caused by `eventId`. */
  effects(eventId: string): Event[] {
    const rows = this.db
      .prepare("SELECT e.json FROM event_causes c JOIN events e ON e.id = c.event_id WHERE c.cause_id = ? ORDER BY e.seq")
      .all(eventId) as unknown as EventRow[];
    return rows.map((r) => EventSchema.parse(JSON.parse(r.json)));
  }

  /**
   * Rebuild all projections for a run from its events. Run-scoped rows are cleared by `run_id`.
   * Mission-scoped rows for missions this run touches are cleared and replayed from the entire
   * event log so shared interpretations produced by other runs are restored.
   */
  rebuildProjections(runId: string): number {
    return this.tx.run(() => {
      const events = this.list(runId);
      const scopedMissionIds = this.scopedMissionIds(events);
      const globalMissionIds = this.ruledEntityIds("missions");
      const globalInterpretationIds = this.ruledEntityIds("interpretations");

      for (const table of PROJECTED_TABLES) {
        if (table === "runs") {
          this.db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
        } else if (table === "missions") {
          for (const mid of scopedMissionIds) this.db.prepare("DELETE FROM missions WHERE id = ?").run(mid);
          this.deleteOrphanMissionRows(globalMissionIds);
        } else if (table === "interpretations") {
          for (const mid of scopedMissionIds) {
            this.db.prepare("DELETE FROM interpretations WHERE mission_id = ?").run(mid);
          }
          this.deleteOrphanInterpretationRows(globalInterpretationIds);
        } else if (table === "acceptance_corpus_entries") {
          for (const mid of scopedMissionIds) {
            this.db.prepare("DELETE FROM acceptance_corpus_entries WHERE mission_id = ?").run(mid);
          }
        } else if (RUN_SCOPED_TABLES.has(table)) {
          this.db.prepare(`DELETE FROM ${table} WHERE run_id = ?`).run(runId);
        }
      }
      for (const e of events) applyProjections(this.db, e, this);
      this.replaySharedMissionProjections(scopedMissionIds);
      return events.length;
    });
  }

  /** Mission ids this run references via run snapshots, mission events, or interpretation events. */
  private scopedMissionIds(events: Event[]): Set<string> {
    const ids = new Set<string>();
    for (const e of events) {
      for (const rule of rulesByType.get(e.type) ?? []) {
        const entity = e.payload[rule.payloadField] as Record<string, unknown> | undefined;
        if (!entity) continue;
        if (rule.table === "missions" && typeof entity["id"] === "string") ids.add(entity["id"]);
        if (rule.table === "interpretations" && typeof entity["missionId"] === "string") ids.add(entity["missionId"]);
        if (rule.table === "acceptance_corpus_entries" && typeof entity["missionId"] === "string") ids.add(entity["missionId"]);
        if (rule.table === "runs" && typeof entity["missionId"] === "string") ids.add(entity["missionId"]);
      }
    }
    return ids;
  }

  private eventTouchesScopedMissions(e: Event, missionIds: Set<string>): boolean {
    for (const rule of rulesByType.get(e.type) ?? []) {
      if (rule.table !== "missions" && rule.table !== "interpretations" && rule.table !== "acceptance_corpus_entries") continue;
      const entity = e.payload[rule.payloadField] as Record<string, unknown> | undefined;
      if (!entity) continue;
      if (rule.table === "missions" && typeof entity["id"] === "string" && missionIds.has(entity["id"])) return true;
      if (rule.table === "interpretations" && typeof entity["missionId"] === "string" && missionIds.has(entity["missionId"])) {
        return true;
      }
      if (rule.table === "acceptance_corpus_entries" && typeof entity["missionId"] === "string" && missionIds.has(entity["missionId"])) {
        return true;
      }
    }
    return false;
  }

  /** Re-apply mission-scoped projections from every run for missions this rebuild touches. */
  private replaySharedMissionProjections(missionIds: Set<string>): void {
    if (missionIds.size === 0) return;
    // Insertion order (rowid), not event.ts — callers control ts and it need not reflect append order.
    const rows = this.db.prepare("SELECT json FROM events ORDER BY rowid").all() as unknown as EventRow[];
    for (const row of rows) {
      const e = EventSchema.parse(JSON.parse(row.json));
      if (this.eventTouchesScopedMissions(e, missionIds)) applyProjections(this.db, e, this);
    }
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

  /**
   * Rebuild global model observations from every `model.observation.recorded` event.
   * Run-scoped rebuilds intentionally leave this table untouched.
   */
  rebuildModelObservations(): number {
    return this.tx.run(() => {
      this.db.prepare("DELETE FROM model_observations").run();
      const rows = this.db
        .prepare("SELECT json FROM events WHERE type = ? ORDER BY rowid")
        .all("model.observation.recorded") as unknown as EventRow[];
      for (const row of rows) {
        const e = EventSchema.parse(JSON.parse(row.json));
        applyProjections(this.db, e, this);
      }
      return rows.length;
    });
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
