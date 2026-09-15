# R0 — run record

Contract: `docs/ledger/R0.md`. Base: HOST `e87dd26`. Date: 2026-09-15.
Coordinator/implementer: Claude Opus 5. Reviewer lane: GPT (`gpt-5.6-sol-high`), one lane.

Every number below carries the command that produces it. Three live runs against
`~/screen-audit-toolkit` were used; their recorded spend is $0.020655498:

```
sqlite3 "file:$HOME/.polish/polish.db?mode=ro" \
  "select round(sum(coalesce(json_extract(json,'\$.payload.usage.costUsd'),0)),9) from events
    where type='model.call' and run_id in
    ('run_01m2h2vmy5qj0648tcn2fn','run_01m2h3ck0v06t7596n0fh7','run_01m2h3hpe2f6f4ra1ywcg7');"
0.020655498      # run 1 0.003842688 + run 2 0.016812810 + run 3 0.0
```

That total is what the store recorded. It is not what the key was charged: finding R0-2 below is
precisely a path whose calls emitted no event, so run 1's true spend cannot be reconstructed.

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
curl -s https://openrouter.ai/api/v1/models > /tmp/or-models.json && node -e '
const d=JSON.parse(require("fs").readFileSync("/tmp/or-models.json","utf8")).data;
const price=(s)=>/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(String(s).trim())?Number(s)*1e6:null;
const r=d.map(m=>({i:price(m.pricing?.prompt),o:price(m.pricing?.completion)}))
         .filter(x=>x.i!==null&&x.o!==null&&x.i<=0.30&&x.o<=1.20);
console.log(r.length, r.filter(x=>x.i>0).length);'
# 172 routes at or below 0.30/1.20, of which 150 are paid. A live catalogue moves; this is the
# reading of 2026-09-15 and the command that reproduces whatever it reads today.
sqlite3 "file:$HOME/.polish/polish.db?mode=ro" \
  "select run_id, sum(coalesce(json_extract(json,'\$.payload.usage.inputTokens'),0)) inTok,
          sum(coalesce(json_extract(json,'\$.payload.usage.outputTokens'),0)) outTok
     from events where type='model.call' group by run_id order by inTok desc limit 1;"
# run_01m2fms2rgx22qjckxrz66 | 707,466 | 73,094
```

At the ceiling, a run of that size costs $0.2999526. `maxRunUsd = 0.50` sits above it. What that
guards, and what it does not, is set out under "What `maxRunUsd` actually is" below; it is not a
guarantee about the $5 on the key.

## R0 was not "0 lines of code". The first run falsified that in 45 seconds.

`docs/RECOVERY.md` R0 states "кода не требуется". Run 1 (`run_01m2h2vmy5qj0648tcn2fn`,
`--budget-usd 0.002`) spent $0.003842688, and **99.5% of it went to a single capability probe**:

```
sqlite3 "file:$HOME/.polish/polish.db?mode=ro" \
  "select json_extract(json,'\$.payload.purpose'), json_extract(json,'\$.payload.model.model'),
          json_extract(json,'\$.payload.usage.costUsd'), json_extract(json,'\$.payload.usage.inputTokens')
     from events where run_id='run_01m2h2vmy5qj0648tcn2fn' and type='model.call'
      and json_extract(json,'\$.payload.role')='probe';"
capability_probe_strict_review   | openrouter/auto-beta | 4.556e-06 |  16
capability_probe_strict_score    | openrouter/auto-beta | 8.040e-06 |  16
capability_probe_strict_progress | openrouter/auto-beta | 5.092e-06 |  16
capability_probe_strict_review   | openrouter/fusion    | 0.003825  | 745
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
now appear as `model.call` events: 18 probe `model.call` events in run 2 against 4 in run 1, for
nine probed models against two.

## Acceptance check 2 — a run that hits `maxRunUsd` is rejected with a named reason: NOT MET

**R0 is therefore not accepted.** The repair belongs to R3, but the criterion is R0's, so R0 stays
open and R3's acceptance re-runs this check. What was observed:

- Run 2 reached `FAILED` at $0.01478445 under a $0.05 limit — the budget never bound because the
  run died of something else first.
- `polish status run_01m2h3ck0v06t7596n0fh7 --json` → `"terminal": null`. So does run 1, and so
  does D1 (`run_01m2gy5yg30631j247sn13`). Three FAILED runs, three absent reasons. This is
  finding 55 and belongs to **R3**.
