# Replay set — the quality non-inferiority corpus

Required by `docs/PLAN.md` §4 P2.2. Contract: `docs/ledger/P2.2.md` rev 1, frozen at `731d627`.
Measured 2026-09-14 at HOST `0d80cb0`. This file governs **quality non-inferiority only**; cost has
its own denominator in `docs/PLAN.md` §1.

## Verdict

**`inconclusive — insufficient replay corpus`.**

**4** admitted entries, all 4 reaching `DONE`, against a floor of 5. The floor is **not met**, so by
MC4 every gate that depends on this set — P3.2 and P3.3 — reports `inconclusive` rather than
passing.

| Reading | Entries | Of which `DONE` | Floor (≥5, ≥2) |
|---|---|---|---|
| MC1 applied as frozen, one entry per committed scenario | **4** | **4** | **not met** |
| de-duplicated by (fixture, mission, task contract) | 1 | 1 | not met |
| de-duplicated by (fixture, mission, task contract, control path) | 3 | 3 | not met |

**The count is 4 because a parameterised test is one committed scenario.** MC1's unit is "a
committed scripted scenario", and its opening sentence says it is stated so the count cannot be
inflated. `b10.test.ts:512-515` is a single `it.each` with two arms — the same fixture, mission,
cassettes and engine path, differing only in `routing.disableReasoning` and in what they assert
about the request shape. Vitest expands it into two test results; the committed scenario is one.
The two arms cannot disagree on MC6's predicate, the terminal state, except by crashing the
pipeline. Counting an `it.each` row as an entry would make any flag table a corpus.

**And the verdict would be `inconclusive` even at a count of 5, because MC4's positive outcome is
not a count.** Its two authorised outputs are `inconclusive — insufficient replay corpus` below the
floor and, at or above it, that *the quality gate is evaluable and says so*. The quality gate is
MC6. A corpus that reduces to **one** observation under the tuple this contract's own vocabulary
supplies cannot be called evaluable, and an earlier version of this file proved the point by
printing "floor met" and then withdrawing the licence two sections later — a third verdict the
contract does not have. The Grok lane named both defects; the second is the one that matters, since
a reader starting P3.3 reads the verdict line and not the caveat.

**What this set could establish if it did meet the floor is narrow anyway.** Every entry is a
`ScriptedProvider` scenario with frozen completions, so by MC5 it can only show that a change did
not break orchestration, and can **never** discharge quality non-inferiority for a change that
alters what a model is asked or what it returns.

## Admitted entries

All five drive `fixtures/resume-dup-fetch`. All five use the mission
*"Fix duplicate request after resume: clear #pending before retry"*, and the task contract comes
from the scripted council's `plannerDecompose()`: title *"Fix duplicate in-flight detection on
retry"*, `requirementRef: "R1"`, acceptance *"retries after transient failure succeed"* and
*"test suite passes"*.

| # | Scenario | Driven through | Terminal state | Models |
|---|---|---|---|---|
| E1 | `b10-daemon.test.ts` · "runs full production pipeline via DaemonService.handle to DONE" | `DaemonService.handle("run")` then `engine.tickRun` | `DONE` (`:480`) | `wkr` |
| E2 | `b10-daemon.test.ts` · "answers NEEDS_HUMAN through RPC and resumes the requesting phase to DONE" | `handle("run")`, `handle("answer")`, `tickRun` | `DONE` (`:517`) | `wkr` |
| E3 | `b10.test.ts` · "runs full production pipeline from bug-present to DONE with all 23 assertions" | `installProductionDrivers` + `engine.tickRun` | `DONE` (`:498`) | `sup`, `wkr` |
| E4 | `b10.test.ts:512` · the `it.each` "sends $arm reasoning per role across a whole production run" | same as E3, once with `routing.disableReasoning = false` and once `true` | `DONE` (`:564`), both arms | `sup`, `wkr` |

E4 is **one** entry. Vitest expands it into two test results and both reach `DONE`, but it is one
committed scenario, and MC1 counts scenarios. Both arms are still executed and both are covered by
the stability check below; what they do not do is count twice toward the floor.

All four entries reached their asserted `DONE` in all three repetitions, so the `DONE` count is 4
and the binding shortfall is the entry count, not the `DONE` count.

