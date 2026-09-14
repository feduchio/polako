# Replay set — the quality non-inferiority corpus

Required by `docs/PLAN.md` §4 P2.2. Contract: `docs/ledger/P2.2.md` rev 1, frozen at `731d627`.
Measured 2026-09-14 at HOST `0d80cb0`. This file governs **quality non-inferiority only**; cost has
its own denominator in `docs/PLAN.md` §1.

## Verdict

**The floor is met as the contract words it, and the set is much weaker than a met floor suggests.**

| Reading | Entries | Of which `DONE` | Floor (≥5, ≥2) |
|---|---|---|---|
| MC1 applied literally, one entry per committed scenario | **5** | **5** | met |
| de-duplicated by (fixture, mission, task contract) | **1** | **1** | not met |
| de-duplicated by (fixture, mission, task contract, control path) | **3** | **3** | not met |

The middle row is **1**, not 3, and the distinction matters enough to spell out. All five entries
share one fixture, one mission and one task contract, so the tuple the contract's own vocabulary
supplies collapses them to a single observation. The three of the last row appear only if the key
is widened to include the control path each entry exercises — daemon happy path, daemon
answer-and-resume, engine tick loop. An earlier version of this file reported 3 under the
three-part key, which was wrong: it quoted a key it had not applied. The GPT lane caught it.

The literal reading is the one the frozen contract authorises, so the recorded verdict is **floor
met**. The de-duplicated count is recorded beside it because it is the more informative number, and
because the difference between them is a defect in the criterion rather than in the corpus — see
*The floor counts entries, not information* below. Nothing was de-duplicated away silently.

**What a met floor licenses here is narrow.** Every entry is a `ScriptedProvider` scenario with
frozen completions, so by MC5 the set can establish that a change did not break orchestration and
can **never** discharge quality non-inferiority for a change that alters what a model is asked or
what it returns.

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
| E4 | `b10.test.ts` · "sends default reasoning per role across a whole production run" | same as E3, `routing.disableReasoning = false` | `DONE` (`:564`) | `sup`, `wkr` |
| E5 | `b10.test.ts` · "sends disabled reasoning per role across a whole production run" | same as E3, `routing.disableReasoning = true` | `DONE` (`:564`) | `sup`, `wkr` |

**The models are placeholders, and that is material.** `wkr` and `sup` are `ScriptedProvider`
names with `FAKE_CAPABILITIES` and zero cost per million tokens (`b10.test.ts:245-247`), not real
provider model identifiers. The set therefore pins **no** real model, and no result from it is
evidence about any model's behaviour. MC3 of `docs/PLAN.md` §4's "two model names pinned" cannot be
satisfied by a scripted corpus; it is recorded as unsatisfiable for this set rather than filled in
with fictional names.

E4 and E5 are E3 with one routing flag flipped. They are distinct committed scenarios and MC1
admits them; they are the reason the two readings of the floor differ by two.

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

All five admitted entries reached their asserted terminal state in all three repetitions. No entry
is `unstable`, so none is excluded on that ground.

## Dispositioned and not admitted

Every `it` block in `src/e2e/` is accounted for. Sixteen in total: 5 admitted, 5 `not_terminal`,
6 `not_replayable`.

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
`task_01m2f941ehfap4aphdchey`'s history is
`PENDING > READY > RUNNING > GATED > SELECTED > INTEGRATING > INTEGRATED > BLOCKED`: it integrated
and was then blocked, so reading only its final state undercounts integration. The `reached
INTEGRATED` column exists because of that task. An earlier version of this file said three of four
reached `INTEGRATED` and that one task integrated inside a `FAILED` run; both numbers were one
short, and the GPT lane found them.

**Excluded: 4 of 4.** The reason is the same for all four and it is not a judgement about them:
`not_replayable(no replay path consumes the recorded completions)`. The material exists — the CAS
holds **954** `model_response` and **890** `model_request` artifacts — but nothing reads them back
into a provider. `RecordReplayProvider` keys on the request's messages, reasoning and `maxTokens`
(`src/providers/recordReplay.ts:31-60`) and is not wired to the CAS, and finding 14, which would
have recorded cassettes, is dropped as requiring paid provider APIs. Re-running these four missions
with the `ScriptedProvider` would not reproduce them; it would produce E1–E5 again, because that is
what those cassettes encode.

Recorded as an observation rather than scheduled work: the gap between 954 stored responses and
zero replayable entries is a missing adapter, not missing data.

**Two of the four integrated inside runs that ended `FAILED`** — `task_01m2f941ehfap4aphdchey` and
`task_01m2fmszpqrm2vpf19yy4z`, both from 2026-09-14. Task integration and run success are not the
same event, which is why the floor counts entries by their own terminal state and records the run
phase beside it rather than instead of it.

## The floor counts entries, not information

**All five** admitted entries are the same mission against the same fixture with the same task
contract, and two of the five are one scenario with a routing flag flipped. Under `docs/PLAN.md`
§4's words the floor is met; under the tuple that vocabulary implies, the set carries **one**
observation. The three control paths are the only axis along which the entries differ at all.

This is recorded as a **defect in the criterion, not repaired here**, for two reasons. Imposing a
de-duplication rule now would amend a frozen contract after seeing the count, which is the exact
move freezing exists to prevent. And MC7 forbids authoring new entries to inflate — or in this
case diversify — the set. The decision belongs to a plan revision: either the floor gains a
distinctness requirement, or it is acknowledged that five entries drawn from one fixture is what
"5 replayable entries" was always going to mean while one fixture is all there is.

`docs/PLAN.md` §2 records **0** external projects ever targeted, which is the same fact from the
other end.

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
| **P3.2** — adversarial axis as falsifier | **`inconclusive`**, and not because of the floor. P3.2 changes what the adversarial reviewer is asked — it sees only the diff and the other axes' findings and may only refute. That is a change to the request, so bar 2 applies and this set cannot discharge non-inferiority for it. The met floor does not help. |
| **P3.3** — fail-to-pass on the corpus | Evaluable against this set **if** its change is confined to admission ordering and check comparison and does not alter any model request. P3.3 as written in `docs/PLAN.md` §5 touches neither `src/verify/` nor convergence accounting, so that condition is plausible; it must be re-checked against the actual diff when P3.3 is implemented, not assumed from this file. |
| **P3.1** | Unaffected. It is gated on P2.1, which reported `inconclusive — no post-validation yield data`. |
