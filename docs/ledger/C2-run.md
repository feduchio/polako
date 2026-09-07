# C2 provenance ledger

Contract: `docs/ledger/C2.md` (draft until freeze commit).  
Do not treat this file as a second contract. After freeze the contract is immutable for implementation.

| Field | Value |
|---|---|
| Status | **ACCEPTED** at `7139e9c` — clean 2/2. Phase C is **not** complete. B-8 remains OPEN. |
| Exact base | `0abcf62e8d277481dfb34aa8a047a9c40f4e8c50` (`task/C3-integration`) |
| Trusted predecessor | C3 accepted checkpoint `0abcf62e8d277481dfb34aa8a047a9c40f4e8c50` |
| Fable scope | §17 C2 — pathology detectors, bounded strategies, budget engine |
| Accepted dependency | B6 convergence / clean-round proof / dominance rollback |
| Open dependency boundary | B-8 remains OPEN; C2 does not prove CLI budget overrides are production hard caps |
| Untrusted references | historical `main` / `archive` `docs/ledger/C2.md` and `src/convergence/pathology*` |
| Reviewed draft hash | `48faac5e2d30dcb19b03b35a22de9b71a7e6bc626aa8b069f4853134fcf498b6` |
| Frozen contract hash | `a176319c493f26504bd628fedc497e9a07683c10b248b87562bddab5c92a9da2` |
| Grok contract review | **FAIL** on reviewed draft; 3 blocking + 3 non-blocking VALID, 1 style-provenance item promoted by Claude |
| Claude contract review | **FAIL** on reviewed draft; 3 blocking + 4 non-blocking VALID |
| Review findings | all blocking findings resolved in the frozen text; no second review launch |
| Contract freeze commit | `cfeacaaedf6e267461d09acc135cc641a16a26df` |
| Implementation | Grok `7139e9cc2ad8a58e35a5b1535941eddbf4c25f13` (on `9529f74` / `15733fc` / `560a033`); Claude implementer unused; Polish deferred (B-4) |
| Polish run | none (B-4 GATING loop); not a C2 code finding |
| Paid/live calls | forbidden; none |
| Clean rounds | 2/2 on `7139e9c` (Grok+Claude PASS, then Grok+Claude PASS; no code change after that SHA) |
| Accepted C2 commit | `7139e9cc2ad8a58e35a5b1535941eddbf4c25f13` (`task/C2-candidate-grok` / `task/C2-integration`) |
| Next bounded step | C4 contract freeze (Prosecutor/Defender/Judge). Do not enter Phase D. Do not tag `phase-c-accepted`. |

## Execution plan (this round)

1. Create `/Users/fedorsvetlov/polish-worktrees/phase-c/C2/` with `OWNERSHIP.json`. Do not move or delete existing `/Users/fedorsvetlov/polish-*` trees.
2. Git worktree `grok/` from exact base `0abcf62`, branch `task/C2-candidate-grok`, plus freeze docs (`C2.md` / `C2-run.md`) so the contract is in-tree.
3. Grok implementer only: frozen `docs/ledger/C2.md`, no paid APIs, no B-8 close, no C3 self-oracle, `pnpm check` + `pnpm build` on Node 24.20.0.
4. Coordinator independently re-runs gates, then one Grok review and one bounded Claude review of the same commit.
5. Claude implementer lane stays reserved (not used as a second implementer this checkpoint). Polish coding/verify waits until HOST can complete GATING (B-4).
6. C4 and later C tasks start only after C2 has two clean Grok+Claude rounds or an explicit user reorder.

## Independent contract reviews

Both lanes reviewed the exact same `C2.md` hash `48faac5e…f498b6` and exact base `0abcf62e…e8c50`. Neither received the other lane's reasoning.

### Grok

Result: **FAIL**.

Validated and incorporated:

- `C2-C-001` BLOCKING — ordinary proof-bearing B6 clean rounds could satisfy `no_progress`; clean-round identity is now progress and the detector is silent when B6 DONE-eligible.
- `C2-C-002` BLOCKING — simultaneous detectors had no action composition; the frozen contract defines one total priority and persists all detections.
- `C2-C-003` BLOCKING — disagreement-set membership was underspecified; the frozen contract defines structured opposing positions, 2-of-3 behavior, checkpoint/round scope, shrink, and negative cases.
- `C2-C-004` NON_BLOCKING, corroborated/promoted by Claude — style provenance absent from exact base; the frozen contract introduces typed orthogonal `TaskWorkClass` without weakening `TaskOrigin`.
- `C2-C-005` NON_BLOCKING — B-8 boundary could imply a second cap; frozen text uses only live `config.budget` and records CLI metadata as unused.
- `C2-C-006` NON_BLOCKING — post-rollback phase unclear; frozen text continues at REVIEWING/required PLANNING, never C1 SIMPLIFYING.

