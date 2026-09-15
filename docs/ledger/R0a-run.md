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

The estimate is `ModelBroker.estimatedCostUsd`: the request's own message bytes at four characters
per token, plus the output allowance actually being sent (`maxTokens`, else the catalogue's
`maxOutputTokens`, else 8192), priced at the catalogue's advertised rates. When either price is
unknown the estimate is 0 — such a call cannot raise `runUsd` either, and that gap is
`unknownCostCalls`, which is R6's.

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
   --maxWorkers=2` → exit 0, 95 files, **1103 tests** (1094 before this item).

## Not verified here

No live run. A run whose budget now binds still reports no reason for stopping — that is R0's
acceptance check 2 and R3's repair — so a live check made now would observe the same silence three
runs already observed, at the price of more spend. It is deferred to R5, which has to make a paid
run anyway, and R5 carries this sentence as an obligation: *R5 must show a run refused for budget,
and the reason it gives.*
