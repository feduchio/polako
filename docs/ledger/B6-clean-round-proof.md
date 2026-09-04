# B6-clean-round-proof — Each CleanRound binds one completed review round

**Status:** ACCEPTED (Composer verifier, `blocking_findings: 0`; live RetryFetcher smoke `DONE`)  
**Class default:** PHASE_REQUIRED (MISSION_CRITICAL B6 proof invariant; not Phase C)  
**Prompt:** Independent review of HEAD `3bede58`. `CleanRound` had no identity of the review round that proves it; `cleanRoundsHaveReviewProof` validated every clean round against `latestCompletedReviewRound`; `recordCleanRoundIfEligible` counted incomplete/failure-only review round indexes.  
**Do not:** Phase C; remaining `B-selfhost-remaining`; weakening proof because 429/400 siblings coexist with a completed round.

## Per-task BVP

- Implementer: Grok 4.6 (this chat)
- Deterministic gates (orchestrator): `pnpm check` PASS — 59 files / 478 tests
- Verifier: Composer 2.5 ([Adversarial clean-round review](bc1a4459-7cc2-4ef9-b1de-a12f22e60df6)) — PASS, `blocking_findings: 0`
- Live: `run_01m1p013kghsprxj7atb6w` → `DONE`, checkpoint `b35fe739f64c…` ≠ baseline `44e6bf3f2938…`, 3 clean rounds bound to review rounds 1/2/3, fixture tests 3/3. Target `main` not applied.

Non-blocking residue: historical CleanRounds without `reviewRoundIndex` do not reserve consumption (anti-fake-DONE still fails closed on mixed history); completeness is count-based, not distinct-axis.

## Root-cause class

`CleanRound.roundIndex` is the convergence counter, not the review-swarm round. Proof used the latest completed review round for every stored clean round, so three CleanRound rows plus one completed review round returned true. Recording counted distinct `execution.roundIndex` values including failure-only rounds, so an incomplete new review round could mint another CleanRound from the previous completed round.

## Required behavior

1. Bind every new CleanRound to an exact `reviewRoundIndex`.
2. One completed review round may prove at most one clean round.
3. `recordCleanRoundIfEligible` enumerates actually completed review rounds and consumes only an unconsumed completed round.
4. `cleanRoundsHaveReviewProof` verifies every CleanRound against its own `reviewRoundIndex`.
5. Verify checkpoint, required completed review count, axes, and model ensemble against that exact round (completed executions only).
6. Historical clean rounds lacking `reviewRoundIndex` remain readable/replayable and fail closed for anti-fake-DONE.
7. Failed 429/400 siblings must not throw when recording a completed round, and must not create additional clean rounds.

## Deterministic evidence

- A: 3 clean rounds + 1 completed review round → proof FALSE.
- B: review round 1 complete + clean round 1; review round 2 failures only → clean round 2 not recorded.
- C: 3 distinct completed review rounds → exactly 3 clean rounds with `reviewRoundIndex` 1/2/3 → proof TRUE.
- D: clean round references a stale/wrong checkpoint review round → proof FALSE.
- `pnpm check`.
- Live RetryFetcher smoke `run_01m1p013kghsprxj7atb6w`:
  - clean round 1 → review round 1 → `rvex_01m1p0se2ew2e84v3yxmh7`, `rvex_01m1p10xv5zdcjkpjm2nmz`, `rvex_01m1p2jgnqxf50359kmc3m`
  - clean round 2 → review round 2 → `rvex_01m1p2m21zj7b7h8b5tgyw`, `rvex_01m1p2xeeb0hyazcqwzbdd`, `rvex_01m1p519tm3qwsc7pek4m1`
  - clean round 3 → review round 3 → `rvex_01m1p51b37hw72fm5nn61h`, `rvex_01m1p5frq0ee96fnpk99n7`, `rvex_01m1p8sz9n83j2swqm9ar3`

## Out of scope

Phase C; `B-selfhost-remaining`; `polish apply`; catalog modality filtering.
