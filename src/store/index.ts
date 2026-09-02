import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AcceptanceStorage } from "./acceptance.js";
import { ArtifactStore } from "./artifacts.js";
import { getTxManager, openDb, type Db } from "./db.js";
import { EventLog } from "./eventLog.js";
import { createRepositories, type Repositories } from "./repositories.js";

export interface Store {
  db: Db;
  events: EventLog;
  artifacts: ArtifactStore;
  acceptance: AcceptanceStorage;
  repos: Repositories;
  /** run `fn` atomically; nested calls join the outer transaction */
  transaction<T>(fn: () => T): T;
  close(): void;
  paths: { home: string | null; runsDir: string | null; artifactsDir: string };
}

export interface OpenStoreOptions {
  /** polish home directory (`~/.polish`). When omitted an in-memory db + temp artifacts dir are used. */
  home?: string;
  /** artifacts directory override; required when `home` is omitted */
  artifactsDir?: string;
}

export function openStore(options: OpenStoreOptions): Store {
  const home = options.home ?? null;
  if (home !== null) mkdirSync(home, { recursive: true });
  const artifactsDir = options.artifactsDir ?? (home !== null ? join(home, "artifacts") : null);
  if (artifactsDir === null) throw new Error("openStore: artifactsDir is required when home is omitted");
  const runsDir = home !== null ? join(home, "runs") : null;

  const db = openDb({ path: home !== null ? join(home, "polish.db") : ":memory:" });
  const tx = getTxManager(db);
  const artifacts = new ArtifactStore(db, artifactsDir);
  return {
    db,
    events: new EventLog(tx, { runsDir }),
    artifacts,
    acceptance: new AcceptanceStorage(artifacts),
    repos: createRepositories(db),
    transaction: (fn) => tx.run(fn),
    close: () => {
      db.close();
    },
    paths: { home, runsDir, artifactsDir },
  };
}

export { ArtifactStore } from "./artifacts.js";
export { AcceptanceStorage, safeTarget } from "./acceptance.js";
export type { ProtectedPathProblem } from "./acceptance.js";
export { EventLog } from "./eventLog.js";
export { PROJECTION_RULES, PROJECTED_TABLES, upsertEntity, applyProjections } from "./projections.js";
export type { Repositories } from "./repositories.js";
export { openDb, migrate, transaction, TxManager, getTxManager } from "./db.js";
export type { MirrorFailure } from "./db.js";
export type { Db } from "./db.js";
