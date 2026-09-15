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

The estimate is `ModelBroker.estimatedCostUsd`: the parts of the request whose size varies —
messages, tools and response schema — counted at **one token per character**, plus the output
allowance
(`maxTokens`, else the catalogue's `maxOutputTokens`, else 8192), priced at the catalogue's
advertised rates. When either price is unknown the estimate is 0 — such a call cannot raise
`runUsd` either, and that gap is `unknownCostCalls`, which is R6's.

One token per character over-counts ordinary prose about fourfold and is deliberately pessimistic,
but it is **not a proven upper bound**: dense non-Latin prose has been measured at 1.15 characters
per token, and the fixed parts of the payload — model id, reasoning, response format, temperature —
are not counted at all. What this item guarantees is that N calls in flight are not all admitted
against the same figure, not that any single estimate is never exceeded.

Size, measured rather than guessed: of the 992 `model_request` artifacts in the store the largest
is 39,260 characters with `maxTokens` 25,457, which at the configured 0.30/1.20 ceiling estimates
$0.0423 — against an actual recorded cost for that call of $0.0031. Eleven such holds fit inside
`maxRunUsd = 0.50` and the twelfth is refused. Eight concurrent lanes plus accumulated retry holds
can reach that, so the rule is not unreachable in practice; when it fires the operator is told
"run USD budget cannot cover the next call" with the estimate that caused it.

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
   --maxWorkers=2` → exit 0, 95 files, **1113 tests** (1094 before this item).

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

## Review round 2 — GPT lane, on commit `a8075d4`

Verdict FAIL, 2 blocking and 3 notes.

| # | Finding | Ruling |
|---|---|---|
| 1 | A budget refusal from the retry admission arrives after `model.call_started` and threw without a terminal `model.call` — a regression, since admission used to happen before the call was started | **actionable** — the refusal now records the terminal event the way every other fatal error does, and a test asserts one `model.call_started` and one failed `model.call` |
| 2 | "Exact by construction" is only true of subtraction: `0.1 + 0.2` is `0.30000000000000004`, so a $0.10 and a $0.20 hold did not fit a $0.30 limit, and the committed test used binary-exact `0.125`, which hides it | **actionable** — a relative slack of 1e-9 on the "one more call" comparison, with the decimal case as a test. The slack is far below any quoted price and far above the error of summing a handful of terms |
| 3 | The "$0.07 for a large worker call" figure was never measured; the real maximum in the store is $0.0423, and "everything on the wire" overstates what is counted | **actionable on the text** — replaced with the measurement and its query, above |
| 4 | Released hold sets were never removed from the map, so a long-lived daemon accumulates one empty set per run | **actionable** — the key is deleted when its last hold is released |
| 5 | `reserves nothing when the estimate is unusable` passes while four zero-dollar holds are retained; several paths have no test | **note** — the assertion it makes is still the right one, and the retained holds are zero. The untested paths are named in the reviewer's output and are the reason this record says what it does not cover |

Round 1's finding 1 is closed narrowly and the residual is now stated accurately: the reviewer's
own measurement of 1.15 characters per token came from repeated Japanese prose, not from JSON, and
the text said JSON.

## Review round 3 — GPT lane, on commit `ac4e256`. The line ceiling is breached.

Verdict FAIL, 3 blocking. Round 2's two findings were confirmed closed by reproducing each failure
against `a8075d4` and showing it gone at `ac4e256`.

| # | Finding | Ruling |
|---|---|---|
| 1 | The slack was relative to the limit, so a large limit bought a large overspend: at $1e9, holds of $999,999,999 and $2 were both admitted — $1 over — and the next admission then said "exhausted", so the two rules disagreed at the boundary | **actionable** — the slack is a billionth of a dollar, floored, plus a term proportional to the representation error of the limit itself. A billionth is three orders below the smallest cost this store has recorded ($4.556e-06) |
| 2 | A release invoked twice, after its set had emptied and been deleted, deleted whatever set had replaced it — erasing a live hold's accounting | **actionable** — the release runs once, and deletes the key only when the map still holds the same set it belongs to. Both guards have a test |
| 3 | The item exceeds the plan's 300-line ceiling | **upheld** — see below |

`git diff --numstat 85911d8 -- src` reports **366 insertions**: 147 production (`broker.ts` 66,
`quota.ts` 81) and 219 tests. The ceiling is breached either way. *(Round 3 said "348, of which
151 production"; round 4 caught that 151 was churn, not insertions, and round 5 added 18 more.)*

**R0a stops here.** `docs/RECOVERY.md` §4 rule 4 says a fourth round is not forbidden but is
*recorded as a signal*, and the item stops rather than being pushed. This is that record. The two
defects above were repaired rather than deferred, because both are money-safety holes of three
lines each and shipping a known one is worse than the ceiling.

## Review round 4 — narrow confirmation, GPT lane, on commit `569d31e`

Scoped to the two repairs. Both round-3 failures were reproduced at `ac4e256` and shown gone at
`569d31e`. The release repair was additionally exercised by 20,000 randomised admit/release
operations across three runs, with accounting preserved and no keys left behind.

The slack, however, failed again in both directions — a decimal-exact total of 256 holds refused at
a $25.6M limit, and $5e-10 of overspend admitted at a limit of $1e-12 — and in both cases the
admission rule and the exhaustion rule then disagreed about the same total.

**Both directions were the same mistake: a slack.** Every slack is wrong somewhere, because it
answers a question about decimal money with a tolerance on binary doubles. The replacement does not
tolerate error, it removes it: both rules compare **whole nano-dollars**, `Math.round(usd * 1e9)`,
so they read the same integer and cannot disagree. Exact for limits up to about $9,007,199, where
the safe integer range ends; the largest budget this tool has been given is $0.50, and the smallest
cost the store has recorded is $4.556e-06, three orders coarser than a nano-dollar.

The boundary table replaces both slack tests, one case per boundary: a decimal total equal to the
limit is admitted, a hair over it is refused, a large limit does not buy a proportional overspend,
its exact remainder is still admitted, and a limit of zero admits nothing. The earlier tests used
0.125 and then a single large limit, which is how each slack passed its own test and failed the
other's.

That is the last change to this item. The next boundary an adversarial reader constructs — a limit
of $1e-12, a budget of $1.8e308 — is not a configuration `polish run --budget-usd` or `polish.toml`
can produce, and by rule 5 a new item comes from a failure observed in a real run.

What the item does **not** cover, named so the gap is visible rather than implied: cancellation
during backoff, `BudgetTracker.restore` interleaved with live holds, lazily-resolved run limits at
the moment of admission, and the estimate's own arithmetic. None has a test. They are the natural
content of a successor item, if a real run ever produces a failure in one of them — and by rule 5,
not before.

## Not verified here

No live run. A run whose budget now binds still reports no reason for stopping — that is R0's
acceptance check 2 and R3's repair — so a live check made now would observe the same silence three
runs already observed, at the price of more spend. It is deferred to R5, which has to make a paid
run anyway, and R5 carries this sentence as an obligation: *R5 must show a run refused for budget,
and the reason it gives.*
