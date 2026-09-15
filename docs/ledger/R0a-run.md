# R0a — run record

Contract: `docs/ledger/R0a.md`. Base: `85911d8`. Date: 2026-09-15.
Coordinator/implementer: Claude Opus 5. Reviewer lane: GPT (`gpt-5.6-sol-high`), one lane.

## The change

`BudgetTracker.admit(runId, estimatedUsd, taskId)` replaces the bare `assertWithin` at the broker's
entry. It decides and reserves in one synchronous step — which is the whole repair, because two
callers used to reach the decision before either changed anything it reads. It returns a release
that `ModelBroker.complete` runs in a `finally`, after `attempt` has evaluated its return value and
therefore after `budget.record`.

`assertWithin` gained a third argument, the cost of the call being admitted, and now answers two
questions that were being conflated:

- **exhausted** — what is already spent or reserved has reached the limit (`>=`, unchanged, so a
  run that has spent its budget still stops exactly where it did);
- **insufficient** — one more call of this size would take the total past the limit (`>`, new).

Without the second, a $0.50 limit admits a $0.49 call while another $0.49 call is in flight. With
it, the second is refused.

The estimate is `ModelBroker.estimatedCostUsd`: everything the request puts on the wire — messages,
tools and response schema — counted at **one token per character**, plus the output allowance
(`maxTokens`, else the catalogue's `maxOutputTokens`, else 8192), priced at the catalogue's
advertised rates. When either price is unknown the estimate is 0 — such a call cannot raise
`runUsd` either, and that gap is `unknownCostCalls`, which is R6's.

One token per character over-counts ordinary prose about fourfold and is deliberately pessimistic,
but it is **not a proven upper bound**: JSON-heavy messages have been measured at 1.15 characters
per token. What this item guarantees is that N calls in flight are not all admitted against the
same figure, not that any single estimate is never exceeded.

## Acceptance

1. **The overshoot is bounded.** `refuses the second of two concurrent calls that cannot both fit`
   and `admits four calls of a quarter of the limit and refuses the fifth`. The second uses 0.125,
   which is exact in binary, so the boundary is the boundary and not a rounding artefact — with
   0.05 the accumulated total is 0.49999999999999994 and the limit is never reached.
   `refuses a single call that alone cannot fit the budget` covers the one-call case.
2. **Sequential behaviour unchanged.** The pre-existing `BudgetTracker per-run limits` suite is
   untouched and green, including `enforces the shared limits for a run with none of its own`,
   which is the "stop at the limit, not before it" case.
3. **No leak.** `releases a reservation once, whether the call succeeded or failed` — a double
   release must not create room that was never there, and the assertion fails if the reservation
   goes negative. At the broker level, `holds a reservation across the provider call and releases
   it after the cost is recorded` observes the hold from inside the provider call, where nothing is
   recorded yet and only the reservation can refuse; `releases the reservation when the provider
   call fails` covers the error path.
4. Gate: Node 24.20.0, `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm vitest run
   --maxWorkers=2` → exit 0, 95 files, **1105 tests** (1094 before this item).

## Review round 1 — GPT lane, on commit `61fbf96`

Verdict FAIL, 4 blocking and 2 notes. All four changed code.

| # | Finding | Ruling |
|---|---|---|
| 1 | `estimatedCostUsd` is not an upper bound: four characters per token understated a measured request by 3.5x, and tools and the response schema were not counted at all | **actionable** — everything sent is now counted, at one token per character, and the claim of an upper bound is withdrawn rather than restated. The residual is stated above |
| 2 | One hold covered the whole call, but the retry loop makes up to `maxAttempts` provider invocations and a failed attempt records no usage — so retries 2..n were unpriced | **actionable** — one hold per invocation; the first is taken before any work starts, the rest inside the loop. Observed by a test that scripts two failures and a success and watches what is admissible from inside each |
| 3 | Reservations were a running sum, and adding then subtracting the same doubles does not return to zero: 0.18 + 0.21 + 0.41 released in turn leaves 1.67e-16, which refuses the run forever | **actionable** — outstanding holds are a set and the total is summed from what is still held, which is exact by construction. The set is never larger than the provider's concurrency |
| 4 | The new rule refuses a call that fits, because the estimate overstates, and reports it as "exhausted" at a spend of $0 | **actionable in part** — the refusal stays, because a budget control fails closed and the estimate is now deliberately pessimistic; but the two conditions are separate errors with separate messages, and the insufficient one carries the estimate that caused it. `isBudgetError` matches both |
| 5 | The committed tests assert concurrency by construction rather than by overlapping calls | **note** — the reviewer's own harness ran genuinely overlapping `complete` promises and observed the second refused, which is the evidence; the per-invocation test added for finding 2 observes admissibility from inside a live provider call |
| 6 | Pre-existing behaviour and the ledger's numbers reproduce | confirmed, including that the `BudgetTracker per-run limits` block hashes identically before and after |

Finding 4's second half is worth keeping in view: with `maxRunUsd = 0.50` and the ceiling's prices,
a pessimistic estimate of a large worker call is about $0.07, so the rule has ample room. It would
bite on a run whose budget is set near the cost of one call, and the operator then sees "run USD
budget cannot cover the next call" with the estimate in the error — which is the true statement.

## Not verified here

No live run. A run whose budget now binds still reports no reason for stopping — that is R0's
acceptance check 2 and R3's repair — so a live check made now would observe the same silence three
runs already observed, at the price of more spend. It is deferred to R5, which has to make a paid
run anyway, and R5 carries this sentence as an obligation: *R5 must show a run refused for budget,
and the reason it gives.*
