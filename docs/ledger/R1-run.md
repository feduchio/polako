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
--maxWorkers=2` → exit 0, 95 files, **1127 tests** (1113 before this item). 296 src insertions,
under the plan's 300.

## What this item does not do

- `rpm` pacing — **R1a**. Note that it would not have prevented what was observed: the limit in
  play is `openrouter_free_tier_daily` with `X-RateLimit-Remaining: 0`, and no request-rate window
  paces an allowance that is already spent for the day.
- The 76 probe observations already in the event log, which `restoreCatalog` replays into routing
  statistics on daemon start — **R1b**. This item stops new ones being written for account-scoped
  failures; it does not touch the replay.
- Preferring paid routes while the free allowance is spent. A routing preference, and no observed
  run has failed in a way that only it would fix.