### Claude

Result: **FAIL**.

Validated and incorporated:

- `C2-B1` BLOCKING — style-only positive case unreachable/unspecified; resolved by typed `workClass`, legal-origin constraints, fail-safe historical default, and exact positive/negative fixtures.
- `C2-B2` BLOCKING — budget precedence versus B6 DONE was contradictory; frozen total order makes already-DONE-eligible completion win, then budget stop precedes every recovery.
- `C2-B3` BLOCKING — `BUDGET_STOP` terminal was ambiguous; frozen outcome is exactly `(phase=FAILED, terminalReason.code=budget_exhausted)`.
- `C2-N1` — wall-clock tick producer absent; frozen contract requires one persisted scheduler deadline job with deduplicated recovery.
- `C2-N2` — undefined decision version; frozen v1 constant is `1`, never a retry counter.
- `C2-N3` — “required gates” not representable; frozen additional predicate is no `{fail,error,timeout}` gate on top of B6 dominance.
- `C2-N4` — broker and C2 folds could diverge; frozen contract requires `BrokerService.restore()` to delegate to the canonical fold and equality tests.

Coordinator resolution of budget precedence: the user required exhaustion to precede **recovery**, not to turn a fully verified completion into failure. Therefore B6 anti-fake/state-integrity is checked first, B6 DONE eligibility completes second, and only a run that needs more work can budget-stop before any recovery.

## Centralized worktree proposal

Proposal only; no directory is created during contract freeze:

`/Users/fedorsvetlov/polish-worktrees/phase-c/C2/`

Planned children: `grok/`, `claude/`, `polish/`, `integration/`. A root `OWNERSHIP.json` will bind each child to exact base, branch, owner, purpose, creation time, and retention state. Existing worktrees remain in place. Any move/delete/cleanup requires explicit user approval.

## Implementation candidate `560a033` — FAIL

Worktree: `/Users/fedorsvetlov/polish-worktrees/phase-c/C2/grok`. Coordinator gates: typecheck/lint/depcruise/518 tests. Frozen `C2.md` unchanged. B-8 OPEN.

Grok review FAIL; Claude review FAIL (same SHA). Coordinator-validated blocking:

1. Observation boundary used `events.at(-1)` (polling minted samples).
2. Private `isB6DoneEligible` bypassed B6 dominance / investigation-exhausted.
3. ROLLBACK execute used gate-only fallback and could swap hashes.
4. Council never persisted `workClass` provenance.

## Fix candidate `15733fc`

Claimed to address the four blocking items. Coordinator typecheck + 526 tests on Node 24.20.0.

Round 1 Grok+Claude PASS; round 2 FAIL (windows, `reviewersPerRound` vs validation, live `workClass` prompts, production `CHANGE_ENSEMBLE`).

## Fix candidate `9529f74`

Coordinator typecheck + 531 tests. Round 1 PASS/PASS; round 2 FAIL. Coordinator-validated blocking: validation-round completeness must not use `reviewersPerRound`; CHANGE_ENSEMBLE checkpoint scope; disagreement independent `performedBy`.

## Accepted candidate `7139e9c`

Worktree: `/Users/fedorsvetlov/polish-worktrees/phase-c/C2/grok`. Integration: `/Users/fedorsvetlov/polish-worktrees/phase-c/C2/integration`. Frozen `C2.md` unchanged. B-8 OPEN.

Coordinator gates: typecheck + 535 tests on Node 24.20.0.

| Round | Grok | Claude |
|---|---|---|
| 1 | PASS | PASS |
| 2 | PASS | PASS |

No blocking VALID at accepted commit. Recorded non-blocking (not C2 blockers): trailing duplicate/noise can skip a validation boundary (sample lag); production disagreement/`finding_oscillation` often silent under single `evidence_agent` + duplicate triage; `orderReviewersByEnsemble` reorders rather than restricts; `ensembleChangeCount` charges co-firing kinds; B-8 unused CLI metadata not populated in production snapshots.

Polish HOST verify still deferred (B-4). C3 sidecar was not used as an oracle.
