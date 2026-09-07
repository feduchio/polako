# B-selfhost-4 provenance ledger

Contract: `docs/ledger/B-selfhost-4.md` (immutable after freeze commit).  
Do not treat this file as a second contract.

| Field | Value |
|---|---|
| Status | **CONTRACT FROZEN** — implementation next |
| Exact base | `311203830720a4d1e917785e577eaf868281bc8a` (accepted C8) |
| Source finding | `docs/ledger/B-selfhost-remaining.md` item 4 |
| Trusted predecessor | C8 accepted `3112038`; Phase-C pause for bounded B |
| Open dependency boundary | Other B-selfhost items remain OPEN; full B DEFERRED_BY_USER |
| Reviewed draft hash | `636e2aa7656c35ad35260c2bb8d5bdea1e75ddf539adc01a0aa9daa3d32b0180` |
| Frozen contract hash | `c93c122b2fe95e2845bfb748a98d13d4316351f13ce742e5da064da19a1f825b` |
| Grok contract review | **FAIL** on draft `636e2aa…`; 6 blocking VALID |
| Claude contract review | **FAIL** on draft `636e2aa…`; 5 blocking VALID |
| Review findings | all blocking findings incorporated; no second Claude contract review |
| Contract freeze commit | pending (this ledger update) |
| Implementation | pending Grok on `task/B-selfhost-4-candidate-grok` |
| Paid/live calls | forbidden; none |
| Clean rounds | 0/2 |
| Next bounded step | Implement frozen contract. Do not enter Phase D. Do not tag `phase-c-accepted`. |

## Independent contract reviews

Both lanes reviewed draft hash `636e2aa…0180` and exact base `3112038`.

### Grok — FAIL (incorporated)

1. INTEGRATION_FAILED never restored to READY — hang after no-decompose.
2. Mission-origin / logical work undefined; title-skip hatch.
3. Re-entry still allowed to call decompose / NEEDS_HUMAN.
4. Optional GATING→EXECUTING left createPlanningDriver unfixed.
5. BLOCKED-only → REVIEWING contradiction.
6. Investigation routed to EXECUTING which cannot schedule it.

### Claude — FAIL (incorporated)

B-1 INTEGRATING stall; B-2 investigation → DONE silent drop; B-3 illegal GATING→EXECUTING; B-4 invariant 1 vs 6 / no decompose spy; B-5 undefined mission-origin / inconsistent checks.
