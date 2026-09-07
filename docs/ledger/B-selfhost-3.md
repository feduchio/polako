# B-selfhost-3 — Multi-task missions cannot DONE after the first integration

**Status:** FROZEN CONTRACT — not implemented, not accepted  
**Class:** PHASE_REQUIRED with MISSION_CRITICAL invariants below  
**Exact base:** `84f2f7ef55f4d97e7936b5e7d775bba358f60c90` (accepted B-selfhost-4; `task/B-selfhost-4-integration`)  
**Source finding:** `docs/ledger/B-selfhost-remaining.md` item **3**  
**Plan:** Phase-C pause for bounded remaining Phase-B findings; stronger HOST = accepted B-selfhost-4

This document is the bounded contract for self-host finding 3 only. After freeze, implementation must not rewrite it to make a candidate pass.

## Authority and trusted inputs

1. `docs/ledger/B-selfhost-remaining.md` §3: Multi-task DONE — `assertCodeChangeMissionMayComplete` does not require every required task terminal; after first integration FSM goes to REVIEWING.
2. Accepted B6 (`docs/ledger/B6.md`): anti-fake-DONE is mandatory before DONE; clean rounds are checkpoint-bound; B6 remains sole DONE authority via production `CONVERGENCE_CHECK`. This task **extends** anti-fake-DONE and convergence routing; it does not replace B6 clean-round proof or dominance.
3. Accepted B-selfhost-4: PLANNING re-entry does not duplicate the DAG; `INTEGRATING → PLANNING` and `CONVERGENCE_CHECK → PLANNING` are legal edges; `INTEGRATING → EXECUTING` and `INTEGRATING → NEEDS_HUMAN` are **illegal** and must not be added. B-selfhost-4’s frozen term **Schedulable coding task** stays as defined there; this contract uses a distinct term **continuable coding work** (below).
4. Exact-base behavior today:
   - `createIntegratingDriver` always returns `REVIEWING` after a successful integrate;
   - `assertCodeChangeMissionMayComplete` only requires *some* coding evidence, not that every coding task is finished;
   - `hasPendingFindingWork` is `PENDING`-only, so `READY` sibling coding tasks do not block VALIDATING → CONVERGENCE_CHECK.
5. Full Phase-B self-host closure remains **DEFERRED_BY_USER**. Items 5–9, 11–15 out of scope. Item 4 ACCEPTED.

## Defect (normative)

On a change-required mission with ≥2 coding tasks, integrating the first winner advances to REVIEWING. Clean rounds / convergence can then reach DONE while sibling coding tasks remain non-terminal. Anti-fake-DONE does not reject that state.

## Definitions (normative)

- **Coding task:** `task.touchesProductCode && task.kind !== "investigation"`.
- **Acceptable terminal for DONE:** coding-task state ∈ `{INTEGRATED, REJECTED, CANCELLED}`.
- **Incomplete coding task:** any coding task whose state is not an acceptable terminal (includes `BLOCKED`, `INTEGRATION_FAILED`, and all in-flight states).
- **Exhausted coding task:** coding task in `BLOCKED`, or `INTEGRATION_FAILED` with `attempts >= config.retry.maxAttempts`.
- **Continuable coding work** (distinct from B-selfhost-4 “Schedulable coding task”): any incomplete coding task that is **not** exhausted. Enumerated states: `PENDING`, `READY`, `RUNNING`, `GATED`, `SELECTED`, `QUEUED_FOR_INTEGRATION`, `INTEGRATING`, and retryable `INTEGRATION_FAILED` (`attempts < maxAttempts`). Includes `PENDING` whose `dependsOn` are not yet all `INTEGRATED` (after the winner just became `INTEGRATED`, dependents become eligible for promotion on the next PLANNING/EXECUTING tick).
- This task’s drivers **must not** introduce new production writes of coding-task `REJECTED` or `CANCELLED` (in particular must not `BLOCKED→REJECTED` / `INTEGRATION_FAILED→REJECTED` to escape anti-fake). Pre-existing base authorities that already emit those states (if any) remain; this item must not add a relabel hatch.

## MISSION_CRITICAL invariants

1. **Anti-fake multi-task gate.** For change-required missions (`missionRequiresCodeChange`), `assertCodeChangeMissionMayComplete` MUST return `{ ok: false, reason, terminal }` when any **incomplete coding task** exists. `valid_finding` coding tasks count. Existing B6 existence checks remain. Review-only missions stay unaffected on this axis.
2. **Convergence routing (finish work, do not kill recoverable runs).** Production `CONVERGENCE_CHECK`, when anti-fake fails solely because of incomplete coding tasks:
   - if any **continuable** coding work exists → `nextPhase: "PLANNING"` (legal edge; B-selfhost-4 then continues without new mission `task.created`);
   - if incompletes are **only exhausted** → `nextPhase: "FAILED"` (or `NEEDS_HUMAN` only if a stronger pre-existing reason already requires it);
   - never `DONE` while any incomplete coding task exists.  
   Extend `MissionMayCompleteResult.terminal` (or equivalent explicit driver branching) so `PLANNING` is expressible. Do not map continuable incompletes to terminal `FAILED`.