**The models are placeholders, and that is material.** `wkr` and `sup` are `ScriptedProvider`
names with `FAKE_CAPABILITIES` and zero cost per million tokens (`b10.test.ts:245-247`), not real
provider model identifiers. The set therefore pins **no** real model, and no result from it is
evidence about any model's behaviour. MC3 of `docs/PLAN.md` §4's "two model names pinned" cannot be
satisfied by a scripted corpus; it is recorded as unsatisfiable for this set rather than filled in
with fictional names.

E4 is E3 with one routing flag flipped, in both directions. It is admitted as one scenario, which
is what takes the count to 4 rather than 5.

## Stability — MC3

Command, run three times in full:

```
pnpm vitest run src/e2e/b10-daemon.test.ts src/e2e/b10.test.ts --maxWorkers=2
```

| Repetition | Result |
|---|---|
| 1 | exit 0, 14 tests passed |
| 2 | exit 0, 14 tests passed |
| 3 | exit 0, 14 tests passed |

All four admitted entries, including both arms of E4, reached their asserted terminal state in all
three repetitions. No entry is `unstable`, so none is excluded on that ground. The shortfall is a
shortfall of entries, not of stability.

## Dispositioned and not admitted

Every `it` block in `src/e2e/` is accounted for. Sixteen expanded test results in total: 5 of them
admitted as 4 entries, 5 `not_terminal`, 6 `not_replayable`.

**The census was also taken outside `src/e2e/`, because MC1 does not confine a scenario to that
directory — AC2 does.** The second reviewer lane searched the rest of `src/` for the three MC1
clauses together and found no further admission. The near misses, recorded so the search is
reproducible rather than asserted: `src/daemon/bootstrap-daemon.test.ts:81` drives a production
daemon through `handle("run")` but against a synthetic demo repository rather than a named fixture,
and asserts `EXECUTING|REVIEWING`; `src/engine/engine.test.ts`, `multi-task-done.test.ts`,
`planning-reentry.test.ts` and `convergence-drivers.test.ts` reach `DONE`, `FAILED` or
`NEEDS_HUMAN` on **stub** drivers or seeded phase state; `src/engine/review-drivers.test.ts`
reaches `FAILED` from `seedReviewingRun` with stubs; `src/engine/review-routing.test.ts` and
`src/daemon/reasoning-policy.test.ts` use production drivers but assert at function level with no
named terminal for a fixture run.

| Scenario | Disposition |
|---|---|
| `b10-daemon` · "stops in EXECUTING and resumes without dispatching inside the resume RPC" | `not_terminal(rests in EXECUTING with control RUNNING; a stop-and-resume is mid-run by construction)` |
| `b10-daemon` · "recovers an EXECUTING run, its jobs, and non-zero spend in a fresh service" | `not_terminal(asserts the recovered phase equals the pre-kill EXECUTING phase)` |
| `b10-daemon` · "reaches DONE with required runtime evidence whose artifact identity survives restart" | `not_replayable(reaches DONE only after a direct SQL DELETE on acceptance_corpus_entries and events.rebuildProjections at :672-676; MC1 clause 2 excludes a run driven by patching the store)` |
| `b10` · "Scenario 1: no worker work → run does not reach DONE" | `not_terminal(asserts only not DONE; no resting phase named)` |
| `b10` · "Scenario 2: empty diff → DONE is rejected by anti-fake-DONE" | `not_terminal(same)` |
| `b10` · "Scenario 6: broken integration (tests fail) → checkpoint does not advance to DONE" | `not_terminal(rests in a disjunction — FAILED, NEEDS_HUMAN, or checkpoint unchanged — so no single state to compare across repetitions)` |
| `b10` · "Scenario 3: buildCleanRoundFromReview throws when no completed review exists" | `not_replayable(helper assertion; no run)` |
| `b10` · "Scenario 4: runtime=required with failing evidence → DONE impossible" | `not_replayable(calls runtimeAllowsDone on synthetic evidence; no run)` |
| `b10` · "Scenario 5: stale runtime evidence (wrong checkpoint) → not DONE if required" | `not_replayable(same)` |
| `economics` · "reports a completed historical run from persisted events without live budget state" | `not_replayable(synthetic Run appended to the store with phase DONE preset; mocked daemon transport; no fixture run driven)` |
| `economics` · "prints JSON and rejects an unknown run id through the same transport" | `not_replayable(CLI transport test; no run)` |

