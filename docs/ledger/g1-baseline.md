# G1 baseline — recorded at P1 entry, 2026-09-13

Required by `docs/PLAN.md` §1: the G1 exit criterion compares against a baseline recorded **before any
P1 item lands**. Nothing in P1 had landed when these numbers were taken.

Source: `~/.polish/polish.db`, opened read-only, at HOST `4c5bb63`. Six runs, 6,964 events. Queries
sum `payload.usage.inputTokens + outputTokens` over `type = 'model.call'` events, which is the same
method finding 29 used; the totals reproduce it exactly.

## Totals

| Metric | Value |
|---|---|
| `model.call` events | 324 |
| Total tokens | 1,060,632 |
| Calls with `costUsd: null` | **96 of 324** |

## By role

| Role | Tokens | Share |
|---|---|---|
| `reviewer` | 834,635 | **78.7%** |
| `worker` | 182,900 | 17.2% |
| `judge` | 19,519 | 1.8% |
| `planner` | 13,038 | 1.2% |
| `scope_guardian` | 10,540 | 1.0% |

Council total (`judge` + `planner` + `scope_guardian`) is 43,097, which is 4.1% and is exactly the
spend carried on `taskId: null` — the omission finding 30 describes and P1.9 repairs.

## Reviewer spend by axis

| Purpose | Tokens | Share of reviewer | Share of all |
|---|---|---|---|
| `review_adversarial` | 683,511 | 81.9% | **64.4%** |
| `review_regression` | 114,595 | 13.7% | 10.8% |
| `review_correctness` | 36,529 | 4.4% | 3.4% |

## Runs and tasks

| Metric | Value |
|---|---|
| Runs | 6 — `DONE` 2, `NEEDS_HUMAN` 3, `PAUSED` in `INTERPRETING_MISSION` 1 |
| Tasks created | 8 |
| Tasks reaching `INTEGRATED` | **2** |
| Tasks with any recorded spend | **2**, the same two |
| Per-task tokens | 115,475 and 902,060 — a **7.8×** spread |

## Review rounds

Six distinct `(run, checkpointHash, roundIndex)` rounds exist, across the two runs that got that far.
Every one of the six ran **all three axes to completion**.

| Run | Checkpoint | Round | Executions | Completed |
|---|---|---|---|---|
| `run_01m1my3p…` | `c011b6e8` | 1 | 2,402 | 3 |
| `run_01m1my3p…` | `c011b6e8` | 2 | 25 | 3 |
| `run_01m1my3p…` | `c011b6e8` | 3 | 5 | 3 |
| `run_01m1p013…` | `b35fe739` | 1 | 34 | 3 |
| `run_01m1p013…` | `b35fe739` | 2 | 56 | 3 |
| `run_01m1p013…` | `b35fe739` | 3 | 78 | 3 |

Execution counts per axis, all rounds: `correctness` 2,393 incomplete / 6 complete; `adversarial` 144
/ 6; `regression` 45 / 6. The incomplete rows are the 429 storm finding 37 describes and bounded.

**Baseline for a per-round metric:** 834,635 reviewer tokens over 6 rounds, mean 139,106 per round.

## Two consequences

### 1. P1.1's ceiling is measurable, and it is the whole 64.4%

All eighteen completed executions returned zero findings. Under P1.1's rule — skip `adversarial` when
`correctness` and `regression` both returned nothing — `adversarial` would have been skipped in **all
six rounds**, removing 683,511 of 1,060,632 tokens.

**That 64.4% is an upper bound, not a projection.** The historical zeros were not reviewer silence,
they were finding 41: the request asked for a JSON object while the parser demanded an array, so
semantically valid lone-object findings were discarded. That is fixed. Reviewers now return findings,
so the skip will fire less often than it would have historically. The honest claim is that the
mechanism is sound and its ceiling is 64.4%; its realised rate is unknown until measured on the
current tree.

### 2. The G1 exit criterion as written cannot be evaluated

`docs/PLAN.md` §1 measures **median total tokens per completed replay-set task**, and P2.2 sets a floor
of **5 replayable entries of which 2 reached `DONE`**, below which every dependent gate reports
`inconclusive`.

The corpus has **2** such tasks. The floor fails by construction, so the criterion is `inconclusive`
before P1 begins. Its median is also uninformative at n=2: 115,475 and 902,060 differ by 7.8×, which
is the same caution finding 29 recorded.

This is not a defect in the guards — they did exactly what both reviewers designed them to do, which
is refuse to report a percentage over a corpus too small to carry one. It is a defect in the choice of
denominator: completed tasks are the scarcest object in the store, and the change P1 actually makes is
a **call not issued**, which does not need a completed task to be observed.

Recorded here rather than resolved unilaterally, because §1's criterion was accepted by both reviewers
and changing it is a plan change, not plan execution.
