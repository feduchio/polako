# R2 — run record

Contract: `docs/ledger/R2.md`. Base: `fe686f0`. Date: 2026-09-15.
Coordinator/implementer: Claude Opus 5. Reviewer lane: GPT (`gpt-5.6-sol-high`), one lane.

## The change

`src/review/canary.ts` holds one diff with one planted defect — `evictStale` iterating
`i <= entries.length` and dereferencing one past the end — and `runReviewerCanary`, which sends it
through `runAxisReview`. Not a copy of it: the same function, so the canary exercises the same
prompt composition, the same `REVIEW_FINDINGS_RESPONSE_SCHEMA`, the same parse and the same shape
normalisation that `docs/RECOVERY.md` §1.2 records as shipped on 12 September and never once run in
production.

The VALIDATING driver gates the clean round on it. Before `recordCleanRoundIfEligible`, every model
that produced the pending review round — completed executions, skips excluded, because a skip
reached no provider — must have a verified canary for this run. Any that does not sends the run to
`NEEDS_HUMAN` with the new terminal code `review_unverifiable`, and nothing is recorded clean.

The planted defect is ordinary on purpose. A reviewer that misses an off-by-one has told us nothing
about the code it just passed.

## Acceptance

Each check is a test that fails against the previous behaviour.

1. **The plan's own check, and stronger.** A reviewer returning `{"findings":[]}` on the seeded
   diff leaves the run in `NEEDS_HUMAN`, `terminalReason.code = "review_unverifiable"`, the summary
   naming `reviews:m0`, and `cleanRounds` empty. Not merely "does not reach `DONE`": it does not
   reach a clean round, which is the thing three of which make `DONE`.
2. **A working reviewer is not punished.** One that reports the defect leaves the run advancing to
   `CONVERGENCE_CHECK` with one clean round and one `review.canary_recorded` event carrying
   `verified: true`.
3. **Silence is not an answer.** A canary whose provider call throws is unverified, and the
   recorded verdict carries the provider's message.
4. **Once per model per run.** Two rounds, one provider call.
5. **Nothing is spent where nothing would be granted.** With no clean round pending, no canary call
   is made at all.

The same test also pins that the canary's request carries the seeded diff — `evictStale` appears in
the messages — so a canary that quietly stopped sending the defect would fail.

## What the first run of these tests found

The canary's synthetic checkpoint used `commitHash: "canary000…"` and an id of `ckpt_canary…`.
`GitHashSchema` is `/^[0-9a-f]{7,64}$/` and `IdSchema` is `/^[a-z]+_[0-9a-hjkmnp-tv-z]{22}$/`, so
`FindingSchema.parse` threw on every canary finding, the catch recorded `verified: false`, and
**every** reviewer would have failed its canary — turning R2 from a gate into a wall. The ids are
now valid: `ca4a24…ca` and `ckpt_0000000000000000canary`.

## What the gate found

Six E2E tests failed on the first full run, all with the same shape: `expected 'NEEDS_HUMAN' to be
'DONE'` and `at least one clean round must be recorded: expected 0 to be greater than 0`. Their
scripted reviewers answer `{"findings":[]}` to everything, which is precisely the condition R2
exists to refuse — so the fixtures were the first thing R2 caught, and they were caught being
exactly what §1.1 describes.

The fixtures now answer the canary and stay silent on the real diff, which is what those runs
assert about. `src/e2e/b10.test.ts`'s reasoning-policy table gained a **second**
`reviewer|review_correctness` row, and that row is part of the claim: the canary is deliberately
the same shape as a review — same role, same schema, same disabled reasoning — because a canary
down a different path would verify a path the reviewer does not use.

## Gates and size

Node 24.20.0, `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm vitest run --maxWorkers=2`
→ exit 0, 95 files, **1136 tests** (1131 before this item).
`git diff --numstat fe686f0 -- src`: 126 production insertions, 152 test — 278 total, inside the
plan's 300.

## Not covered

- The negative half of the pair: clean code must produce **no** finding. A reviewer that fabricates
  passes this gate. That is a different failure from the one observed and it is measured offline by
  `docs/PLAN.md` item 42; it becomes an item when a run shows invented findings.
- The canary is one defect. A reviewer tuned to it would pass while seeing nothing else — which no
  observed run makes likely, and which a second seeded defect would only postpone.
