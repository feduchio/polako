# B-selfhost-4 provenance ledger

Contract: `docs/ledger/B-selfhost-4.md` (immutable after freeze commit).  
Do not treat this file as a second contract.

| Field | Value |
|---|---|
| Status | **ACCEPTED** at `84f2f7e` — clean 2/2. Phase B not fully closed. Phase C not accepted. |
| Exact base | `311203830720a4d1e917785e577eaf868281bc8a` (accepted C8) |
| Source finding | `docs/ledger/B-selfhost-remaining.md` item 4 |
| Trusted predecessor | C8 accepted `3112038`; Phase-C pause for bounded B |
| Open dependency boundary | Other B-selfhost items remain OPEN; full B DEFERRED_BY_USER |
| Reviewed draft hash | `636e2aa7656c35ad35260c2bb8d5bdea1e75ddf539adc01a0aa9daa3d32b0180` |
| Frozen contract hash | `c93c122b2fe95e2845bfb748a98d13d4316351f13ce742e5da064da19a1f825b` |
| Grok contract review | **FAIL** on draft `636e2aa…`; 6 blocking VALID |
| Claude contract review | **FAIL** on draft `636e2aa…`; 5 blocking VALID |
| Review findings | all blocking findings incorporated; no second Claude contract review |
| Contract freeze commit | `7489ad167902b5d590860d70c6fc97b9aac2c2de` |
| Implementation | Grok `84f2f7ef55f4d97e7936b5e7d775bba358f60c90`; Claude unused; Polish deferred |
| Polish run | none required for accept |
| Paid/live calls | forbidden; none |
| Clean rounds | 2/2 on `84f2f7e` (Grok+Claude PASS, then Grok+Claude PASS) |
| Accepted commit | `84f2f7ef55f4d97e7936b5e7d775bba358f60c90` (`task/B-selfhost-4-candidate-grok` / `task/B-selfhost-4-integration`) |
| Next bounded step | Continue pause: next remaining B finding (user order or item 3). Do not enter Phase D. Do not tag `phase-c-accepted`. |

## Execution plan (completed for B-selfhost-4)

1. Draft + Grok/Claude contract reviews of hash `636e2aa…` → FAIL/FAIL.
2. Incorporate blocking findings; freeze `7489ad1` / contract hash `c93c122b…f825b`.
3. Grok implementer on exact base → `84f2f7e`.
4. Coordinator gates: Node 24.20.0 typecheck + **584** tests.
5. Clean rounds 2/2 PASS/PASS. Accept.

## Accepted candidate `84f2f7e`

Worktree: `/Users/fedorsvetlov/polish-worktrees/phase-c/B-selfhost-4/grok`. Integration: `/Users/fedorsvetlov/polish-worktrees/phase-c/B-selfhost-4/integration`. Frozen `B-selfhost-4.md` unchanged.

| Round | Grok | Claude |
|---|---|---|
| 1 | PASS | PASS |
| 2 | PASS | PASS |

No blocking VALID at accepted commit. Recorded non-blocking: broader `liveCoding→EXECUTING` than literal REVIEWING for unschedulable leftover states (stalls safely; crash-recovery item 12); bare driver in unit tests vs `withReadyPromotion`; stale `selectedCandidateId` on INTEGRATING retry.
