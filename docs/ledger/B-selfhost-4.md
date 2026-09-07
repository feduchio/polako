# B-selfhost-4 — Planning re-entry must not duplicate the task DAG

**Status:** FROZEN CONTRACT — not implemented, not accepted  
**Class:** PHASE_REQUIRED with MISSION_CRITICAL invariants below  
**Exact base:** `311203830720a4d1e917785e577eaf868281bc8a` (accepted C8; `task/C8-integration`)  
**Source finding:** `docs/ledger/B-selfhost-remaining.md` item **4**  
**Plan:** Phase-C pause for bounded remaining Phase-B findings; stronger HOST = accepted C8

This document is the bounded contract for self-host finding 4 only. It is **not** Fable §17 B4 (review swarm — already ACCEPTED as `docs/ledger/B4.md`). After freeze, implementation must not rewrite this file to make a candidate pass.

## Authority and trusted inputs

1. `docs/ledger/B-selfhost-remaining.md` §4: Planning re-entry duplicates original tasks because `createPlanningDriver` always full-decomposes.
2. Production reproduction (C3 Polish lanes): GATING → PLANNING on zero survivors / retries appends a fresh full `task.created` DAG each bounce; after `retry.maxAttempts` the original task is BLOCKED while duplicates remain. HOST cannot complete GATING for Polish coding/verify.
3. Exact-base composition already:
   - returns `nextPhase: "PLANNING"` from GATING zero-survivors, COMPARING no-winner (retry), INTEGRATING failure (retry), VALIDATING when pending finding work exists, and (via convergence) when `requiresPlanning` is true;
   - wraps PLANNING / EXECUTING / VALIDATING with `promoteEligibleTasksToReady` (PENDING → READY when deps met);
   - VALIDATING already emits finding-origin `task.created` before returning to PLANNING;
   - GATING zero-survivors / COMPARING no-winner set the **same** task id back to `READY`; INTEGRATING failure sets `INTEGRATION_FAILED` and today never restores `READY` (the illegal duplicate DAG was the only accidental recovery).
4. Exact-base FSM: `GATING|COMPARING|INTEGRATING → EXECUTING` is **illegal** (`RUN_PHASE_TABLE`). Retry target remains `PLANNING` (or FAILED/NEEDS_HUMAN on exhaust). Do not widen the run FSM in this task.
5. Accepted C2/C3/C4/C8 may be present. They are not oracles. C2 pathology / task-growth detectors must not be the sole fix.
6. Full Phase-B self-host closure remains **DEFERRED_BY_USER**. Items 3, 5–9, 11–15 are out of scope except where a tiny shared helper is required for item 4.

## Defect (normative)

On every PLANNING entry, `createPlanningDriver` calls council `decompose` and appends `task.created` for the full returned DAG, even when the run already has tasks. That duplicates the DAG and prevents a stable GATING→retry path.

## Definitions (normative)

- **First plan:** `store.repos.tasks.listByRun(runId).length === 0` at the start of the PLANNING driver body (before any append).
- **Re-entry:** `listByRun(runId).length >= 1` at that same point (includes terminal-only sets, BLOCKED-only sets, and partial first-plan crash leftovers).
- **Mission-origin task:** `task.origin.kind === "mission_requirement"` (identity: `task.id`; requirement key: `origin.requirementRef`).
- **Finding-origin task:** `task.origin.kind === "valid_finding" | "investigation"` (identity: `task.id`; finding key: `origin.findingId` plus investigation `round` when present).
- **Schedulable coding task:** `touchesProductCode && kind !== "investigation"` and state in `{PENDING, READY, RUNNING, GATED, SELECTED, QUEUED_FOR_INTEGRATION, INTEGRATING, INTEGRATION_FAILED}` (i.e. not `{INTEGRATED, REJECTED, CANCELLED, BLOCKED}`).
- Title / description / soft-string equality is **not** an identity. Skip-append-by-title is forbidden.

## MISSION_CRITICAL invariants

