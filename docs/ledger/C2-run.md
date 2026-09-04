# C2 provenance ledger

Contract: `docs/ledger/C2.md` (draft until freeze commit).  
Do not treat this file as a second contract.

| Field | Value |
|---|---|
| Status | CONTRACT FROZEN — no implementation |
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
| Contract freeze commit | filled by this freeze commit |
| Implementation | NOT STARTED |
| Polish run | none for contract freeze |
| Paid/live calls | forbidden; none |
| Clean rounds | not applicable to contract freeze |
| Accepted C2 commit | none |
| Next bounded step | after freeze only: create centralized C2 implementation worktrees with ownership/retention metadata, then launch implementation lanes |

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
