# Phase C — full v1 (in progress)

Phase B remains **OPEN**. This file does not accept Phase B and does not accept Phase C.

## Collaboration lanes (user decision 2026-09-04)

Independent implementation and review lanes are **Grok / Claude / Polish**.

Composer is **not** used from this decision onward (implementers, blind compare, or adversarial review). Historical Composer C3 artifacts remain in the ledger as evidence already obtained; they are not a reason to launch Composer again.

Clean rounds for remaining C work require fresh **Grok** and **Claude** reviewers, plus Polish verification when HOST can complete it.

## Trusted generations

| Role | Object | Notes |
|---|---|---|
| HOST (immutable during a C task verification run) | tag `phase-b-collab-base` → `0b21a6182507e9883d020ceba0c39aa4edcfff5b` | Used for C3 Polish lane. Phase B not fully accepted. |
| C3 accepted | `0abcf62e8d277481dfb34aa8a047a9c40f4e8c50` on `task/C3-integration` | Task C3 only. Phase C not accepted. Do not tag `phase-c-accepted`. |
| C2 accepted | `7139e9cc2ad8a58e35a5b1535941eddbf4c25f13` on `task/C2-integration` | Task C2 only. B-8 remains OPEN. Phase C not accepted. Do not tag `phase-c-accepted`. |
| C4 accepted | `4fae1473f5dd5430f58d613ad7c90beed1128cf9` on `task/C4-integration` | Task C4 only. B-4/B-8/B-11 remain OPEN. Phase C not accepted. Do not tag `phase-c-accepted`. |
| C8 accepted | `311203830720a4d1e917785e577eaf868281bc8a` on `task/C8-integration` | Task C8 only. |
| B-selfhost-4 accepted | `84f2f7ef55f4d97e7936b5e7d775bba358f60c90` on `task/B-selfhost-4-integration` | Bounded B finding 4 only. |
| B-selfhost-3 accepted | `fd8a99c402656f7fe3aa6dc02377cc76713ab411` on `task/B-selfhost-3-integration` | Bounded B finding 3 only. |
| B-selfhost-5 accepted (next HOST) | `916f7f26df1b7490d35289781a4e799d7cd8e7ed` on `task/B-selfhost-5-integration` | Bounded B finding 5 only. Phase B not fully closed. Phase C not accepted. |
| Production `main` | `8d23cfd75d009daf0ad19285cc850f5ec25632e0` | Merge of HOST + untrusted `archive/post-a-wip` C/D donor files. **Not** an accepted C checkpoint. |
| Development branch | `phase-c-collab` | Branched from HOST, not from `main`'s donor overlay. |
| TARGET | per-task worktrees from the frozen task-contract commit | Must not be the HOST checkout. |

Historical `docs/ledger/C1.md`–`C11.md` / `C-audit.md` on `main` / `archive/post-a-wip` are **HISTORICAL / SUPERSEDED / NOT ACCEPTANCE EVIDENCE**.

Donor C/D files that exist only on `main` (pathology, debate, audition, native CodeGraph, scouts, `sandbox-exec`, doctor/gc, heuristic `sidecars/llm_verifier/main.py`, …) may be inspected against the **current** contract and ported selectively. They are not trusted HOST capabilities.

## Remaining Phase-B findings (still OPEN)

Source of truth: `docs/ledger/B-selfhost-remaining.md`. Not deferred, not optional, not relabeled as C.

Open items: **6–9, 11–15**. Items **3–5** ACCEPTED.

Item 10 (`listModels()[0]` reviewer selection) was lifted into `B-bootstrap-cost-eligibility` (ACCEPTED). Full Phase-B self-host closure remains **DEFERRED_BY_USER**.

## Dependency analysis (Fable §17 Phase C vs current tree)

Fable Phase C tasks and actual dependencies on accepted A/B plus open B defects:

| Task | Fable | Depends on | Open B touch? | Notes |
|---|---|---|---|---|
| **C3** VerifierAdapter / llm-verifier sidecar | §17 C3; §0 sidecar; topology Tournament→sidecar | B3 tournament, B9 `COMPARING` driver, config `verifier.*` | **Touches B-11** (production `new PairwiseJudge()` with no provider). Does not depend on B-11 being fixed first: tournament already functions; C3 adds sidecar as primary judge. B-11 stays OPEN on the TS fallback unless a later task injects a provider. | First task. |
| **C2** Pathology / budget engine | §17 C2 | B6 convergence | Touches B-8 (budget overrides unused / hard caps). Not a C2 prerequisite: B-8 is Option A hard caps on CLI budget, not pathology. Record if C2 edits budget code. | Second. |
| **C4** Prosecutor/Defender/Judge | §17 C4 | B5 finding validator | No MISSION_CRITICAL B blocker. | Third. |
| **C8** Model observations / AuditionStrategy | §17 C8; A12.9 | A8 broker observations | No MISSION_CRITICAL B blocker. | Fourth. |
| *pause* | — | trusted C3/C2/C4/C8 HOST | Use stronger Polish to close remaining **bounded** B findings one-by-one. | User-authorized. |
| **C1** Simplification pass | §17 C1 | B6; FSM `SIMPLIFYING` already exists | No. | After pause. |
| **C5** CodeGraph native | §17 C5 | A10 intel probe | No. | |
| **C6** Cursor/MCP UX, answer flow | §17 C6 | B9 daemon/MCP; B-bootstrap UX | Touches B-13 (NEEDS_HUMAN/STOP-RESUME through daemon) if answer flow is wired. Treat as bounded B prerequisite only if C6 cannot meet contract without it. | |
| **C7** Scouts | §17 C7 | A7 discovery | No. | |
| **C9** Hardening, `polish gc`, `polish doctor` | §17 C9 | B9 CLI | Touches B-12 (crash recovery incomplete). Do not claim B-12 closed by C9 GC/doctor. | |
| **C10** `SandboxExecSandbox` | §17 C10 | A6 sandbox interface | No. | |
| **C11** Runtime expansion | §17 C11 | B12 runtime v1 | **Touches B-6, B-15** (runtime evidence path / required happy path). Those become bounded B prerequisites before C11, not silently absorbed. | Last. |

No C task depends on another C task except that later tasks may **use** an independently accepted earlier C capability as trusted HOST infrastructure. C3 must not self-verify.

## Proposed execution order

Recorded before implementation. User authorized reordering within Phase C for bootstrapping.

1. **C3** — verification multiplier; no C dependency; B3 exists.
2. **C2** — safe long-running autonomy.
3. **C4** — UNCERTAIN-finding arbitration.
4. **C8** — model observations / audition scope from the original plan.
5. **Pause** — bounded remaining B findings, one-by-one, using the stronger HOST.
6. Remaining Fable C: C1, C5, C6, C7, C9, C10, C11 in dependency order as above.

Do not invent C scope outside Fable §17 Phase C. Do not enter Phase D. Do not tag `phase-c-accepted` while unresolved MISSION_CRITICAL B defects can invalidate C guarantees, unless the user explicitly defers them at the release boundary.

## First task

C3. Contract: `docs/ledger/C3.md`. Provenance: `docs/ledger/C3-run.md`. **Task ACCEPTED** at `0abcf62e8d277481dfb34aa8a047a9c40f4e8c50`.

C2. Contract: `docs/ledger/C2.md`. Provenance: `docs/ledger/C2-run.md`. **Task ACCEPTED** at `7139e9cc2ad8a58e35a5b1535941eddbf4c25f13`.

C4. Contract: `docs/ledger/C4.md`. Provenance: `docs/ledger/C4-run.md`. **Task ACCEPTED** at `4fae1473f5dd5430f58d613ad7c90beed1128cf9`.

C8. Contract: `docs/ledger/C8.md`. Provenance: `docs/ledger/C8-run.md`. **Task ACCEPTED** at `311203830720a4d1e917785e577eaf868281bc8a`.

**Pause (user-authorized, full remaining plan):** B-selfhost-3/4/5 ACCEPTED (`fd8a99c` / `84f2f7e` / `916f7f2`). **B-selfhost-6** draft running. Then 7–9, 11–15, then remaining Fable C. Do not enter Phase D. Do not tag `phase-c-accepted`.
