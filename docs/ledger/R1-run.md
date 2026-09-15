# R1 — run record

Contract: `docs/ledger/R1.md`. Base: `f8b8c0d`. Date: 2026-09-15.
Coordinator/implementer: Claude Opus 5. Reviewer lane: GPT (`gpt-5.6-sol-high`), one lane.

## The change

One new fact travels from the provider to the four places that used to guess: `ProviderError`
carries `limitScope` for a 429, read from OpenRouter's `error.metadata.limit_source` rather than
from the message text. `unknown` is a distinct value from `model` even though both are handled the
same way, so a later reader can tell a provider's statement from our assumption.

Then, at each site that was treating an account's exhausted allowance as a fact about a model:

| Site | Before | After |
|---|---|---|
| `reviewAxisWithFallback` | any failure adds the model to `rateLimited` and the loop tries the next reviewer | an account-scoped 429 records the attempt and returns `waiting`; the model stays usable |
| `excludedReviewModels` | a recorded 429 makes the model sticky-excluded for the checkpoint | an account-scoped one does not. The scope survives in the recorded error string, written and read by one pair of functions so the two spellings cannot drift |
| `createResilientCouncilClient` | falls back to the next model in the chain on any operational failure | an account-scoped 429 skips the rest of **that provider's** models and goes on to the next provider |
| `ModelBroker.recordRoutingStats` | every failure lowers the model's routing score | an account-scoped 429 does not |

## Acceptance

Numbers are from the tests, each of which fails against the previous behaviour.

1. **One call per axis, not one per model.** Five reviewers, every call answered with an
   account-scoped 429: `provider.calls` has length 1 and the store holds one review execution.
   Against the plan's regression — 2,465 of 2,600 executions that never reached a model — the old
   path made five calls for the first axis alone and marked all five models dead.
2. **Model-scoped is unchanged.** The same five reviewers with a model-scoped 429: five calls, and
   all five excluded.
3. **Across ticks.** A recorded account-scoped failure does not exclude its model; a plain 429
   recorded beside it still does. Both in one test, so the assertion distinguishes the two rather
   than counting them.
4. **Council.** A chain of two OpenRouter models and one Gemini model, OpenRouter answering with an
   account-scoped 429: the calls are `openrouter:first` then `gemini:flash`. With a model-scoped
   429 all three are called. The first is the shape that actually completed the judge role in
   `run_01m2h3hpe2f6f4ra1ywcg7`.
5. **Worker.** One case per scope: `account` leaves `stats.failures` at 0 and writes no
   `model.observation.recorded`; `model` and `unknown` leave it at 1 and write one. The `model.call`
   event is written in all three — what happened is not in question, only whose fault it was.
6. **Parsing.** One case per `limit_source` value, plus the absent case, plus a non-429 error whose
   `limitScope` must be null.

Gate: Node 24.20.0, `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm vitest run
--maxWorkers=2` → exit 0, 95 files, **1131 tests** (1113 before this item).

## Review round 1 — GPT lane, on commit `fdc5611`

Verdict FAIL, 2 blocking and 1 note. All three changed code.

| # | Finding | Ruling |
|---|---|---|
| 1 | Production still made **four** provider calls per execution for an account-scoped 429, because `ProviderError.retryable` is true for every rate limit and the broker's retry loop does not read the scope. The acceptance test injected a `ScriptedProvider` directly and never went through `ModelBroker`, which is how it missed this | **actionable** — an account-scoped rate limit is not retryable: its backoff is milliseconds and the allowance resets at midnight UTC. The new test goes through the broker and counts provider calls: 1 for account-scoped, 3 for model-scoped |
| 2 | After `maxAxisAttemptsPerRound` tagged failures the run does terminate — but with `providers_unavailable` and the summary "non-retryable provider errors", which is the opposite of what happened | **actionable** — the bound stays, because a run that waits forever on an allowance resetting at midnight is a run nobody is told about; the summary now names the account allowance when every counted failure was account-scoped. One test per branch |
| 3 | The council's `model.fallback_selected` event named `models[index - 1]` as the model fallen back *from* — a model that the skip meant nobody called | **actionable** — the event names the model actually attempted. Asserted in the skip test |

The reviewer also confirmed, against the store: the real 429 body from
`run_01m2h3hpe2f6f4ra1ywcg7` classifies as account-scoped; the routing-statistics skip survives a
restart, because `restoreCatalog` replays `model.observation.recorded` and not `model.call`;
`exhaustedProviders` has the right lifetime; and the plan's historical breakdown reproduces exactly
— 2,600 started, 2,465 rate-limited, 108 schema, 18 completed, 6 bad-request, 3 other.

**Size.** `git diff --numstat f8b8c0d -- src` is **384 insertions**: 117 production, 267 tests. The
plan's ceiling is 300 and this is the third item in a row to pass it. The production change is well
inside it; what is not is the cost of stating each acceptance check as its own single-input case,
which is the practice `docs/BVP.md` adopted after P1.9 found eight wrong classifiers behind one
passing aggregate assertion. Recorded here once rather than argued again per item: **the ceiling as
written counts something this codebase's own verification practice makes unbounded.** If it is to
bind, it has to bind on production lines.

## What this item does not do

- `rpm` pacing — **R1a**. Note that it would not have prevented what was observed: the limit in
  play is `openrouter_free_tier_daily` with `X-RateLimit-Remaining: 0`, and no request-rate window
  paces an allowance that is already spent for the day.
- The 76 probe observations already in the event log, which `restoreCatalog` replays into routing
  statistics on daemon start — **R1b**. This item stops new ones being written for account-scoped
  failures; it does not touch the replay.
- Preferring paid routes while the free allowance is spent. A routing preference, and no observed
  run has failed in a way that only it would fix.
