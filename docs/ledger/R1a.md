# R1a — The request-rate window exists and is switched off

**Plan:** `docs/RECOVERY.md` §3 R1 clause 1. **Status:** contracted, not implemented.
**Reviewer lane:** GPT, one lane.

## Defect (normative)

`QuotaTracker` holds a per-provider requests-per-minute window: the field, the sliding
`requestTimes` array and the wait computation all exist (`src/broker/quota.ts:29-60`). It is
constructed with `rpm: null` (`src/daemon/composition.ts:207`) and no configuration can set it, so
the window never closes and the provider is asked as fast as the lanes allow.

## Why it is not the item the plan's regression number belongs to

`docs/RECOVERY.md` §1.2 attributes 2,465 unreached executions to
`limit_source: openrouter_free_tier_per_minute` with `X-RateLimit-Limit: 20`. On the funded key the
observed limit is `openrouter_free_tier_daily`, 1000 per day, with `X-RateLimit-Remaining: 0`
(`docs/ledger/R0-run.md`). **A request-rate window cannot pace an allowance that is already spent
for the day.** It remains worth having — the per-minute variant is still reachable, and pacing is
cheaper than being refused — but it is not what fixes what was observed, which is why it is its own
item and not part of R1.

## Required end state

1. A configuration field sets the per-provider requests-per-minute limit, defaulting to no limit so
   that today's behaviour is the default.
2. `buildProductionDeps` passes it instead of `null`.
3. A provider that advertises its own limit in a response header is not overridden by a larger
   configured value.

## Acceptance checks

1. With `rpm` set to n, the (n+1)-th request inside one minute waits rather than being sent, and is
   sent once the window slides. Measured on a fake clock, not on wall time.
2. With `rpm` unset, request timing is byte-identical to today's.
3. The wait is per provider: a second provider is unaffected.
4. Gate green at Node 24.
