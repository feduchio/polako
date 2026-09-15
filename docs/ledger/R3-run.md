# R3 — run record

Contract: `docs/ledger/R3.md`. Base: `f66d3af`. Date: 2026-09-15.
Coordinator/implementer: Claude Opus 5. Reviewer lane: GPT (`gpt-5.6-sol-high`), one lane.

## The change

Three layers, outermost first, because the outermost is the one that makes the guarantee.

1. **`RunEngine.applyPhaseAdvance`** — every phase advance passes through here. A run that reaches
   a terminal phase other than `DONE` without a stated reason, and that has none already, gets
   `internal_error` naming the phase it came from. Drivers remain the right place to say *why*;
   this is the place that guarantees one of them did.
2. **`handleZeroSurvivors`** — was `{ nextPhase: "FAILED" }` with nothing else. Now counts this
   attempt's candidates and says what it counted: how many reached a gate and lost, how many the
   provider refused, how many ended otherwise. When **all** of them were refused and none reached a
   gate, the run asks a human under `provider_budget_exhausted` instead of failing, because nothing
   was judged and an allowance lifts on its own. `GATING → NEEDS_HUMAN` is a new FSM edge;
   `COMPARING` already had it.
3. **`RunEngine.driveRun`** — a driver error appends `run.driver_failed` before the engine pauses
   or rethrows, wrapped so the recorder cannot replace the error it is recording.

## Acceptance

1. All candidates refused → `NEEDS_HUMAN`, code `provider_budget_exhausted`, summary naming the
   attempt, the count refused and the provider's own words.
2. All candidates judged and lost → `FAILED`, `repeated_failure`, with the counts.
3. A mixed attempt → the counts, not the generalisation. "Every candidate failed its gates" is a
   false sentence when one of them never reached a gate.
4. A discard that is neither judged nor a provider refusal still produces a reason, never `null`.
5. A driver returning `FAILED` with no reason at all still ends with one, naming the phase.
6. A throwing driver leaves one `run.driver_failed` event carrying the phase and the message, and
   the run paused — with a cause an operator can read.

Gate: Node 24.20.0, exit 0, 96 files, **1152 tests** (1149 before the fix round, 1146 before the
item). `git diff --numstat f66d3af -- src`: 118 production, 204 test insertions — 322 total,
22 over the plan's 300.

## Review round 1 — GPT lane, on commit `61b89e2`

Verdict FAIL, 5 blocking and 3 notes. All five changed code or the record.

| # | Finding | Ruling |
|---|---|---|
| 1 | The contract's evidence is overstated: **eight** runs end `FAILED` with a null reason, not three, and the three named runs' candidate errors are not all `ProviderError` — they include `BUDGET_EXCEEDED` and `STOPPED` | **actionable** — corrected below, and `providerRefusal` now recognises the shapes the store actually holds |
| 2 | Terminal phases can still be reached with no reason: `candidateDrivers.ts:464,470`, `councilDrivers.ts:265`, and five `NEEDS_HUMAN` sites that emit a report without setting a run reason | **actionable, and it moved the fix** — a per-site repair would have left the next site to find. The guarantee now lives in `applyPhaseAdvance`, which every advance passes through |
| 3 | The classification is unsound: a gate failure whose detail contains "budget" was misread; a refusal that does not say `ProviderError` was missed; a mixed attempt was reported as "every candidate failed its gates", which is false; and the counts came from **all** attempts — 22 candidates reported where the last attempt made 6 | **actionable** — this attempt only, counted rather than generalised, and the provider branch requires *every* candidate to have been refused. The text match is documented as a heuristic that chooses which true statement to emphasise, not whether the operator is told the truth |
| 4 | `polish answer` cannot resume the new `GATING → NEEDS_HUMAN`: the task is left `BLOCKED` and `gatedTask` only selects `GATED`, so the resumed driver waits forever | **upheld, and the option that promised it is withdrawn** — the reason no longer offers "wait and resume", because resuming does not work. Making it resumable means not spending an attempt on a refusal, which is **R1c**'s subject and not repairable here |
| 5 | `run.driver_failed` is absent from `KNOWN_EVENT_TYPES`, and both `requireRun` and `append` can throw and mask the driver's error | **actionable** — declared, along with R2's `review.canary_recorded`, which had the same omission; and the append cannot mask |
| 6–8 | The FSM edge is structurally sound; the summary picked an arbitrary candidate's error; the tests did not cover mixed outcomes or the production candidate lifecycle | **notes** — the arbitrary pick is replaced by counts; the mixed case has a test; the lifecycle gap is recorded below |

## Corrected evidence

```
sqlite3 "file:$HOME/.polish/polish.db?mode=ro" \
  "select count(*) from runs where phase='FAILED' and json_extract(json,'$.terminalReason') is null;"
8
```

Eight, not three. The three this item started from are the ones whose candidate histories were
read in full; the other five were not examined, and the fix in `applyPhaseAdvance` is what covers
the ones nobody looked at.

## Review round 2 — GPT lane, on commit `eacc2d6`

Verdict FAIL, 4 blocking and 4 notes.

| # | Finding | Ruling |
|---|---|---|
| 1 | The fallback closes the hole but replaces a *truer* reason with a generic one: four sites in `convergenceDrivers.ts` build a specific reason — "no proven rollback target", the pathology decision's own words — and pass it only to the report, so the run recorded "without a stated reason" | **actionable** — all four now put the reason on the run as well. The fallback is a floor, not a substitute, and it was being used as one |
| 2 | `providerRefusal` matched every `ProviderError` and `BUDGET_EXCEEDED`, so a 404, a 400, an auth failure, a timeout and the **local** context-pack cap all became "wait for the allowance to reset" | **actionable** — the predicate decides whether an operator is told to wait, so it now matches only what waiting repairs: rate limits and quotas. Seven cases, one per real string in the store |
| 3 | The contract still said every candidate in all three runs was refused by the provider, which two of them contradict | **actionable on the text** — corrected: no candidate reached a gate, and what discarded them was not one thing |
| 4 | `requireRun` still sat outside the guard, so a driver that closes the store replaces its own error with "database is not open" | **actionable** — the pre-driver phase is used when the re-read fails |
| 5–8 | The attempt filter is correct in the production lifecycle; the withdrawn resume option is honest; the tests admit some mutants; the size figures are right | **notes** — the classification table added this round closes the largest of the test gaps |

## Not covered

- **The `NEEDS_HUMAN` is not resumable.** Round 1 finding 4. An operator can only stop and start a
  new run once the allowance resets. R1c owns the repair, because making it resumable means not
  charging an attempt for a refusal.
- **The tests seed candidates directly.** Production reaches these states by updating an
  `IMPLEMENTED` candidate through `candidate.gated`; the fixtures assert the projection that
  results, not the lifecycle that produces it.
- **The daemon's stderr still goes nowhere** (`stdio: "ignore"`). The fix here is that the cause is
  in the run's own event log, where `polish log` already looks, not that the process logs.
