# R0a — Admission is not a reservation

**Origin:** `docs/ledger/R0-run.md`, review round 3 finding 4. Created under `docs/RECOVERY.md` §4
rule 5: a new item comes from a failure observed in a real run, and from §3's ceiling rule, which
sent R0's remainder here rather than into a fourth fix round.
**Base:** `85911d8`. **Reviewer lane:** GPT (`gpt-5.6-sol-high`), one lane.

## Defect (normative)

`BudgetTracker.assertWithin` reads the spend recorded so far (`src/broker/quota.ts:145-157`).
`ModelBroker.complete` calls it at `broker.ts:70` and records the call's cost at `broker.ts:118`,
after the provider returns. Everything admitted in between was admitted against the same figure.

Reproduced by the reviewer: ten concurrent calls of $0.49 all pass a $0.50 limit, and the run ends
at $4.90 — 9.8x its budget. `lanes["llm.default"]` is 8, so eight is the ordinary concurrency of
one provider, not a contrived number.

This is the control R0 existed to provide. A cap that a run exceeds by an order of magnitude is
not a cap.

## Required end state

1. The decision to admit a call and the reservation of what it may cost are **one indivisible
   step**. Asserting and then reserving is the same defect with more code: two callers reach the
   assertion before either reserves.
2. A call's reservation is released only after its actual cost is recorded, so no window exists in
   which neither the reservation nor the record counts against the run.
3. The reservation is an upper bound derived from what is known before the call: the model's
   advertised prices, the size of the request, and the output allowance that will be sent. When no
   price is known the reservation is 0 — such a call cannot raise `runUsd` either, and that gap is
   `unknownCostCalls`, which is R6's subject and not this item's.

## Acceptance checks

1. **The overshoot is bounded.** N calls admitted concurrently against a limit that only one of
   them fits do not all proceed. Stated as the reviewer stated it: with a $0.50 limit and calls
   estimated at $0.49, the second concurrent call is refused, and `isBudgetError` is true of the
   refusal.
2. **Sequential behaviour is unchanged where it was already right.** A run under its limit still
   runs; the call that crosses the line is still the one refused, not the one before it.
3. **A released reservation does not leak.** After a call fails, and after a call is cancelled, the
   run's admissible amount returns to what it was, so a failed call does not consume budget
   forever.
4. Gate green at Node 24: `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm vitest run
   --maxWorkers=2`.

## Non-goals

- `unknownCostCalls` — calls whose provider reports no cost stay outside USD accounting. R6.
- Making `--budget-usd` clamp rather than replace the configured cap. Recorded as a trade-off in
  `docs/ledger/R0-run.md`; nothing observed argues for taking the override away.
- Token budgets (`maxRunTokens`, `maxTaskTokens`). They have the same shape of defect, and this
  item does not touch them: they bound a quantity the run cannot be charged for, so the harm is
  not the same and the evidence for changing them does not exist.
- Anything in R1's subject: which models are chosen, and how a 429 is attributed.
