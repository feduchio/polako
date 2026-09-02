import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations.js";
import { PolishError } from "../shared/errors.js";

export type Db = DatabaseSync;

export interface OpenDbOptions {
  /** file path or ":memory:" */
  path: string;
}

/** One TxManager per Db so hooks registered during `append` survive nested `transaction(db, …)`. */
const txManagers = new WeakMap<Db, TxManager>();

export function getTxManager(db: Db): TxManager {
  let tx = txManagers.get(db);
  if (!tx) {
    tx = new TxManager(db);
    txManagers.set(db, tx);
  }
  return tx;
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

/**
 * Apply pending migrations. The recorded history must be exactly 1..N with no gaps, and N must
 * not exceed what this build knows about (a newer daemon may have written the file).
 */
export function migrate(db: Db): number {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);");
  const applied = (db.prepare("SELECT version FROM schema_version ORDER BY version").all() as { version: number }[]).map((r) => r.version);
  for (let i = 0; i < applied.length; i++) {
    if (applied[i] !== i + 1) {
      throw new PolishError("CONFIG_ERROR", `schema_version history is not contiguous: ${applied.join(",")}`);
    }
  }
  if (applied.length > MIGRATIONS.length) {
    throw new PolishError("CONFIG_ERROR", `database schema version ${applied.length} is newer than this build (${MIGRATIONS.length})`);
  }
  let current = applied.length;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    if (m.version !== current + 1) {
      throw new PolishError("CONFIG_ERROR", `migration gap: have ${current}, next is ${m.version}`);
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(m.version, Date.now());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    current = m.version;
  }
  return current;
}

export interface MirrorFailure {
  runId: string;
  error: unknown;
  at: number;
}

/**
 * Transaction coordinator. node:sqlite is synchronous, which is exactly what we want for
 * "event append + projection update" atomicity. Nested calls join the outer transaction.
 * Side effects that must only happen if the outermost transaction commits (JSONL mirror,
 * notifications) are registered with `onCommit` and dropped on rollback.
 */
export class TxManager {
  private afterCommit: (() => void)[] = [];
  readonly mirrorFailures: MirrorFailure[] = [];

  constructor(readonly db: Db) {}

  run<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    let result: T;
    try {
      result = fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.afterCommit = [];
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw err;
    }
    const hooks = this.afterCommit;
    this.afterCommit = [];
    for (const hook of hooks) hook();
    return result;
  }

  /** Run `fn` after the current outermost transaction commits; immediately if none is open. */
  onCommit(fn: () => void): void {
    if (this.db.isTransaction) this.afterCommit.push(fn);
    else fn();
  }

  /** Mirror write failures since the last drain (the DB commit already succeeded). */
  drainMirrorFailures(): MirrorFailure[] {
    const out = [...this.mirrorFailures];
    this.mirrorFailures.length = 0;
    return out;
  }
}

/** Convenience for callers holding only a Db (tests, migrations). Uses the shared TxManager. */
export function transaction<T>(db: Db, fn: () => T): T {
  return getTxManager(db).run(fn);
}
