# R1c — A free-tier allowance is not the whole account

**Origin:** `docs/ledger/R1-run.md`, review round 2, findings 1 and 2.
**Status:** contracted, not implemented. **Base when started:** the then-current HOST.
**Reviewer lane:** GPT, one lane.

## Defect (normative)

R1 named the scope of `openrouter_free_tier_daily` **account**, and treats it as "no other model of
this provider can answer". The provider's own label says otherwise: the allowance belongs to the
**free tier**, and a paid route on the same provider is unaffected by it. Two consequences,
both demonstrated in review:

1. A council chain of `openrouter:free`, `openrouter:paid`, `gemini:backup` calls the first and the
   third. The paid OpenRouter model, which would have answered, is skipped.
2. `ModelBroker` cools down the whole provider (`quota.coolDown(adapter.id, …)`) on the same
   signal, so paid calls wait behind a free allowance.

And separately, one layer up:

3. Broker-local retries are suppressed, but a worker's account-scoped 429 still returns the task to
   `READY`, and `handleZeroSurvivors` re-attempts while `attempts < retry.maxAttempts` — five by
   default, times the candidate count. The work is rescheduled even though nothing about it can
   succeed until the allowance resets.

## Required end state

1. The scope value says what the provider said: a free-tier allowance is `free_tier`, not
   `account`. `unknown` and `model` keep their meanings.
2. A site that skips on a `free_tier` limit skips only routes it **knows** are free — both
   advertised prices exactly 0, per `isExplicitlyFree`. A route whose price it does not know is
   tried: one wasted call is cheaper than a blocked paid lane.
3. The provider cooldown for a `free_tier` limit does not delay routes that are not free.
4. A `free_tier` limit does not consume task attempts. Re-attempting work that cannot succeed until
   the allowance resets is the same defect as rotating models, one layer up.

## Acceptance checks

1. A council chain of a free route, a paid route and a route on another provider, where the free
   one answers with a `free_tier` 429: **all three** are called, in order, and the paid one answers.
2. A chain where the second route's price is unknown: it is called.
3. A paid call issued immediately after a `free_tier` 429 on the same provider is not delayed.
4. A task whose candidates all fail with a `free_tier` 429 does not consume `retry.maxAttempts`
   attempts; it stops, and the reason names the allowance.
5. The mixed-cause cases round 2's note named: one axis with a `free_tier` failure **and** a schema
   failure exhausts as a schema failure; two exhausted axes with different causes report both.
6. Gate green at Node 24.

## Non-goals

- Preferring paid routes generally. This item only stops a free allowance from being mistaken for
  a fact about a paid route.
- `rpm` pacing (**R1a**) and the observation replay (**R1b**).