1. **First plan only may decompose.** On first plan only, production `createPlanningDriver` may call council `decompose` and append `task.created` for the returned DAG. On re-entry, the driver MUST make **zero** `council.decompose` calls and MUST append **zero** `task.created` events of **any** origin.
2. **Re-entry is restore-and-continue.** Existing task ids stay intact. `promoteEligibleTasksToReady` (PENDING→READY when deps met) may remain the promotion mechanism and must not be assumed absent. In addition, when PLANNING re-entry observes a schedulable coding task in `INTEGRATION_FAILED` with `attempts < config.retry.maxAttempts`, the **same** task id MUST be transitioned `INTEGRATION_FAILED → READY` (legal `TASK_TABLE` edge) before choosing next phase. That state patch is required recovery, not GC. `promoteEligibleTasksToReady` alone is not sufficient for integration retry.
3. **Re-entry next phase (deterministic).** After invariant-2 recovery/promotion:
   - If any schedulable coding task exists in `{READY, RUNNING}` (or `PENDING` with deps met that promotion will make READY in the same tick via `withReadyPromotion`), next phase is `EXECUTING`.
   - Else if any non-terminal finding-origin **coding** task (`valid_finding` with `touchesProductCode`) remains, next phase is `EXECUTING` after it is READY.
   - Else if any non-terminal **investigation** task remains: next phase is `NEEDS_HUMAN` with an explicit terminal reason that investigation work is pending and not EXECUTING-schedulable at this base. Do **not** send investigation-only work to `EXECUTING` (it waits forever) and do **not** send it to `REVIEWING` / allow clean-round → DONE while that investigation is non-terminal.
   - Else if the only coding tasks are exhausted (`BLOCKED` and/or `INTEGRATION_FAILED` with `attempts >= maxAttempts`) and no finding-origin work remains: next phase is `FAILED` (or preserve an already-emitted COMPARING `NEEDS_HUMAN`); never `REVIEWING` / `DONE` / `EXECUTING` that schedules a new id.
   - Else (e.g. only INTEGRATED/REJECTED/CANCELLED tasks, no pending finding work): next phase is `REVIEWING` (same empty-coding first-plan default).
4. **Retry drivers stay on legal edges.** GATING / COMPARING / INTEGRATING retry MUST continue to return `PLANNING` while attempts remain (not `EXECUTING`). On INTEGRATING failure with attempts remaining, the INTEGRATING driver **or** the subsequent PLANNING re-entry (invariant 2) MUST ensure the same task id is `READY` before EXECUTING runs. Exhaust paths stay FAILED/NEEDS_HUMAN as today and must not enter PLANNING solely to spawn a replacement task.
5. **Finding path.** VALIDATING remains the sole authority that creates `valid_finding` / investigation `task.created`. PLANNING re-entry after VALIDATING must not re-decompose and must not append another finding-origin row for the same `findingId` (or any other `task.created`).
6. **NEEDS_HUMAN.** First-plan `decompose → NEEDS_HUMAN` is unchanged. Re-entry must not call `decompose` and must not emit a second-plan `NEEDS_HUMAN` / `report.generated` from a drop-all council. Investigation-only escalation (invariant 3) is the only new NEEDS_HUMAN on re-entry.
7. **No silent task GC.** Do not delete, merge-by-title, rewrite historical `task.created`, or `BLOCKED→READY` to escape `maxAttempts`. Prevention only. Historical duplicate rows from before the fix are out of scope.
8. **No C-scope creep.** Do not implement C1, C2-as-the-fix, C5–C7/C9–C11, other B-selfhost items, Phase D, or tag `phase-c-accepted` / claim Phase B closed.
9. **Deterministic acceptance only.** ScriptedProvider / in-memory Store. No live/paid provider calls. Composer is not used.

## PHASE_REQUIRED surface

1. `createPlanningDriver` implements invariants 1–3 and 6 (zero decompose / zero `task.created` on re-entry; INTEGRATION_FAILED→READY recovery; next-phase table).
2. INTEGRATING failure retry path satisfies invariant 2/4 (same task id becomes READY; no new `task.created`). Preferred: patch READY in the INTEGRATING driver before returning PLANNING; PLANNING re-entry remains a mandatory backstop.
3. Tests for all acceptance checks; replace any test that encoded always-decompose-on-reentry.
4. `pnpm check` and `pnpm build` on Node 24.20.0.

