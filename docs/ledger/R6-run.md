# R6 — the economics, re-measured

**Plan:** `docs/RECOVERY.md` §3 R6. **Date:** 2026-09-15, after `run_01m2hfb2mnmvd10384k320`.

The query is §1.3's, unchanged, over the whole store:

```sql
select json_extract(json,'$.payload.role') role,
       sum(coalesce(json_extract(json,'$.payload.usage.inputTokens'),0)
         + coalesce(json_extract(json,'$.payload.usage.outputTokens'),0)) tokens,
       round(sum(coalesce(json_extract(json,'$.payload.usage.costUsd'),0)),6) usd
  from events where type='model.call' group by role;
```

| role | tokens | share | USD | share |
|---|---:|---:|---:|---:|
| worker | 2,075,704 | **65.6%** | $0.103370 | **96.4%** |
| reviewer | 834,635 | 26.4% | $0.000000 | 0.0% |
| judge | 104,332 | 3.3% | $0.000000 | 0.0% |
| planner | 83,146 | 2.6% | $0.000000 | 0.0% |
| scope_guardian | 64,402 | 2.0% | $0.000000 | 0.0% |
| probe | 2,750 | 0.1% | $0.003843 | 3.6% |
| **total** | **3,164,969** | | **$0.107213** | |

## What this settles

`docs/PLAN.md` builds P1.1, P1.2, P3.1, P3.2 and its §1 cost gate on "review = 78.7% of spend,
adversarial = 64.4%". `docs/RECOVERY.md` §1.3 had already shown that number to be a 2026-09-04
snapshot whose 93% came from one fixture run. The measurement after a real paid run is not a
correction of a few points; it is the opposite ordering:

- **The reviewer is 26.4% of tokens and 0% of dollars.** Every reviewer call this tool has ever
  made was free. Not "cheap": zero, because reviewers can only be routed to probed models and the
  probe shortlist is the cheapest eligible eight, which are the free ones (`docs/ledger/R0-run.md`).
- **The worker is 65.6% of tokens and 96.4% of dollars.** And it grew: 1,535,689 tokens at §1.3's
  reading, 2,075,704 now — **540,015 of them, 35% of everything the worker had ever spent, in one
  run that produced nothing** (`docs/ledger/R5-run.md`).
- **The probe is 0.1% of tokens and 3.6% of dollars**, all of it one `openrouter/fusion` capability
  probe that billed $0.003825 for 745 input tokens before R0 stopped it. A rounding error in tokens
  and the second-largest line in dollars, which is what a variable-price route looks like in a table
  that assumes tokens are the unit of cost.

## Ruling on the suspended programme

`docs/PLAN.md`'s §2 banner suspends P1.1, P1.2, P3.1, P3.2 and the §1 cost gate "pending the
re-measurement in `docs/RECOVERY.md` R6". This is that re-measurement, and it does not release
them. **Each of those items reduces the cost of reviewing, and reviewing costs nothing.** They
would optimise 0% of spend while the worker, at 96.4%, has no cost item at all.

What the measurement argues for instead is exactly the defect R5 found: one task, 148 calls,
492,632 tokens, no candidate. That is where the money is, and it is now an item — R7.

Two cautions the number carries with it, in the spirit of §4 rule 1:

- **The denominator is small.** $0.107213 total, over a store whose first eleven days were entirely
  free. The share is a fact about this store, not a law; it should be re-read after the first run
  that reaches `REVIEWING` on paid reviewers, because that is the reading `docs/PLAN.md`'s claim
  was really about.
- **$0.107213 is what was recorded, not what was charged.** 375 of 1,256 `model.call` events carry
  `costUsd: null` — every Gemini call — and before R0 two of the five capability probes per model
  emitted no event at all. The unpriced calls are counted in tokens and are invisible in dollars.
