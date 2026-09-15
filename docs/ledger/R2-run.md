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
→ exit 0, 96 files, **1146 tests** (1131 before this item).

`git diff --numstat fe686f0..HEAD -- src`: **310 production insertions, 419 test — 729 total**,
against the plan's ceiling of 300.

*(The first version of this line said 278. It was measured with `git diff` while `canary.ts` was
still untracked, so the 120 lines of the item's central file were not counted, and neither were the
E2E changes. Round 1 caught it. A size claim measured before `git add` is not a size claim.)*

## Review round 1 — GPT lane, on commit `4aa8fb7`. R2 stops at the ceiling.

Verdict FAIL, 4 blocking and 5 notes.

| # | Finding | Ruling |
|---|---|---|
| 1 | The size figure is wrong: 448 insertions at that commit, not 278 | **actionable** — corrected above, with why |
| 2 | **A run can reach `DONE` with no reviewer ever canaried.** `CONVERGENCE_CHECK` never reads the canary verdicts; a run recovered after a restart, resumed through `polish answer`, or entering from `PLANNING`/`SIMPLIFYING` already has its clean rounds and bypasses the gate entirely. The existing convergence test reaches `DONE` with three seeded clean rounds and no canary event | **actionable, and the item's central defect** — the gate was in the place that *records* a clean round, not the place that *grants the verdict*. `CONVERGENCE_CHECK` now refuses `DONE` when any model in any consumed clean round's ensemble is unverified. Two tests: none verified, and one of three unverified |
| 3 | **Any finding passed.** `verified` was `findings.length > 0`, so a reviewer returning "correctness finding" at line 1 of any file passed — and the cheapest reviewer that passes is the new E2E fixture itself | **actionable** — a finding must point at the planted defect: `src/cache.ts`, lines 5–12. Five boundary cases, each on its own side |
| 4 | Once-per-run caching trusts a model forever | **partly upheld, partly declined** — the cache key is the model, and that is deliberate: the question is whether this reviewer on this transport can report anything, which is not a per-round property. What round 1 demonstrated as "the failure" is the intended case: a verified reviewer that then reports nothing on a real diff **is** a clean round. What is genuinely uncovered is drift in the prompt, schema or protocol between rounds, and that is named below rather than fixed |
| 5 | The catch-all turned budget and cancellation errors into permanent reviewer failures | **actionable** — both propagate; neither is a statement about the reviewer, and the verdict cache never retries a recorded one |
| 6 | The five tests did not establish the every-model requirement: every execution used one model | **actionable** — a round produced by three models, one of which fails, names that one and not the others |

**Size: 729 insertions against 300.** This is the fourth item in a row to breach it, and R2 stops
here as R0, R0a and R1 did. Half of the excess is fixture repair: six E2E tests and three
convergence fixtures were reaching `DONE` with reviewers that answer `{"findings":[]}` to
everything, and each had to be taught to answer the canary. That repair is not optional — those
fixtures were asserting the very thing R2 forbids — but it is also not this item's subject.

One further observation, recorded because it cost a rerun: `src/engine/candidate-drivers.test.ts`
failed once under `--maxWorkers=2` and passed in isolation and on rerun. Flaky under load, not a
regression from this item, and not investigated here.

## Review round 2 — GPT lane, on commit `efd7574`

Verdict FAIL, 1 blocking and 2 notes. Round 1's other findings were confirmed closed, including the
`DONE`-path audit: recovery, restart, `polish answer`, rollback, `CHANGE_ENSEMBLE`, simplification
and multi-task runs all reach `CONVERGENCE_CHECK`, whose gate filters clean rounds by the current
checkpoint hash — which is the same hash `hasConverged` counts, so the two agree.

| # | Finding | Ruling |
|---|---|---|
| 1 | The `located` window was lines 5–12 — the whole function, including the comment, the declaration, the return and the closing brace — so a reviewer passed by alleging something unrelated at line 11. And a correct report spelled `b/src/cache.ts` or `./src/cache.ts` failed | **actionable** — the window is lines 8 and 9: the loop header whose bound is wrong, and the dereference that goes out of bounds. Both, because a correct reviewer may cite either; nothing else, because round 1's finding was exactly that any complaint inside the function counted. Diff-flavoured and relative path spellings resolve to the same file |
| 2 | Cancellation exceptions propagate, but the canary request carries no `AbortSignal`, so `polish stop` cannot interrupt the provider call | **note, upheld and not fixed** — `runAxisReview` takes no signal either, so this is the review path's property and not this item's; fixing it here would mean threading a signal through `RunAxisReviewInput` and every caller |
| 3 | The record says "4 blocking and 5 notes" but tabulates six rows, omitting three notes; and the cost bound assumes three distinct reviewers when ensemble rotation can introduce more | **actionable on the text** — the omitted notes are now in "Not covered", and the cost claim carries its assumption |

## Not covered

- The negative half of the pair: clean code must produce **no** finding. A reviewer that fabricates
  passes this gate. That is a different failure from the one observed and it is measured offline by
  `docs/PLAN.md` item 42; it becomes an item when a run shows invented findings.
- The canary is one defect. A reviewer tuned to it would pass while seeing nothing else — which no
  observed run makes likely, and which a second seeded defect would only postpone.
- **Drift between rounds.** A verdict is keyed by model alone. If the reviewer prompt, the response
  schema, the protocol text or `review.maxOutputTokens` changes mid-run, the model is not re-asked
  under the new conditions. Naming it here rather than keying the cache on a digest of all four,
  which is the shape of the successor if a run ever shows it.
- **The cost**, for a run whose ensemble does not rotate: three distinct reviewers, three canary
  calls, each reserving about $0.0028 at the configured ceiling — under $0.01, and zero when no
  clean round is pending. The assumption is load-bearing: `selectReviewProviders` asks for at least
  eight candidates and `CHANGE_ENSEMBLE` can introduce more distinct models, each of which is
  canaried once. There is no run-wide bound on the number of canary calls, only a per-model one.
- **Cancellation reaches the canary's caller but not its provider call.** `runAxisReview` accepts
  no `AbortSignal`, so neither does the canary, so `polish stop` cannot interrupt one in flight. A
  property of the review path rather than of this item, and untouched by it.
- **The fixtures are not independent evidence.** The E2E reviewers were taught to answer the canary
  by this item, so they demonstrate the gate's shape and not any reviewer's real capability. The
  same is true of `docs/ledger/replay-set.md`, whose scripted corpus its own note already calls
  inconclusive once model requests change.