## Deterministic acceptance checks

1. **First plan:** empty task list → `decompose` called once → `task.created` count equals DAG size → EXECUTING when coding tasks exist.
2. **GATING retry:** seed one mission-origin coding task; force zero survivors with `attempts < maxAttempts` → nextPhase `PLANNING` → PLANNING tick: `decompose` call count **0**, **zero** new `task.created` (any origin), same task id `READY`, run task count unchanged, nextPhase `EXECUTING`.
3. **Repeated bounce:** N>1 GATING→PLANNING retries → total `task.created` equals initial plan count (+ separately seeded finding tasks only if the test seeded them before the bounce); never ×N. Each PLANNING re-entry: decompose=0.
4. **INTEGRATING retry:** seed integration failure with `attempts < maxAttempts` → zero new `task.created`; same task id becomes `READY`; subsequent EXECUTING schedules that id (not `{status:"waiting"}` forever).
5. **VALIDATING → PLANNING:** VALID blocking finding creates exactly one finding-origin coding task; PLANNING re-entry appends **zero** `task.created`, decompose=0, advances to EXECUTING with that task READY (or PENDING→READY via promotion in the same tick).
6. **Idempotent re-entry:** two consecutive PLANNING ticks on a run that already has tasks → **both** ticks: decompose=0 and zero `task.created`.
7. **Investigation-only:** non-terminal investigation task, no schedulable coding work → PLANNING re-entry → `NEEDS_HUMAN` (not EXECUTING, not REVIEWING).
8. **BLOCKED / exhausted:** `attempts >= maxAttempts` → FAILED/NEEDS_HUMAN as today without a new `task.created`. If PLANNING is entered with only exhausted coding work and no finding work → not REVIEWING/DONE/EXECUTING-with-new-id (guard test may enter PLANNING artificially).
9. **No second-plan NEEDS_HUMAN from council:** re-entry against a scripted council that would return NEEDS_HUMAN/drop-all → still promote-and-continue; no `nextPhase: "NEEDS_HUMAN"` from decompose; decompose never called.
10. Named suites stay green: council-drivers, candidate-drivers, validating-drivers, composition promote tests, fsm pins, plus new focused planning-reentry tests.
11. `pnpm check` + `pnpm build` Node 24.20.0; no live/paid calls.

## Explicit non-goals

- B-selfhost items 3, 5–9, 11–15 (multi-task DONE, budget CLI, PairwiseJudge provider, crash recovery, etc.).
- Deduplicating already-persisted historical duplicate DAGs.
- Widening `RUN_PHASE_TABLE` with GATING→EXECUTING.
- Making investigation tasks EXECUTING-schedulable (escalate NEEDS_HUMAN only).
- Changing review-swarm B4, convergence B6 DONE authority, or C8 audition.
- Live Polish HOST dogfood as required acceptance (may be attempted after accept).
- Remaining Phase C; Phase D; `phase-c-accepted`.

## Implementation workspace proposal (proposal only)

`/Users/fedorsvetlov/polish-worktrees/phase-c/B-selfhost-4/` with `grok/`, `claude/`, `polish/`, `integration/` and root `OWNERSHIP.json`. No existing `/Users/fedorsvetlov/polish-*` tree is moved or deleted.

## Contract-review and acceptance authority

- Reviewed draft hash `636e2aa7656c35ad35260c2bb8d5bdea1e75ddf539adc01a0aa9daa3d32b0180`: Grok **FAIL** (6 blocking), Claude **FAIL** (5 blocking). All blocking findings incorporated above. **No second Claude contract review** (same scheme as C8).
- Implementation acceptance requires deterministic evidence plus fresh Grok and Claude code reviews (2 clean rounds).
- Polish HOST verify may be attempted after accept; not required to freeze or accept the contract itself.
- Composer is not used. No Max/Ultra. No paid/live provider calls without explicit user permission.
