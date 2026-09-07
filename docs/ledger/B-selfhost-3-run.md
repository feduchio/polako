# B-selfhost-3 provenance ledger

Contract: `docs/ledger/B-selfhost-3.md` (immutable after freeze commit).  
Do not treat this file as a second contract.

| Field | Value |
|---|---|
| Status | **ACCEPTED** at `fd8a99c` — clean 2/2. Phase B not fully closed. Phase C not accepted. |
| Exact base | `84f2f7ef55f4d97e7936b5e7d775bba358f60c90` (accepted B-selfhost-4) |
| Source finding | `docs/ledger/B-selfhost-remaining.md` item 3 |
| Trusted predecessor | B-selfhost-4 accepted `84f2f7e`; Phase-C pause |
| Open dependency boundary | Items 5–9, 11–15 OPEN; full B DEFERRED_BY_USER |
| Reviewed draft hash | `bb5ba00f3b669224915ed6a11a40449c5daa422bc5b31fb2dd345470a575a076` |
| Frozen contract hash | `8d0c76ff314297fcad32089646f2e2dc94ed6b9d45c47faf2f7bfd9a54a20ff7` |
| Grok contract review | **FAIL** on draft; 4 blocking VALID |
| Claude contract review | **FAIL** on draft; 5 blocking VALID |
| Review findings | all blocking findings incorporated; no second Claude contract review |
| Contract freeze commit | `8fd73184455cdf508f90a10fb8bc9b78a8ae7857` |
| Implementation | Grok `fd8a99c402656f7fe3aa6dc02377cc76713ab411`; Claude unused; Polish deferred |
| Polish run | none required for accept |
| Paid/live calls | forbidden; none |
| Clean rounds | 2/2 on `fd8a99c` (Grok+Claude PASS, then Grok+Claude PASS) |
| Accepted commit | `fd8a99c402656f7fe3aa6dc02377cc76713ab411` (`task/B-selfhost-3-candidate-grok` / `task/B-selfhost-3-integration`) |
| Next bounded step | Continue pause: item 5+ or user reorder. Do not enter Phase D. Do not tag `phase-c-accepted`. |

## Accepted candidate `fd8a99c`

| Round | Grok | Claude |
|---|---|---|
| 1 | PASS | PASS |
| 2 | PASS | PASS |

No blocking VALID. Non-blocking: incomplete check before other B6 reasons; duplicated maxAttempts default; PENDING+unsatisfiable-deps continuable loop; local test promotion wrapper.