The three `not_terminal` negative scenarios are worth a line each, because they look like entries
and are not: each asserts a **negation**, and a negation has no single state to compare across
repetitions. "Not `DONE`" is satisfied by `FAILED`, by `NEEDS_HUMAN`, and by a run that simply
stops advancing, which are three different outcomes. MC6's rule is "the same terminal state", not
"not the forbidden one".

## Historical half — MC2

Every task in `~/.polish/polish.db` that ever entered `INTEGRATING`, read-only at
`readOnly: true`, never through `openDb`. **Four**, not the two `docs/PLAN.md` §4 recorded on
2026-09-13: two of these are from the post-cut-off runs of 2026-09-14.

| Task | Run | Run phase | Reached `INTEGRATED` | Final task state | Base checkpoint | Tokens | Replayable |
|---|---|---|---|---|---|---|---|
| `task_01m1my57cms33fcyvg1wxq` | `run_01m1my3pdwwqxr1pe45z91` | `DONE` | yes | `INTEGRATED` | `bd6ee536` | 115,475 | no |
| `task_01m1p04nbyw6y5berx0yf3` | `run_01m1p013kghsprxj7atb6w` | `DONE` | yes | `INTEGRATED` | `44e6bf3f` | 902,060 | no |
| `task_01m2f941ehfap4aphdchey` | `run_01m2f93fdescrs2qrtq01f` | `FAILED` | **yes** | `BLOCKED` | `4afe9df1` | 104,047 | no |
| `task_01m2fmszpqrm2vpf19yy4z` | `run_01m2fms2rgx22qjckxrz66` | `FAILED` | yes | `INTEGRATED` | `4afe9df1` | 358,838 | no |

**All four reached `INTEGRATED`, and the final-state column hides one of them.**
`task_01m2f941ehfap4aphdchey` integrated and then went through three further gate-and-retry cycles
before ending `BLOCKED`, so reading only its final state undercounts integration. Its recorded
sequence, in full:

```
PENDING > READY > RUNNING > GATED > READY > RUNNING > GATED > READY > RUNNING > GATED > SELECTED
> INTEGRATING > INTEGRATED > GATED > READY > RUNNING > GATED > READY > RUNNING > GATED > READY
> RUNNING > GATED > BLOCKED
```

`task_01m2fmszpqrm2vpf19yy4z` is the other post-cut-off one, and it **integrated twice** — two
distinct `task.state_changed` events reaching `INTEGRATED`, with a full gate-and-select cycle
between them:

```
PENDING > READY > RUNNING > GATED > READY > RUNNING > GATED > READY > RUNNING > GATED > READY
> RUNNING > GATED > READY > RUNNING > GATED > READY > RUNNING > GATED > SELECTED > INTEGRATING
> INTEGRATED > GATED > SELECTED > INTEGRATING > INTEGRATED
```

The `reached INTEGRATED` column exists because of those two. An earlier version of this file said
three of four reached `INTEGRATED` and that one task integrated inside a `FAILED` run — both a
count short — and then described the first task's history as `INTEGRATED > BLOCKED`, which omitted the ten
state changes between them. The GPT lane found all three errors; the third came from a query that printed
distinct states rather than the sequence.

**Excluded: 4 of 4.** The reason is the same for all four and it is not a judgement about them:
`not_replayable(no replay path consumes the recorded completions)`. The material exists — the CAS
holds **954** `model_response` and **890** `model_request` artifacts — but nothing reads them back
into a provider. `RecordReplayProvider` keys on the request's messages, reasoning and `maxTokens`
(`src/providers/recordReplay.ts:31-60`) and is not wired to the CAS, and finding 14, which would
have recorded cassettes, is dropped as requiring paid provider APIs. Re-running these four missions
with the `ScriptedProvider` would not reproduce them; it would produce E1–E4 again, because that is
what those cassettes encode.

Recorded as an observation rather than scheduled work: the gap between 954 stored responses and
zero replayable entries is a missing adapter, not missing data.

