# C8 provenance ledger

Contract: `docs/ledger/C8.md` (immutable after freeze commit).  
Do not treat this file as a second contract. After freeze the contract is immutable for implementation.

| Field | Value |
|---|---|
| Status | **ACCEPTED** at `3112038` — clean 2/2. Phase C is **not** complete. B-4/B-8/B-11 remain OPEN. |
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
| Implementation | Grok `311203830720a4d1e917785e577eaf868281bc8a`; Claude implementer unused; Polish deferred (B-4) |
| Polish run | none (B-4); not a C8 code finding |
| Paid/live calls | forbidden; none |
| Clean rounds | 2/2 on `3112038` (Grok+Claude PASS, then Grok+Claude PASS; no code change after that SHA) |
| Accepted C8 commit | `311203830720a4d1e917785e577eaf868281bc8a` (`task/C8-candidate-grok` / `task/C8-integration`) |
| Next bounded step | Pause for bounded remaining Phase-B findings (PHASE-C order), or user reorder. Do not enter Phase D. Do not tag `phase-c-accepted`. |

## Execution plan (completed for C8)

1. Draft + Grok/Claude contract reviews of hash `07876944…` → FAIL/FAIL.
2. Incorporate blocking findings; freeze `2276ffb` / contract hash `77ce51d7…5fdb`.
3. Grok implementer on exact base → `3112038`.
4. Coordinator gates: Node 24.20.0 typecheck + 572 tests.
5. Clean rounds 2/2 PASS/PASS. Accept C8. Polish deferred (B-4).

## Independent contract reviews

Both lanes reviewed draft hash `07876944…3478` and exact base `4fae147`.

### Grok — FAIL (incorporated)

CR-1…CR-7: named DISCOVERING_MODELS wiring; only `recordAudition`; A12.9; fail-closed persist; broker+cost; noop matrix; ban C3/C4 scorers.

### Claude — FAIL (incorporated)

B1…B5: harden `recordAudition`; deterministic EMA; re-audition idempotence; budget/runId; `minScoresForRouting`.

## Accepted candidate `3112038`

Worktree: `/Users/fedorsvetlov/polish-worktrees/phase-c/C8/grok`. Integration: `/Users/fedorsvetlov/polish-worktrees/phase-c/C8/integration`. Frozen `C8.md` unchanged. B-4/B-8/B-11 OPEN.

| Round | Grok | Claude |
|---|---|---|
| 1 | PASS | PASS |
| 2 | PASS | PASS |

No blocking VALID at accepted commit. Recorded non-blocking (not C8 blockers): provider throw can fail DISCOVERING_MODELS when audition enabled; duplicate task-id config footgun; missing `expected` → persist 0; unclamped returned `AuditionResult`; second observations repo instance in composition.

Polish HOST verify still deferred (B-4). C3/C4 were not used as oracles.
