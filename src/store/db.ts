import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations.js";
import { PolishError } from "../shared/errors.js";

export type Db = DatabaseSync;

export interface OpenDbOptions {
  /** file path or ":memory:" */
  path: string;
}

export function openDb(options: OpenDbOptions): Db {
  const db = new DatabaseSync(options.path);
  if (options.path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
  }
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  migrate(db);
  return db;
}

export function migrate(db: Db): number {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);");
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null } | undefined;
  let current = row?.v ?? 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    if (m.version !== current + 1) {
      throw new PolishError("CONFIG_ERROR", `migration gap: have ${current}, next is ${m.version}`);
    }
    transaction(db, () => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(m.version, Date.now());
    });
    current = m.version;
  }
  return current;
}

/**
 * Synchronous transaction helper. node:sqlite is synchronous, which is exactly what we want
 * for "event append + projection update" atomicity. Nested calls join the outer transaction.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}