**The `Base checkpoint` column is the task's creation baseline, not where it integrated.** It is
`baseCheckpointHash` as recorded on `task.created`, which is the run's baseline at the moment the
task was planned. The value moves afterwards: the first two tasks' final projected bases are
`c011b6e8` and `b35fe739` — the same two review checkpoints `docs/ledger/g1-baseline.md` keys its
six rounds on — and `task_01m2fmszpqrm2vpf19yy4z` was created at `4afe9df1` but finally carries
`52d0ccef`, the first of its two integrations. Anyone joining this table to §1's rounds on these
prefixes will find nothing; join on the final base or on the round identity instead. Recorded
because the first draft's final-state column hid a transition the same way.

**Two of the four integrated inside runs that ended `FAILED`** — `task_01m2f941ehfap4aphdchey` and
`task_01m2fmszpqrm2vpf19yy4z`, both from 2026-09-14. Task integration and run success are not the
same event, which is why the floor counts entries by their own terminal state and records the run
phase beside it rather than instead of it.

## Why the count and the information both fall short

**All four** admitted entries are the same mission against the same fixture with the same task
contract. The three control paths — daemon happy path, daemon answer-and-resume, engine tick loop —
are the only axis along which they differ at all, and one of the four is another scenario's engine
path with a routing flag flipped. Under the tuple this contract's vocabulary supplies, the set
carries **one** observation.

The verdict does not rest on that argument, and this is worth being precise about, because the
argument was tried first and was the wrong shape. The count is **4** against a floor of **5** by
MC1's own unit, so the floor fails arithmetically and no interpretation is needed. The
informational point is why a count of 5 would not have rescued it either: MC4's positive outcome is
that *the quality gate is evaluable*, and one observation is not an evaluable corpus for MC6's
rule.

**What is not done here.** MC7 forbids authoring new scenarios to inflate or diversify the set, and
nothing has been added. Whether the plan's floor should also carry a distinctness requirement is a
question for a plan revision; it is now moot for this verdict, since the floor fails on the count.

`docs/PLAN.md` §2 records **0** external projects ever targeted, which is the same fact from the
other end: one fixture is all there is to draw entries from.

## The two bars — MC5

Both hold whether or not the floor is met.

1. **No entry here is admitted to `docs/PLAN.md` §1's cost arm.** `ScriptedProvider` reports no real
   spend; `b10.test.ts:245-247` sets cost per million tokens to zero on both models.
2. **Frozen completions test orchestration, not model output.** A change that alters what a model is
   asked or what it returns makes this set `inconclusive` **regardless of the floor**, because the
   cassettes encode the old request and would miss. `RecordReplayProvider.requestKey` hashes
   messages, reasoning and `maxTokens`, and `ScriptedProvider` is a FIFO queue per model
   (`src/providers/scripted.ts:38-57`) sensitive to call count and order.

## The gate this set supports — MC6

A change may replace an existing path only if **every** replayable entry reaches the **same
terminal state** in all 3 repetitions. There is no cost clause: cost is §1's gate on its own
denominator, and the earlier "at equal or lower cost" phrasing was removed in plan revision 8
because it re-imported the retired task-based metric into a quality-only section.

## Consequence for P3

| Item | Status from this set |
|---|---|
| **P3.2** — adversarial axis as falsifier | **`inconclusive`**, twice over. The floor is unmet, and even a met floor would not have helped: P3.2 changes what the adversarial reviewer is asked — it sees only the diff and the other axes' findings and may only refute — so MC5's second bar applies. `docs/PLAN.md` §5's verify clause "P2.2 replay set unchanged" cannot be discharged when the cassettes would miss. |
| **P3.3** — fail-to-pass on the corpus | **`inconclusive`**. The floor is unmet, and MC4 says every dependent gate reports `inconclusive` rather than passing. Its change may well touch no model request — `docs/PLAN.md` §5 puts it in admission ordering and check comparison, touching neither `src/verify/` nor convergence accounting — but that only means MC5's second bar would not *additionally* block it. It does not restore the floor. |
| **P3.1** | Unaffected by this item. It is gated on P2.1, which reported `inconclusive — no post-validation yield data`. |

All three P3 items are therefore `inconclusive`, each for its own reason, and `docs/PLAN.md` §1's
quality-coupling clause continues to hold: while the quality gate is not `pass`, no cost-reducing
production behaviour may be enabled by default. `review.skipAdversarialWhenClean` stays `false`.
