# R5 — the first paid run on real code

**Plan:** `docs/RECOVERY.md` §3 R5. **Run:** `run_01m2hfb2mnmvd10384k320`, 2026-09-15 02:46 UTC.
**Target:** `~/screen-audit-toolkit`, the mission from D1's reconnaissance. **Budget:** `--budget-usd 0.25`.
**Base:** `fbb2cd4` (R0, R0a, R1, R2, R3, R4 all in).

## Acceptance: not met, and the reason is new

> *Проверка:* доля «не доехало» в `review_executions` этого прогона ниже 10%, и хотя бы одно
> исполнение возвращает находку — любую.

```
sqlite3 "file:$HOME/.polish/polish.db?mode=ro" \
  "select count(*) from review_executions where run_id='run_01m2hfb2mnmvd10384k320';"
0
```

**The run never reached `REVIEWING`.** The check is about the share of review executions that fail;
with none, there is no share to compute and the criterion is unevaluable, not passed and not
failed. The plan assumed the run would get that far. It did not, for a reason no previous run had
shown.

## What did happen, and it is not nothing

**Paid models did the work, and none of them refused.** 148 worker calls, zero failures:

```
sqlite3 … "select json_extract(json,'$.payload.model.model') m, count(*) n,
  sum(json_extract(json,'$.payload.usage.inputTokens')) inT,
  round(sum(json_extract(json,'$.payload.usage.costUsd')),5) usd
  from events where run_id='run_01m2hfb2mnmvd10384k320' and type='model.call'
  and json_extract(json,'$.payload.role')='worker' group by m;"
mistralai/codestral-2508           | 72 | 173,692 | 0.03272
z-ai/glm-4.6v                      | 35 | 178,722 | 0.05383
nvidia/nemotron-3.5-lightning:free | 23 |  53,891 | 0
dots-studio/dots-3-note-preview:free | 18 | 63,621 | 0
```

Against `docs/RECOVERY.md` §1.2's 94.8% of 2,600 executions that never reached a model: **0 of 148
worker calls failed**. The free routes answered too — their daily allowance had reset at midnight
UTC, four hours before this run. So §1.2's transport failure did not recur, on either lane.

**R3 was verified live.** The run ended `FAILED` and `polish status` shows a reason, where three
earlier runs showed `terminalReason: null`:

```
providers_unavailable | task task_01m2hfcqxmhk8cryhmys1g produced no survivor on attempt 5 of 2
candidates: 0 reached a gate and failed, 0 were refused by the provider, 2 ended otherwise
(BUDGET_EXCEEDED)
```

Every clause of that sentence is true and was measured: nothing was judged, nothing was refused by
a provider, and the cause is named. Under the previous code this run would have joined the other
three as `terminal: null`.

**R0 was verified live.** $0.086557 spent under a $0.25 limit, all of it on paid routes inside the
0.30/1.20 ceiling, with no `auto-beta`/`fusion` probe and no unmetered probe call.

## The new defect, observed rather than reasoned about

Every candidate died `BUDGET_EXCEEDED` — twelve of them, across five attempts:

```
sqlite3 … "select json_extract(json,'$.payload.candidate.state'),
  json_extract(json,'$.payload.candidate.error'), count(*) from events
  where run_id='run_01m2hfb2mnmvd10384k320' and type='candidate.state_changed' group by 1,2;"
DISCARDED | BUDGET_EXCEEDED | 12
```

That is **not** the run's USD budget. It is `AgentRunner`'s per-task token budget: 148 calls and
**492,632 tokens** were spent on **one** task without any worker producing a finished candidate.
The workers did not fail — they never stopped. One task, five attempts, two candidates each, every
one of them talking until its allowance ran out.

This is the shape §1.5 names for the *process* — "no maximum number of reviews" — appearing inside
the product, at the worker. It is the largest single fact this run produced and it belongs to a new
item, by rule 5: **R7 — a worker that cannot finish must stop, not spend.**

**The daemon also exited during or just after this run.** `~/.polish/polish.pid` points at no live
process, and `polish status` returned "RPC log timed out" before the CLI restarted it. No event
records why, because `stdio: "ignore"` is still where the daemon's own errors go — the limitation
R3 named and did not fix.

## Ruling

R5 is **not accepted**: its acceptance criterion cannot be evaluated, and the plan's §4 rule 5 says
a new item comes from a failure observed in a real run. This run observed one. R5 is re-run after
R7, against the same target and mission, and the criterion is evaluated then.

What it already paid for, at $0.086557: two of the four repairs it was supposed to test are
confirmed working on real code, §1.2's transport failure is confirmed absent on both lanes, and the
reason the run stopped is on the screen instead of being `null`.
