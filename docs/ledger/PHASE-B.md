# Phase B — production vertical slice

Trusted branch: `phase-b-real` from `phase-a-certified-final`.
Donor library (untrusted): `archive/post-a-wip` (`b5a5f83`). Historical B/C/D ledgers on
that branch are **HISTORICAL / SUPERSEDED / NOT ACCEPTANCE EVIDENCE**.

This file is the Phase B composition contract. Per-task contracts are `docs/ledger/B1.md` …
`B12.md`. Contracts are immutable for the duration of the named task.

## Requirement classes

- `MISSION_CRITICAL` — architectural invariant; missing ⇒ FAIL.
- `PHASE_REQUIRED` — required to close this Phase B task / the phase.
- `OPTIONAL` — may exist; absence is not FAIL.
- `DEFERRED_BY_USER` — only the user or the original Fable plan *before implementation*
  may assign this. Verifier/reconciler **must not** relabel `PHASE_REQUIRED` → deferred.

## Authority order

1. The execution-chat prompt and direct user decisions.
2. Original Fable plan (`.cursor/plans/polish_orchestrator_implementation_plan_00d1259e.plan.md`).
3. Accepted Phase A hard invariants.
4. Actual source + deterministic evidence.
5. These ledgers.
6. `archive/post-a-wip` (donor only).

## Production path (PHASE_REQUIRED)

Every arrow must exist in the **production** daemon/CLI/MCP composition, not only as a
library function or a test-harness driver:

User Mission → project discovery → baseline → mission interpretation → model selection →
planning → Task DAG → fresh workers → candidate worktrees → real code modifications →
independent gates → candidate comparison → serial integration → checkpoint →
independent review swarm → finding validation → fix tasks if needed → convergence →
runtime validation where applicable → DONE.

Stub/scripted phase drivers are allowed **only** in explicit test harnesses (including
preserved A5 stub-driver unit tests). Production must not contain a driver that merely
transitions `X → Y` without performing that phase's PHASE_REQUIRED work.

## Anti-fake-DONE (MISSION_CRITICAL)

For a mission that requires a code change, DONE is impossible if any of:

- 0 planned coding tasks
- 0 worker executions
- 0 candidate worktrees
- 0 candidate commits
- 0 successful independent gates
- 0 integrated code changes
- final checkpoint == baseline checkpoint
- 0 actual review executions
- clean rounds synthesized without completed review evidence

Enforced in domain/convergence logic, not by convention.

## Clean-round proof of review (MISSION_CRITICAL)

A clean round is valid only if required reviewers completed against the **exact** current
checkpoint, findings were validated, and validated blocking findings = 0.
Changing the checkpoint invalidates clean rounds. `rawFindings = 0` without review
execution records is rejected.

## Runtime (PHASE_REQUIRED, B12; used by B2/B6/B10)

`runtime_validation.mode ∈ {auto, required, off}`, default `auto`.
Evidence is checkpoint-bound. Baseline runtime evidence cannot satisfy final DONE.
`required` + missing/failed/stale final runtime evidence ⇒ DONE impossible.

## Simplification

Full simplification pass is original-plan **C1**, not a Phase B task. Production Phase B
may take `CONVERGENCE_CHECK → DONE` when anti-fake-DONE, clean rounds, and runtime
requirements hold. The FSM edge `CONVERGENCE_CHECK → SIMPLIFYING` remains; Phase B must
not claim C1 work and must not stub-fake a simplification pass.

## Implementation order

B12 core (config, `RuntimeValidator`, checkpoint-bound evidence) is implemented early so
gating/integration/convergence can consume it. Remaining order: B1, B7, B2, B3, B4, B5,
B6, B8, B9, B11, B10. Phase-level composition audit after all tasks. No Phase C.

## Phase B ACCEPTED only if all are true

- all B-task deterministic gates PASS
- production positive E2E PASS
- mandatory negative E2E PASS
- real-provider controlled E2E PASS
- phase composition audit has 0 VALID blocking findings
- no PHASE_REQUIRED requirement is missing or deferred

## Donor policy

Inspect `archive/post-a-wip` components against the **current** contract, then port
selectively. Do not cherry-pick `02e3a7d`. Do not copy old PASS ledgers.
