# R0 — run record

Contract: `docs/ledger/R0.md`. Base: HOST `e87dd26`. Date: 2026-09-15.
Coordinator/implementer: Claude Opus 5. Reviewer lane: GPT (`gpt-5.6-sol-high`), one lane.

Every number below carries the command that produces it. Three live runs against
`~/screen-audit-toolkit` were used; their total spend is $0.0187.

## The change

`~/.polish/polish.toml` (operator config, outside the repo):

```toml
[routing]
costEligibility = "ceiling"
maxInputCostPerM = 0.30
maxOutputCostPerM = 1.20

[budget]
maxRunUsd = 0.50
```

Ceiling justification, from the catalogue of this date and from the store, not from memory:

```
curl -s https://openrouter.ai/api/v1/models      # 150 paid routes at or below 0.30/1.20
sqlite3 "file:$HOME/.polish/polish.db?mode=ro" \
  "select run_id, sum(coalesce(json_extract(json,'\$.payload.usage.inputTokens'),0)) inTok,
          sum(coalesce(json_extract(json,'\$.payload.usage.outputTokens'),0)) outTok
     from events where type='model.call' group by run_id order by inTok desc limit 1;"
# run_01m2fms2rgx22qjckxrz66 | 707,466 | 73,094
```

At the ceiling, a run of that size costs $0.30. `maxRunUsd = 0.50` sits above it and divides the
$5 on the key into ten runs.

## R0 was not "0 lines of code". The first run falsified that in 45 seconds.

`docs/RECOVERY.md` R0 states "кода не требуется". Run 1 (`run_01m2h2vmy5qj0648tcn2fn`,
`--budget-usd 0.002`) spent $0.003842688, and **99.5% of it went to a single capability probe**:

```
sqlite3 "file:$HOME/.polish/polish.db?mode=ro" \
  "select json_extract(json,'\$.payload.purpose'), json_extract(json,'\$.payload.model.model'),
          json_extract(json,'\$.payload.usage.costUsd'), json_extract(json,'\$.payload.usage.inputTokens')
     from events where run_id='run_01m2h2vmy5qj0648tcn2fn'
      and json_extract(json,'\$.payload.role')='probe';"
capability_probe_strict_review | openrouter/fusion | 0.003825 | 745
```

### Finding R0-1 — the ceiling admitted a route that has no price, and it billed 17x the ceiling

`openrouter/auto-beta` and `openrouter/fusion` advertise `pricing.prompt = "-1"`: OpenRouter's
sentinel for a route whose price depends on where it routes.

```
curl -s https://openrouter.ai/api/v1/models | node -e '…' | grep -E "auto-beta|fusion"
openrouter/auto-beta {"prompt":"-1","completion":"-1"}
openrouter/fusion    {"prompt":"-1","completion":"-1"}
```

`OpenAICompatProvider.toModelInfo` multiplied that by 1e6 and kept it, because `-1000000` is
finite. `isCostEligible`'s ceiling branch then asked `-1000000 <= 0.30` and said yes. The
shortlist (`buildDiscoveryShortlist`) sorts by advertised cost ascending, so these two routes sort
**ahead of free models** and are probed first. `free_only` had excluded them by asking for exactly
0, so this exposure is what R0's config flip opened.

The billed rate was $0.003825 for 745 input and 4 output tokens — about $5.13 per 1M input,
**17x the 0.30 ceiling that admitted it**.

Fix: a price the provider does not state is `null`, not a number (`src/providers/openaiCompat.ts`,
`advertisedPricePerM`), and no ceiling accepts a value that is not a stated price
(`src/broker/costEligibility.ts`, `isStatedPrice`). The second is not redundant with the first: the
adapter stops reporting a false price, the invariant stops accepting one whichever adapter asks.

### Finding R0-2 — two of the five probes per model were spend no budget could see

`probeModelCapabilities` called `adapter.complete` directly for the tools and json probes
(`capabilityProbe.ts:94`, `:164`) while the three strict-schema probes went through the injected
`strictComplete`, which production wires to `ModelBroker.complete`. Only the brokered path runs
`BudgetTracker.assertWithin`, records spend, and emits `model.call`. So in run 1:

```
sqlite3 … "select json_extract(json,'\$.payload.purpose'), count(*) from events
           where run_id='run_01m2h2vmy5qj0648tcn2fn' and type='model.call'
             and json_extract(json,'\$.payload.role')='probe' group by 1;"
capability_probe_strict_progress|1
capability_probe_strict_review  |2
capability_probe_strict_score   |1
```

Four events for four brokered probes; the tools and json probes that the code also made for those
same models produced no event, no budget charge, and no row for §1.3's economics query. Harmless
while every probed model was free. Not harmless once a ceiling admits paid ones — and run 1 probed
`openrouter/fusion`, so two of its calls billed at fusion's rate and are not in any total above.

