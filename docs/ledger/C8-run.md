# C8 provenance ledger

Contract: `docs/ledger/C8.md` (immutable after freeze commit).  
Do not treat this file as a second contract. After freeze the contract is immutable for implementation.

| Field | Value |
|---|---|
| Status | CONTRACT FROZEN — no implementation |
| Exact base | `4fae1473f5dd5430f58d613ad7c90beed1128cf9` (accepted C4) |
| Trusted predecessor | C4 accepted `4fae147`; A12.9 observation persistence |
| Fable scope | §17 C8 — Model Audition / global observations + AuditionStrategy |
| Accepted dependency | A12.9; existing `ModelObservationRepository` |
| Open dependency boundary | B-4/B-8/B-11 remain OPEN; not C8 scope |
| Untrusted references | historical `main` `docs/ledger/C8.md`, `src/broker/audition.ts` |
| Reviewed draft hash | `078769440509f49a9532c2b2b6cdf93e29b0f6fb097c7ffa97979a080ede3478` |
| Frozen contract hash | `77ce51d74ddcac594816442041c02e99b2c7c0353261d33d5dbb27ac8bbc5fdb` |
| Grok contract review | **FAIL** on reviewed draft; 7 blocking VALID |
| Claude contract review | **FAIL** on reviewed draft; 5 blocking VALID |
| Review findings | all blocking findings resolved in the frozen text; no second Claude contract review |
| Contract freeze commit | `2276ffb20080823d2308c2fe670bf440a6b7a730` |
| Implementation | NOT STARTED |
| Polish run | none for contract freeze |
| Paid/live calls | forbidden; none |
| Clean rounds | not applicable to contract freeze |
| Accepted C8 commit | none |
| Next bounded step | create `/Users/fedorsvetlov/polish-worktrees/phase-c/C8/` + Grok implementer from exact base |

## Independent contract reviews

Both lanes reviewed draft hash `07876944…3478` and exact base `4fae147`.

### Grok — FAIL (incorporated)

- CR-1 named DISCOVERING_MODELS / composition wiring
- CR-2 only `recordAudition` on global run id
- CR-3 A12.9 list + catalog quality on restore
- CR-4 no invented quality / fail-closed persist
- CR-5 broker + costEligibility + bounds
- CR-6 full noop matrix
- CR-7 ban C3/C4 scorers

### Claude — FAIL (incorporated)

- B1 harden `recordAudition` vs Infinity/NaN
- B2 strictly increasing observedAt / deterministic EMA
- B3 re-audition idempotence
- B4 budget/runId + cost filter
- B5 `minScoresForRouting` before quality influences routing

## Centralized worktree proposal

`/Users/fedorsvetlov/polish-worktrees/phase-c/C8/` — create after freeze only.