3. **Post-integrate three-way fork.** After a **successful** integrate (evaluate after the winner is recorded `INTEGRATED`):
   - if continuable coding work remains → `PLANNING`;
   - else if any exhausted incomplete coding task remains → `FAILED` (do **not** enter `REVIEWING` / record a clean round on that doomed checkpoint);
   - else (every coding task acceptable-terminal) → `REVIEWING`.  
   Intermediate checkpoints without per-task review are intentional until the final all-terminal REVIEWING; B6 still binds clean rounds to the current hash when review runs.
4. **No REJECTED/CANCELLED escape.** Do not add production transitions that relabel exhausted incompletes into `REJECTED`/`CANCELLED` to satisfy invariant 1. Invariant 4 of the draft’s spirit: no replacement `task.created` either.
5. **Finding-origin coding tasks.** Non-terminal `valid_finding` coding tasks are incompletes under invariant 1 and continuable under the definition when not exhausted. Convergence must not DONE; with continuable finding-origin coding work it must PLANNING (invariant 2).
6. **No FSM widening.** Do not add `INTEGRATING → EXECUTING`, `INTEGRATING → NEEDS_HUMAN`, or other new run-phase edges. INTEGRATING may return only `REVIEWING` | `PLANNING` | `FAILED`.
7. **Positive multi-task completion.** A scripted two-coding-task mission must be able to reach `DONE` after both are `INTEGRATED` and B6 evidence is present (not merely “never DONE”).
8. **No C-scope creep.** No C1/C2-as-the-fix, C5–C11, items 5–9/11–15, Phase D, `phase-c-accepted`, or “Phase B closed.”
9. **Deterministic acceptance only.** ScriptedProvider / in-memory Store. No live/paid providers. Composer unused.

## PHASE_REQUIRED surface

1. Extend `assertCodeChangeMissionMayComplete` (+ result terminal / driver mapping) for invariants 1–2.
2. Change `createIntegratingDriver` success path for invariant 3.
3. Wire production `createConvergenceDriver` so invariant 2 holds (no DONE / no false FAILED on continuable work).
4. Tests for all acceptance checks; `pnpm check` + `pnpm build` on Node 24.20.0.

## Deterministic acceptance checks

1. **Single coding task integrate:** success → `REVIEWING`.
2. **Two READY coding tasks:** after A integrates → `PLANNING`; zero new `task.created`; B still incomplete.
3. **Dependent PENDING:** B `PENDING` with `dependsOn: [A]`; after A integrates → `PLANNING`; next PLANNING tick → `EXECUTING` with B promoted/same id; zero new `task.created`.
4. **Anti-fake incomplete:** one `INTEGRATED` + one `READY` → `{ ok: false }`.
5. **Anti-fake valid_finding:** one `INTEGRATED` mission coding + one non-terminal `valid_finding` coding (`READY` or `PENDING`) → `{ ok: false }`; scripted CONVERGENCE tick → `PLANNING`, not `DONE`/`FAILED`.
6. **Anti-fake all INTEGRATED:** all coding `INTEGRATED` (+ sufficient B6 evidence) → multi-task axis allows `{ ok: true }`.
7. **Anti-fake BLOCKED sibling:** one `INTEGRATED` + one `BLOCKED` → `{ ok: false }`; CONVERGENCE → `FAILED` (not `DONE`); INTEGRATING success with only exhausted incompletes → `FAILED` not `REVIEWING`.
8. **REJECTED/CANCELLED siblings (pre-seeded only):** one `INTEGRATED` + others only pre-seeded `REJECTED`/`CANCELLED` → multi-task axis does not fail solely for those; **and** no driver under this task’s diff emits a new `REJECTED`/`CANCELLED` transition for an exhausted coding task.
9. **E2E two-task DONE:** scripted run with two coding tasks completes A then B through EXECUTING→GATING→COMPARING→INTEGRATING (second integrate after PLANNING continue), reaches `DONE` once both `INTEGRATED` and B6 evidence present; assert phase handoff includes `INTEGRATING → PLANNING` after the first success.
10. **Review-only:** no coding tasks → multi-task axis does not force fail.
11. Named suites green including convergence, candidate-drivers, planning-reentry, validating-drivers, fsm pins; plus focused multi-task tests.
12. `pnpm check` + `pnpm build` Node 24.20.0; no live/paid calls.

## Explicit non-goals

- Items 5–9, 11–15; reopening item 4.
- Making investigation EXECUTING-schedulable; rebasing stale `baseCheckpointHash` on siblings (gates/cherry-pick decide; no rebase in this task).
- Widening `RUN_PHASE_TABLE`.
- Changing clean-round thresholds or dominance math beyond routing/anti-fake extension.
- Live Polish dogfood as required acceptance.
- Phase C remaining / Phase D / `phase-c-accepted`.

## Implementation workspace proposal (proposal only)

`/Users/fedorsvetlov/polish-worktrees/phase-c/B-selfhost-3/` with `grok/`, `claude/`, `polish/`, `integration/` and root `OWNERSHIP.json`. No existing `/Users/fedorsvetlov/polish-*` tree is moved or deleted.

## Contract-review and acceptance authority

- Reviewed draft hash `bb5ba00f3b669224915ed6a11a40449c5daa422bc5b31fb2dd345470a575a076`: Grok **FAIL** (4 blocking), Claude **FAIL** (5 blocking). All blocking findings incorporated above. **No second Claude contract review** (same scheme as C8 / B-selfhost-4).
- Implementation acceptance: deterministic evidence + fresh Grok and Claude code reviews (2 clean rounds).
- Composer unused. No Max/Ultra. No paid/live calls without explicit user permission.