- Run 3 (`run_01m2h3hpe2f6f4ra1ywcg7`, `--budget-usd 0.003`) produced a **second reasonless shape**:
  it did not fail, it went to `PLANNING / PAUSED` and sat there for ten minutes until killed. Its
  recorded spend is $0, so its budget never bound and the pause has some other cause. The pause is
  `run.control_changed` carrying `actor: {"kind":"user"}`, and no `polish pause` was issued in this
  session. `engine.ts:230` pauses any run whose driver throws in a council phase and `engine.ts:235`
  rethrows the error without recording it; the daemon is spawned with `stdio: "ignore"`
  (`src/cli/client.ts:28`), so the error reaches no log either. The error itself is therefore
  **unrecoverable from this run** — which is the finding. An operator sees a run they appear to
  have paused themselves, with no reason available anywhere. **New input for R3**, not repaired
  here.

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
"X-RateLimit-Reset":"1789430400000",  # 2026-09-15T00:00:00Z
"limit_source":"openrouter_free_tier_daily"
```

The `limit_source` is `openrouter_free_tier_daily`, not the `openrouter_free_tier_per_minute` that
`docs/RECOVERY.md` §1.2 names, and `X-RateLimit-Remaining` is 0: a **per-day account** cap of 1000,
already exhausted. A request-rate window paces a per-minute cap; it cannot pace an exhausted daily
one. R1 must handle the scope *and the period*, or it will pace a lane that has no requests left to
give. What the store cannot show is *why* the limit differs from §1.2's — the label says
"high-balance", and funding the key is the change between the two observations, but that is an
inference, not a recorded fact.

**No paid model reaches the reviewer pool by the route discovery currently takes.**
`selectReviewProviders` requires `requireStrictReviewSchema` (`composition.ts:460`), which only a
probe can set. Probes come from `buildDiscoveryShortlist`, which sorts by advertised cost ascending
and takes `maxProbesPerProvider` = 8, and free routes cost 0. Run 2's probe list is nine models,
every one `:free`. The one exception is a **pinned** model, which the shortlist admits ahead of the
sort regardless of price (`discoveryShortlist.ts:28-34`) — so "a paid reviewer is impossible" would
be false; the accurate statement is that under this config no paid model is probed, and therefore
none is eligible to review. R0 does not touch it; it is named because R5's acceptance ("fewer than
10% did not arrive") cannot be met while reviewers are confined to a lane whose daily quota is
exhausted. Either R1 changes what gets probed, or the pins do.

**What `maxRunUsd` actually is.** An admission threshold checked before each call
(`BudgetTracker.assertWithin`, `quota.ts:145-157`), not a hard cap: the call that crosses the line
is the one already allowed, so a run may finish above its limit by the cost of one call. Calls with
`costUsd: null` — every Gemini call in these runs — add nothing to `runUsd` at all and so are
outside it entirely; they are counted separately as `unknownCostCalls`. And `--budget-usd`
**replaces** the configured value rather than clamping it (`applyRunBudgetOverrides`,
`composition.ts:156-164`), so a per-run flag can raise the cap as easily as lower it. `0.50` is
therefore a default guard against an unattended run, not a guarantee about the $5 on the key. That
is a deliberate trade-off — an operator naming a budget should get the one they named — recorded
here rather than changed, because nothing observed argues for taking the override away.

## Review round 1 — GPT lane, `gpt-5.6-sol-high`, on commit `11ec918`

Verdict FAIL, 6 blocking and 7 notes. Dispositions, in the reconcile precedence
`contract-misread → actionable → trade-off → noise`:

| # | Finding | Ruling |
|---|---|---|
| 1 | `Number("")` is 0, so a blank advertised price was published as free | **actionable** — `advertisedPricePerM` rejects a blank or unparseable field; test covers `""`, `"   "`, `"tbd"` |
| 2 | A budget error thrown by a now-brokered probe became the verdict `probe_failed` | **actionable** — budget errors propagate from all five probes and abort `ModelCatalog.discover` instead of being blamed on the model or the provider |
| 3 | Brokered probe failures now penalise every probed model's routing score, including for an account-wide 429 | **actionable, partially** — probe-role calls no longer feed `catalog.recordCall` or `model.observation.recorded`. That closes it for new calls only; see round 2 finding 1 |
| 4 | `maxRunUsd` is an admission threshold, `--budget-usd` replaces rather than clamps, null-cost calls are outside it | **actionable on the text, trade-off on the behaviour** — see "What `maxRunUsd` actually is" above; the claim "divides the $5 into ten runs" was wrong and is withdrawn |
| 5 | Deferring acceptance check 2 to R3 waives it rather than meeting it | **contract-misread, upheld** — `R0.md` amended: R0 stays open until check 2 passes |
| 6 | The $0.0187 total and the quoted run-1 query are not reproducible | **actionable** — total corrected to $0.020655498 with its query; the probe query was missing `type='model.call'` and is corrected, with all four rows |
| 7 | New boundary tests assert shapes an implementation special-casing `-1_000_000` would also pass | **actionable** — one single-input case per boundary: `-0`, `±Infinity`, `NaN`, each ceiling from both sides |
| 8 | `null` pricing sorts first in `estimatedCostPerM`, the same trap one level down | **actionable** — unknown price sorts last; it only reaches the sort under `unrestricted`, which is why the ceiling fix did not cover it |
| 9 | Renaming `strictComplete` breaks untyped external callers | **noise** — one production caller, typechecked; no external consumer exists |
| 10 | "No paid model is ever probed" is too categorical: pinned models bypass the cost sort | **actionable on the text** — corrected above |
| 12 | The 20/min → 1000/day attribution to funding is inference, not record | **actionable on the text** — corrected, and `limit_source: openrouter_free_tier_daily` added, which is the more precise fact R1 needs |
| — | Contract names base `e87dd26`; implementation base is `e594bbc` | **actionable** — corrected in `R0.md` |

Finding 11 and 13 confirmed the sentinel fix, production reachability, paid selection, one-attempt
retry behaviour, and the gate.

## Review round 2 — GPT lane, on commit `6fe729d`

Verdict FAIL, 4 blocking and 3 notes.

| # | Finding | Ruling |
|---|---|---|
| 1 | The 76 probe observations already in the store replay into catalogue statistics on restart, so round 1's finding 3 is closed only for new calls | **upheld, and it is not R0's** — see below |
| 2 | The withdrawn "divides the $5 into ten runs" claim was still in the text | **actionable** — removed; the paragraph now points at what `maxRunUsd` actually guards |
| 3 | `Number` still reads `"0x10"` as 16 and `"1e-324"` as 0, publishing a hex string and an underflow as prices | **actionable** — only an unsigned decimal with optional fraction and exponent is a price, and a mantissa with a non-zero digit that evaluates to 0 has underflowed, not become free |
| 4 | "36 probe events against 4" sums two event types; the "150 paid routes" claim carries no filtering command | **actionable** — 18 against 4, and the catalogue count now carries the command that produces it |
| 5 | A budget error out of discovery is caught silently by `service.ts`, leaving the run in `DISCOVERING_MODELS/RUNNING` retrying forever | **note, recorded for R3** — better than blaming a model, still an error no operator can see. Third shape of the same defect |
| 6 | `metadata.role` is a free-form string, so the probe exemption is not an enforced boundary | **note** — no non-probe caller sets it; recorded rather than typed, because narrowing `role` touches every call site in the system and belongs to no item here |
| 7 | `Infinity - Infinity` is `NaN`, which `sort` reads as equal, skipping the name tie-break between two unknown-priced models | **actionable** — compared rather than subtracted, with a two-unknown case in the test |

**On finding 1, and why it goes to R1.** The number reproduces:

```
sqlite3 "file:$HOME/.polish/polish.db?mode=ro" \
  "select json from events where type='model.call'
    and json_extract(json,'$.payload.role')='probe';" | node -e '…sum attemptOutcomes…'
76 attempts, 67 failures: 51 rate_limit, 16 bad_request, across 11 models
```

One observation was recorded per attempt, so 76 call observations in the event log are probe
outcomes, and `ModelObservationRepository.restoreCatalog` replays every one of them into
`catalog.recordCall` on daemon start. R0's change stopped new ones; it neither created nor
worsened these, and the event log is append-only.

Closing it needs the rule applied at the replay, which needs the observation to carry the role it
does not carry today — and the reason 51 of those 67 failures are `rate_limit` is precisely
§1.2's: an account-wide limit recorded as a model property. That is **R1's** subject, stated in
this sentence so it cannot be lost: *R1 must make `restoreCatalog` obey the same rule as
`recordRoutingStats`, and must say what it does with the 76 observations already written.*

## Gates

Node 24.20.0. `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm vitest run --maxWorkers=2`
→ exit 0, 95 files, **1094 tests** (baseline at `e87dd26`: 95 files, 1077 tests).
