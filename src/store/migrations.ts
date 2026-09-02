export interface Migration {
  version: number;
  sql: string;
}

/**
 * Projections keep the validated entity as JSON plus the columns we index on.
 * The event log is the source of truth (ADR-0002); every projection row must be
 * reconstructible by replaying `events` for its run.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE events (
        id         TEXT PRIMARY KEY,
        run_id     TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        ts         INTEGER NOT NULL,
        type       TEXT NOT NULL,
        actor_kind TEXT NOT NULL,
        json       TEXT NOT NULL,
        UNIQUE (run_id, seq)
      );
      CREATE INDEX events_run_type ON events (run_id, type, seq);

      CREATE TABLE event_causes (
        event_id TEXT NOT NULL REFERENCES events(id),
        cause_id TEXT NOT NULL,
        PRIMARY KEY (event_id, cause_id)
      );
      CREATE INDEX event_causes_cause ON event_causes (cause_id);

      CREATE TABLE artifacts (
        sha256     TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        bytes      INTEGER NOT NULL,
        label      TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE runs (
        id         TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        phase      TEXT NOT NULL,
        control    TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        json       TEXT NOT NULL
      );

      CREATE TABLE missions (
        id         TEXT PRIMARY KEY,
        hash       TEXT NOT NULL,
        json       TEXT NOT NULL
      );

      CREATE TABLE interpretations (
        id         TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        version    INTEGER NOT NULL,
        json       TEXT NOT NULL,
        UNIQUE (mission_id, version)
      );

      CREATE TABLE baselines (
        id     TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        json   TEXT NOT NULL
      );

      CREATE TABLE tasks (
        id         TEXT PRIMARY KEY,
        run_id     TEXT NOT NULL,
        state      TEXT NOT NULL,
        kind       TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        json       TEXT NOT NULL
      );
      CREATE INDEX tasks_run_state ON tasks (run_id, state);

      CREATE TABLE candidates (
        id      TEXT PRIMARY KEY,
        run_id  TEXT NOT NULL,
        task_id TEXT NOT NULL,
        state   TEXT NOT NULL,
        json    TEXT NOT NULL
      );
      CREATE INDEX candidates_task ON candidates (task_id, state);

      CREATE TABLE checkpoints (
        id          TEXT PRIMARY KEY,
        run_id      TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        commit_hash TEXT NOT NULL,
        json        TEXT NOT NULL,
        UNIQUE (run_id, seq)
      );

      CREATE TABLE findings (
        id              TEXT PRIMARY KEY,
        run_id          TEXT NOT NULL,
        checkpoint_hash TEXT NOT NULL,
        status          TEXT NOT NULL,
        fingerprint     TEXT NOT NULL,
        json            TEXT NOT NULL
      );
      CREATE INDEX findings_run_status ON findings (run_id, status);
      CREATE INDEX findings_fingerprint ON findings (run_id, fingerprint);

      CREATE TABLE finding_validations (
        id         TEXT PRIMARY KEY,
        run_id     TEXT NOT NULL,
        finding_id TEXT NOT NULL,
        verdict    TEXT NOT NULL,
        json       TEXT NOT NULL
      );
      CREATE INDEX finding_validations_finding ON finding_validations (finding_id);

      CREATE TABLE clean_rounds (
        id              TEXT PRIMARY KEY,
        run_id          TEXT NOT NULL,
        checkpoint_hash TEXT NOT NULL,
        round_index     INTEGER NOT NULL,
        json            TEXT NOT NULL
      );
      CREATE INDEX clean_rounds_hash ON clean_rounds (run_id, checkpoint_hash);

      CREATE TABLE facts (
        id              TEXT PRIMARY KEY,
        run_id          TEXT NOT NULL,
        kind            TEXT NOT NULL,
        provenance_kind TEXT NOT NULL,
        superseded_by   TEXT,
        json            TEXT NOT NULL
      );
      CREATE INDEX facts_run ON facts (run_id, provenance_kind);

      CREATE TABLE acceptance_artifacts (
        id            TEXT PRIMARY KEY,
        run_id        TEXT NOT NULL,
        task_id       TEXT,
        relative_path TEXT NOT NULL,
        sha256        TEXT NOT NULL,
        json          TEXT NOT NULL
      );
      CREATE INDEX acceptance_run ON acceptance_artifacts (run_id);

      CREATE TABLE jobs (
        id          TEXT PRIMARY KEY,
        run_id      TEXT NOT NULL,
        lane        TEXT NOT NULL,
        state       TEXT NOT NULL,
        priority    INTEGER NOT NULL,
        lease_until INTEGER,
        created_at  INTEGER NOT NULL,
        json        TEXT NOT NULL
      );
      CREATE INDEX jobs_lane_state ON jobs (lane, state, priority DESC, created_at);
      CREATE INDEX jobs_run_state ON jobs (run_id, state);
    `,
  },
];
