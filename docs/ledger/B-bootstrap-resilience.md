# B-bootstrap-resilience — Supervisor fallback + operator UX

Status: **ACCEPTED** (Composer verifier, `blocking_findings: 0`)

Phase B remains **OPEN**. Full Phase-B self-host closure is **DEFERRED_BY_USER**.

## Contract

1. Pinned Supervisor Council roles accept an ordered model preference/fallback chain.
2. Fallback is only for operational failure (429, timeout, 5xx, unavailable, transport, equivalent infra). A successful semantic answer is final.
3. Bounded per-model retry with backoff, then authorised fallback. Every retry/fallback is an event.
4. Exhausted council availability pauses the run (`PAUSED`) instead of leaving `RUNNING` + unchanged phase.
5. Parallel council roles use `allSettled`; one failure must not hide sibling success.
6. `model.call_started` / retry / fallback / check start / worker start exist so a long healthy call is distinguishable from a hang.
7. `polish status` is human text; `--json` is the machine projection. `polish watch` is the live observer. `polish log --json` remains raw events.
8. `pnpm cli:link` is the local-dev PATH setup. CLI works from an unrelated cwd.

## Verification

- Deterministic tests covering A–J (council fallback, engine pause, observe projection, CLI status/watch/log, cwd-independent invocation, store reopen).
- Independent adversarial verifier: Composer (`blocking_findings: 0`).
- Global gates: `pnpm check` PASS (439 tests).

## Out of scope (untouched)

Remaining `B-selfhost-remaining` items 3–9, 11–15. Phase C (pathology, Cursor UI, llm-as-a-verifier, audition, dashboard). Full Phase-B self-host closure has NOT been run.


Phase B remains **OPEN**. Full Phase-B self-host closure is **DEFERRED_BY_USER**.

## Contract

1. Pinned Supervisor Council roles accept an ordered model preference/fallback chain.
2. Fallback is only for operational failure (429, timeout, 5xx, unavailable, transport). A successful semantic answer is final.
3. Bounded per-model retry with backoff, then authorised fallback. Every retry/fallback is an event.
4. Exhausted council availability pauses the run (`PAUSED`) instead of leaving `RUNNING` + unchanged phase.
5. Parallel council roles use `allSettled`; one failure must not hide sibling success.
6. `model.call_started` / retry / fallback / check start / worker start exist so a long healthy call is distinguishable from a hang.
7. `polish status` is human text; `--json` is the machine projection. `polish watch` is the live observer. `polish log --json` remains raw events.
8. `pnpm cli:link` is the local-dev PATH setup. CLI works from an unrelated cwd.

## Out of scope

Remaining `B-selfhost-remaining` items 3–9, 11–15. Phase C (pathology, Cursor UI, llm-as-a-verifier, audition, dashboard).
