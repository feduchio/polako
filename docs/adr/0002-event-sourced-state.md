# ADR-0002: Event-sourced state with SQLite projections

Status: Accepted · Date: 2026-09-02

## Context

The system must be resumable after crashes, inspectable after Cursor is closed, and able to
answer "why did the system change this file?" through a causal chain
`user intent → finding → validation → task → worker → diff → checks → verdict`.

## Decision

- Append-only `events` table is the source of truth. Each event carries `id, run_id, seq,
  ts, type, payload, caused_by[], actor{kind, model?, provider?}, artifact_refs[]`.
- Projections (`runs`, `tasks`, `candidates`, `findings`, `checkpoints`, `clean_rounds`,
  `facts`, `jobs`, ...) are updated in the **same transaction** as the event append.
  Recovery can rebuild projections by replaying events.
- `runs/<runId>/events.jsonl` mirrors the event stream for grep/human reading; it is
  derived, never read back as truth.
- Large payloads (model requests/responses, shell output, diffs, context packs) are
  content-addressed artifacts on disk (`sha256`), referenced from events.
- Storage engine: `node:sqlite` (bundled with Node 24, WAL mode). We do not use FTS5
  (absent in official Node builds; see CodeGraph issue #1532).
- Code state lives in git: run branch `polish/<runId>`, checkpoints as
  `refs/polish/<runId>/cp-<n>`, candidates in worktrees.

## Consequences

- Every projection has a deterministic `apply(event)`; tests assert replay == live state.
- Schema migrations are versioned SQL files applied on daemon start.
- The event log grows unbounded per run; runs are archived, not pruned, in v1.