Fix: one `ctx.complete` for all five probes, defaulting to the adapter only when the caller injects
nothing, with `maxAttempts: 1` on the two that previously had no retry policy (they now inherit the
broker's four-attempt default otherwise).

## Acceptance check 1 — a paid model is actually selected: PASS

Run 2 (`run_01m2h3ck0v06t7596n0fh7`, `--budget-usd 0.05`), after the fixes:

```
sqlite3 … "select json_extract(json,'\$.payload.role') role,
                  json_extract(json,'\$.payload.model.model') m, count(*) n,
                  round(sum(coalesce(json_extract(json,'\$.payload.usage.costUsd'),0)),6) usd
             from events where run_id='run_01m2h3ck0v06t7596n0fh7' and type='model.call'
            group by role,m order by usd desc limit 4;"
worker | z-ai/glm-4.6v            | 13 | 0.010820
worker | mistralai/codestral-2508 |  3 | 0.005993
```

Both advertise 0.30 input / 0.90 output per 1M — inside the ceiling, and non-zero, so a paid model
was selected and charged. Both findings above are also closed by this run's evidence: no
`auto-beta`/`fusion` probe appears at all, and `capability_probe_tools` / `capability_probe_json`
now appear as `model.call` events (36 probe events against 4 in run 1).

## Acceptance check 2 — a run that hits `maxRunUsd` is rejected with a named reason: NOT MET

Not met, and not force-fixed here, exactly as the contract said it might go. What was observed:

- Run 2 reached `FAILED` at $0.01478445 under a $0.05 limit — the budget never bound because the
  run died of something else first.
- `polish status run_01m2h3ck0v06t7596n0fh7 --json` → `"terminal": null`. So does run 1, and so
  does D1 (`run_01m2gy5yg30631j247sn13`). Three FAILED runs, three absent reasons. This is
  finding 55 and belongs to **R3**.
- Run 3 (`run_01m2h3hpe2f6f4ra1ywcg7`, `--budget-usd 0.003`) produced a **second reasonless shape**:
  it did not fail, it went to `PLANNING / PAUSED` and sat there. The pause is
  `run.control_changed` with `actor: {"kind":"user"}` — no user asked for it. `engine.ts:230`
  pauses any run whose driver throws in a council phase, and `engine.ts:235` rethrows the error
  without recording it. The daemon is spawned with `stdio: "ignore"` (`src/cli/client.ts:28`), so
  that error reaches no log either. An operator sees a run they appear to have paused themselves,
  with no reason available anywhere. **New input for R3**, not repaired here.

## What R0 did not fix, and where it goes

**Free routes remain cost-eligible and still take most of the routing.** A ceiling permits paid
models; it does not prefer them. Run 2's last worker attempts went to
`nvidia/nemotron-3.5-lightning:free` and `dots-studio/dots-3-note-preview:free`, and the run
recorded 34 `model.retry_scheduled` events. §1.2's cause is therefore still live, which is what
**R1** is for.

**The free-tier limit is no longer the one §1.2 describes.** The 429 body captured in run 3 reads:

```
"Rate limit exceeded: free-models-per-day-high-balance.",
"X-RateLimit-Limit":"1000", "X-RateLimit-Remaining":"0",
"X-RateLimit-Reset":"1789430400000"   # 2026-09-15T00:00:00Z
```

That is a **per-day account** cap of 1000, already exhausted, not the per-minute cap of 20 that
`docs/RECOVERY.md` §1.2 names. A request-rate window paces a per-minute cap; it cannot pace an
exhausted daily one. R1 must handle the scope *and the period*, or it will pace a lane that has no
requests left to give. Funding the key raised the free allowance from 20/min to 1000/day; it did
not remove it.

**Reviewers cannot reach a paid model at all.** `selectReviewProviders` requires
`requireStrictReviewSchema` (`composition.ts:460`), which only a probe can set. Probes go to
`buildDiscoveryShortlist`, which sorts by advertised cost ascending and takes
`maxProbesPerProvider` = 8 — so the probed set is the eight cheapest eligible models, and free
routes cost 0. Run 2's probe list is nine models, every one of them `:free`. Under any ceiling that
admits free routes, **no paid model is ever probed, so no paid model is ever a reviewer.** R0 does
not touch it; it is named here because R5's acceptance ("fewer than 10% did not arrive") cannot be
met while reviewers are confined to a lane whose daily quota is exhausted.

## Gates

Node 24.20.0. `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm vitest run --maxWorkers=2`
→ exit 0, 95 files, 1080 tests (baseline at `e87dd26`: 95 files, 1077 tests). Three added:
the ceiling/sentinel case, the OpenRouter `-1` listing case, and the probe-seam case.
