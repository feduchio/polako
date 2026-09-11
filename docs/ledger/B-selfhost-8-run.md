# B-selfhost-8 — run record

**Status:** TASK ACCEPTED at `14beb80`, after two consecutive clean rounds on the unchanged commit
under the revised stopping rule in `docs/ledger/PHASE-C.md`. Both reviewers passed both rounds
with no blocking findings, re-derived the whole MC/AC table independently in the confirming
round, killed the contract's named cheapest fake, and each stated there is nothing in the
production code they would refuse to ship.

An earlier revision of this file declared the task ACCEPTED at `d1cd7e9` after rounds 14 and 15.
That was wrong twice over: it was written while Claude's round 14 was still in flight, and round
15 on the unchanged commit returned a Grok FAIL. Five consecutive rounds reopened the task after
that premature entry, four of them on production-relevant defects. The error is kept on the
record because it is the same mistake as the task's central finding — treating a clean round as
evidence of exhaustion.

## Provenance

| What | Where |
| --- | --- |
| Finding | B-selfhost item 8: `--budget-tokens` / `--budget-usd` validated, persisted, never applied |
| Exact base | `1dc1c5cfbb2f92efb2fa8f58f15e92f02a3c80b2` (B-selfhost-7, the accepted HOST) |
| Frozen contract | `docs/ledger/B-selfhost-8.md` at `50a5c65`, sha256 `97beacbe698fae20c0b4c01e04bf441c6604d8f7d33dbb886910cd1ae5cbd8b7` |
| Candidate branch | `task/B-selfhost-8-candidate-grok` |
| Accepted commit | `14beb802857fde8a5251404dc518301cb5b1a0a4` (28 commits since base) |
| Lanes | Grok and Claude for review; coordinator implemented |

## What the defect actually was

The one-line finding said the flags were ignored. The shape underneath was different and
larger. `BudgetTracker` already partitioned *spend* per run and held a single `limits` object
for every run, so the asymmetry was in the limits alone. `applyRunBudgetOverrides` existed with
no caller at all. And C2's `cliBudget` input was accepted by `buildPathologySample` and supplied
by nobody, so the pathology snapshot reported every run's CLI budget as unapplied — the same
defect one layer down, with a field literally typed `applied: false`.

B-selfhost-7's `resolveRunConfig` seam does not reach the broker's tracker, so it could not be
reused directly; the fix mirrors its shape instead.

## Contract review changed the task

Both contract reviews returned FAIL on the draft, and the central claim of the draft's anti-fake
section was simply false: `assertWithin` is synchronous, so save-set-restore around it cannot
leak, and the draft's own wording steered reviewers onto that seam. One invariant was literally
unsatisfiable (four dimensions described as three), one acceptance check was unimplementable
(the scripted provider defaults `costUsd` to null), one asserted resolution rather than
enforcement, and two were passable with a hand-built `PhaseContext`. The frozen contract
replaced the countermeasure: the cheapest fake is resolve-and-assign into the shared field
immediately before the synchronous guard, and AC7 plus AC8 — not any concurrency check — are
what catch it. Every reviewer since has confirmed that pair fires and that AC6 does not.

## Implementation

| Commit | What |
| --- | --- |
| `2ef215b` | Per-run limits in the tracker; one resolution feeding broker and C2; `cliBudget` chain closed |
| `df24e83` | Validated a run's persisted budget on read, so a corrupt value cannot leave a run uncapped |
| Twenty-six further commits | Test-only, each closing a survivable mutant or an unobserved clause a reviewer named |

Only two commits changed behaviour. Everything after `df24e83` closed gaps between what the
implementation did and what the checks could see — the full list is in the review-round section.

The seam is `BudgetTracker(limits, resolveRunLimits?)`: the constructor's limits stay
`private readonly` and are never written, a run's own limits live in a separate run-keyed map,
and runs this process never created resolve lazily from `facade.json`. Registration happens
immediately after `engine.createRun` with no intervening `await`, so a tick or model call that
lands before `writeMetadata` still sees the run's own cap. `DaemonService.runConfig` applies the
same overrides through the same `applyRunBudgetOverrides`, so the broker's guard and C2's
`liveBudgetLimits` cannot disagree about when a run is out of budget.

## Review rounds

Each reviewer worked in its own worktree. Rounds are on the commit named.

| Round | Commit | Grok | Claude | What reopened it |
| --- | --- | --- | --- | --- |
| 1 | `2ef215b` | PASS | PASS | `setRunLimits` had no production caller; restart check drove one touch order |
| 2 | `ad80df6` | PASS | PASS | A corrupt persisted budget left a run with **no** cap; three survivable mutants |
| 3 | `df24e83` | PASS | PASS | Both directions of the new guard were unpinned |
| 4 | `4235298` | PASS | PASS | C2 assertions matched a subset, so widening the overridable set passed |
| 5 | `64f2aba` | PASS | PASS | MC10's model-call half was unobserved |
| 6 | `c75bd23` | PASS | PASS | AC13's `CONFIG_ERROR` was unobserved |
| 7 | `b549e83` | **FAIL** | **FAIL** | No fixture configured a finite USD or wall-clock limit: those assertions compared `null` to `null` |
| 8 | `baf1c6e` | PASS | PASS | A clamp confined to the USD dimension; a rejected budget could perturb another dimension |
| 9 | `5982037` | **FAIL** | PASS | USD raise was never driven against a finite cap through the broker |
| 10 | `c2250e1` | **FAIL** | **FAIL** | USD *lower* against a finite cap; and the budget overlay could drop a run's runtime mode |
| 11 | `209df83` | PASS | PASS | The persisted guard was driven on tokens only; a mixed file was never read |
| 12 | `1f01907` | PASS | **FAIL** | `1e999` parses to Infinity — the finiteness check was not dead code after all |
| 13 | `9b95b86` | **FAIL** | PASS | A guard rejecting USD below a dollar; an infinite budget at the entry point |
| 14 | `d1cd7e9` | PASS | PASS | Clean — the first clean round, and not the last reopening |
| 15 | `d1cd7e9` | **FAIL** | PASS | Both flags present and exactly one invalid: validation had only ever driven one flag at a time |
| 16 | `dd7d5f1` | **FAIL** | PASS | Every budget check called the broker with **no task id**; production always names one |
| 17 | `d754fd7` | **FAIL** | PASS | One run's spend arrives under several task ids, and council/review name none |
| 18 | `c3e7755` | **FAIL** | PASS | The refusal was never driven on a task the guard had not already seen |
| 19 | `fb30993` | PASS | **FAIL** | The cross-surface check contained no comparison; a USD-only override could leave a run with no token cap |
| 20 | `b59591c` | PASS | **FAIL** | Guard-vs-C2 compared one dimension of three; the USD boundary was pinned only to within one call's cost |
| 21 | `0d85a92` | **FAIL** | **FAIL** | A fractional USD override never met a finite configured cap, so truncation agreed with itself; and the two dimensions no override may touch were never observed unset |
| 22 | `73712b4` | **FAIL** | running | C2's copy of the merge was never observed where the configuration set nothing, nor for a run in the default runtime mode |
| 23 | `a09624e` | **FAIL** | not run | Two recovered runs at C2, an override equal to the configured cap, and C2 exhaustion for an overridden run |
| 24 | `164fc45` | **FAIL** | **FAIL** | Both, independently: a facade carrying a budget and no `runtime` field skips `runConfig`'s mode branch, and the budget merge sits just past it |
| 25 | `14beb80` | PASS | PASS | Clean — first clean round under the revised rule |
| 26 | `14beb80` | PASS | PASS | Clean — accepted, no change between rounds 25 and 26 |

Twenty-two rounds were reopened rather than banked, and rounds 21 and 22 by both reviewers independently. Every reopening met the stopping rule: a
production behaviour defect, a survivable mutant, or a literal clause no check observed.

**Two commits changed behaviour; twenty-six changed only what the tests could see.** The pattern is
the finding of this task. After round 2 the implementation was correct and stayed correct, and
every subsequent round closed a gap between what was true and what was demonstrated.

### How the findings were actually produced

Three distinct search methods were used, and each exhausted before the next was found.

**Rounds 1–8, mutant hunting.** Reviewers were asked to hunt mutants. That produced one finding
per round and did not converge: each round found a different single instance of the same
underlying gap.

**Rounds 9–14, enumerating values.** The instruction changed to *enumerate the space of wrong
implementations* and, for each clause, *name the check that observes it rather than the fact that
makes it true*. The grid `{tokens, USD} x {raise, lower} x {broker guard, C2 sample} x {override
present, absent}` was swept in one round and named the single unobserved cell exactly. Later
rounds extended it to the composition of budget with runtime mode, the persisted guard per
dimension and per polarity of a mixed file, and the classes of rejected value. Every one of those
sweeps found something. This method ran out at round 14, which was clean.

**Rounds 15–19, call shape and assertion shape.** The productive question stopped being *which
value could be wrong* and became *how does production actually call this code*. The answer was
that production always names a task and the entire suite called without one. That single change
of question produced four consecutive reopenings, and the taskId family cost three of them
because each round closed one cell of it before anyone enumerated the family:

- the asserting call names a task at all (round 16);
- a run's spend arrives under several task ids, mixed with unnamed council and review calls (round 17);
- the refusal lands on a task id the guard has never seen (round 18).

Round 19 pushed the same lens from the shape of the *call* to the shape of the *assertion*. The
check named "both surfaces agree" contained no comparison: no run it asserted ever issued a model
call, so C2's numbers were matched against a literal written beside them and the guard's numbers
against a different literal in another test. Two literal matches are not a comparison, and a
second diverging resolution on the broker side passed everything — including one that left a
USD-overridden run with no token cap at all, the dimension its own override did not name.

**Rounds 20–21, the shape of the assertion again, two levels deeper.** Both rounds found the same
kind of hole in the work of the round before, which is why they are worth recording as a
progression rather than as three findings.

- Round 19 replaced literal-matching with a comparison: read the limit from one surface, require
  the other to refuse at it.
- Round 20 showed that a comparison observed on one dimension says nothing about the others, and
  that **the state of the dimensions a divergence does not touch is itself an axis.** The surviving
  mutant kept the configured USD cap whenever the *token* cap was finite. Two earlier mutants, one
  from each of the other two participants, had been conditioned on the dimension under test and
  died, and both of us concluded from their deaths that the cell was closed. A second lesson came
  with it: **a fixture cannot observe what it cannot reach** — the one fixture with the right
  configuration was unpriced, so the guard's USD dimension could not bind in it at all.
- Round 21 showed that **a comparison between two surfaces is blind to a resolution that is wrong
  on both**, because both read it from one place. Every override in the suite meeting a finite
  configured USD cap was an integer, so a resolver truncating a fractional one agreed with itself
  on the wrong number and passed every agreement check. Agreement needs a companion pin on
  fidelity to what was requested. The family had two members — the live path and the read-back
  path resolve a run's overrides separately — and each was verified to survive before either was
  closed, so neither check is redundant.
- Round 21's other half took round 20's axis and applied it to the dimensions **no override may
  touch**. "Equals the loaded configuration's value" had only ever been observed where there was a
  value to equal: every fixture reaching C2 configured the per-task and wall-clock caps finite, so
  a merge inventing either of them when the operator set none agreed with every check. The
  wall-clock half is the worse of the two because it is a decision rather than a report — an
  invented deadline lands among the exhausted dimensions and stops the run — so a run that merely
  passed `--budget-tokens` could be terminated on a cap nobody configured. Note the symmetry with
  round 20: same axis, opposite half of the dimension set. Sweeping `{finite, null}` for the
  overridable dimensions did not sweep it for the others.
- Round 22 found the same shape in the fixtures' *unexamined defaults*, and this is the sharpest
  form of it. `runBudget` is one lookup but the merge runs twice, once for the tracker and once for
  C2, so every way C2's copy can diverge has to be observed separately. Two were not. C2's copy
  could overlay a dimension only where a finite value already existed — reporting the
  configuration's `null` while the guard bound the run's own number — because every fixture
  reaching C2 configured the dimension the run then overrode. And C2's copy could be skipped
  entirely for `runtime: "auto"`, because the test helper defaults every run to `"off"` while
  `auto` is what the RPC handler and the CLI default to. **The entire C2 agreement suite therefore
  ran in a runtime mode no production run gets by default.** The lesson generalises past budgets:
  a shared default in a test helper — the mode, the provider's pricing, whether a call names a
  task — is an ambient condition every check in that file inherits, and a defect conditioned on it
  is invisible to all of them at once. Worth auditing whenever a helper picks a value the
  production entry point does not.

**Round 24 — the process itself was the defect.** Three commits changed production code, all in
rounds 1–3, totalling `+109/−20` lines. Twenty-four commits and twenty-one rounds later, no
reviewer had reported a production defect since round 3, and every commit was test-only. The rule
being applied — a survivable mutant is blocking — has no fixed point, because for any finite suite
an incorrect implementation can be conditioned on ambient state the fixtures do not vary. The
coordinator's standing instruction to *name an axis none of these covers* guaranteed a finding
every round. The stopping rule was revised at this point and moved to `docs/ledger/PHASE-C.md`, so
it governs the remaining items rather than only this one: acceptance is judged against the frozen
contract, and a class-(b) mutant is blocking only when it is a plausible omission or
simplification rather than a branch on state it has no reason to read. The rounds below are kept
in full because the first nineteen were productive and the shape of the drift is the lesson.

Facts worth carrying forward:

- **Two independent PASSes mean nobody found anything, not that there is nothing to find.** Rounds
  1–6 were all double PASS, and round 7 then failed on a class of vacuity that had been present
  the whole time. Round 14 was clean and five reopenings followed it.
- **Agreement between two models is not independent evidence when both reason instead of testing.**
  Three consecutive rounds recorded the finiteness check as unreachable dead code, both reviewers
  concurring, on the argument that JSON cannot encode Infinity. The literal `1e999` overflows on
  parse. The claim was never run.
- **A reviewer's own classification is a description, not a decision.** Twice a reviewer labelled
  something a coverage note that turned out to be a live survivable mutant, and twice one was
  labelled blocking that sat outside any clause.
- **A surviving mutant deserves the same suspicion as a green test.** The coordinator's first
  attempt at Grok's round-16 mutant survived — not because the test was weak, but because the
  early return was inserted after the run-level checks had already executed, so the mutation did
  not produce the behaviour it claimed. Taken at face value it would have argued the exact
  opposite of the truth. Mutations are now verified to be both *present* and *effective* in the
  same command that runs the tests.
- **The value of a finding is the family it points at, not the cell.** Three rounds closed one
  cell each of the task-identity family. Enumerating the family cost one round and closed it,
  and the enumeration is also what made the other cells trustworthy.

## Anti-fake evidence

Mutations run by the coordinator, each verified present in the same shell command that ran the
tests, with `--no-cache`:

| Mutation | Killed by |
| --- | --- |
| Guard reads the shared limits instead of the run's | 12 checks |
| Shared config assigned per run | static pin |
| Overrides applied to the broker only, not `ctx.config` | two-surface agreement, pre-metadata tick |
| Registration moved after `await git.createBranch` | pre-metadata tick |
| `applied` hardcoded false | C2 honesty |
| `resolveCliBudget` not supplied | C2 honesty |
| Cache keyed globally rather than per run | restart, both orders |
| `runConfig` applies only the token half | two-surface agreement |
| USD-only override clears the configured token cap | two-surface agreement |
| Tracker caches the no-override fallback | tracker unit check |
| Persisted budget trusted without validation | corrupt-budget fallback |
| USD budget required to be integral | fractional USD across restart |
| Guard reduced to its type check | corrupt-budget fallback |
| Wall-clock added to the overridable set | C2 dimension equality |
| Error handling removed from the persisted read | unparseable facade |
| Tracker resolver reads persisted metadata only | in-window model call |
| Token check fires only when the other flag is absent | mixed valid/invalid flags |
| Run caps skipped whenever the call names a task | run caps on a named call |
| Run cap counted per task rather than per run | spend summed across task ids |
| Refusal only on a task the guard has already seen | refusal on a fresh task id |
| Broker resolves the token cap to null under a USD-only override | limit read from the C2 sample |
| Broker keeps the configured USD cap whenever that cap is finite | finite-USD replacement in both directions; mixed corrupt facade |
| Broker keeps the configured USD cap whenever the *token* cap is finite | every-dimension comparison, priced |
| Broker drops the per-task cap for a USD-only override | every-dimension comparison, priced |
| USD guard fires an epsilon below the cap | priced call below its own cap |
| Live path truncates a fractional USD override when a cap is configured | fidelity pin on the reported value; fractional restart |
| Read-back path truncates it, live path intact | fractional restart against a finite configured cap |
| Merge invents a per-task cap when none is configured | untouchable dimensions unset |
| Merge invents a one-minute deadline when none is configured | untouchable dimensions unset, reported and decided |
| C2's merge overlays only where a finite value already exists | C2 sample with nothing configured |
| C2's merge is skipped for the default runtime mode | C2 sample for a run created with `auto` |
| Untouchable dimensions invented for a *recovered* run | recovered run with nothing else configured, reported and decided |
| C2's merge truncates a fraction where nothing is configured | fractional override in the null-configured C2 check |
| C2 answers every recovered run with the first budget it resolved | two recovered runs sampled, then the first again |
| An override equal to the configured cap registered as no override | equal override reported as applied |
| An overridden run never counted as exhausted by C2 | a run exhausted by its own cap only |
| Budget merge nested inside `runConfig`'s runtime-mode branch | a recovered facade with no `runtime` field |
| Persisted budget discarded when the facade has no `runtime` | the same check, on both surfaces |

Reviewers independently planted the resolve-and-assign fake the contract names as cheapest; it
fires AC7 and AC8 every time, and passes AC6, exactly as the frozen contract predicts.

One coordinator mutation survived and the mutation was at fault, not the test: it left the
integrality check in place, which rejected the corrupt string on its own. Removing the guard
entirely killed the test. Recorded because a surviving mutant read at face value would have been
taken as a weak test.

## Gates

`pnpm check` (tsc, eslint, dependency-cruiser, vitest) and `pnpm build` on Node 24.20.0:
680 tests across 73 files, build clean. Reproduced independently by both reviewers.

`src/verify/sidecar.test.ts` and `src/engine/candidate-comparing.test.ts` seed the same python
venv and collide on a cold worktree. Environmental; reseeding the venv clears it.

## Test-strength notes

Recorded rather than fixed, because none of them is a way a test passes while the code is wrong
today:

- The two leak checks never drive the *overridden* run through the guard, so resolve-and-assign
  survives them. AC7 and AC8 carry that work, which is what the contract assigns them.
- AC12's wall-clock half has no assertion. It holds structurally: the override helper spreads the
  configured budget and replaces only two fields, and both deadline sites still read the engine's
  shared config.
- AC17 observes `ctx.config` rather than a broker throw in the window before metadata exists. A
  resolver that fed `runConfig` but not the tracker would pass it; AC1 fails on that.
- `!Number.isFinite` in the persisted-budget guard is unreachable for values that survive
  `JSON.parse`, which rejects `NaN` and `Infinity` outright. Kept as depth, not live coverage.
  The live entry path is a separate matter and is pinned: `optionalNumber` rejects `Infinity`
  with `CONFIG_ERROR` before the budget validator runs, which matters because the budget
  validator itself would have admitted it — `Infinity > 0` is true.
- AC3 shows both flags with two runs rather than one run crossing both thresholds, since the
  first throw ends a run's usefulness as a probe.
- The contract's static pin is a regex, so `Object.assign` into the shared limits, or a cast
  before the assignment, slips past it. Recorded against finding 22, which is about exactly this.
  Unrestored, such a fake still dies on the shared-limits check.
- The `null` leg of the corrupt-budget loop is redundant: it dies by the same clause as the
  non-numeric leg. The other legs each pin a distinct clause of the guard.
- **The USD boundary pin is exact from above and about 4% of the cap loose from below.** It reads
  as "only the spend that meets the cap may refuse", and from above that is exact: refusals at
  exactly the cap kill `>`-for-`>=` and any threshold above it. From below it samples spend at
  $1.20 and $1.80 against $1.25, so any effective threshold inside `($1.20, $1.25]` passes.
  Measured by Claude in round 21: the `−$0.05` mutant dies and the `−$0.04` mutant survives. A
  guard refusing at $1.21 against a $1.25 cap does throw below the cap, contrary to AC1/AC2, and no
  finite set of discrete spend samples can close a continuous threshold — this is narrowable but
  not closable, so it was recorded rather than chased with a contrived per-call cost. Read the pin
  as "within 4% of the cap", not "at the cap". The token dimension has no such gap: token spends
  and token budgets are both integers.
- Resolved in round 20, and the way it was nearly missed is the point. Both reviewers looked at the
  same asymmetry — the cross-surface check compared `maxRunTokens` and matched USD and
  `maxTaskTokens` against literals — and reached opposite verdicts. Grok built the crude mutant
  (the guard ignores the USD override), watched it die on an existing enforcement pin, and
  classified the asymmetry as a coverage note. The coordinator distrusted that and built a sharper
  one: the guard keeps the configured USD cap *whenever that cap is finite*. It also died, on the
  finite-USD replacement check. Two mutations, two deaths, and the conclusion drawn from them was
  wrong. Claude conditioned its mutant on the state of a dimension the mutant does not touch — the
  guard keeps the configured USD cap whenever the *token* cap is finite — and it survived all 670
  tests. Every USD enforcement fixture configures `maxRunTokens: null`, and the one fixture pairing
  a partial override with a fully finite configuration is unpriced, so the guard's USD dimension
  cannot bind there at all. The transferable lesson: the coordinator swept the cell along the
  dimension under test and called the family closed, which is the same error as closing one cell of
  the task-identity family three rounds running, one level up. **The state of the dimensions a
  divergence does not touch is itself an axis.**
- Replacing `??` with `||` in the overlay survives the suite and is equivalent under a tested
  invariant: zero cannot reach the overlay, because both the entry-point validator and the
  persisted-budget guard reject it and both refusals are themselves pinned. Recorded as
  equivalence with the invariant named, not as a gap — the distinction from the `1e999` episode
  is that this claim rests on a checked invariant rather than on a false fact about the language.

## What the 955 lines are actually worth

Reviewed at round 24, statically. Deliberately **not** re-derived with a mutation battery across
all 36 checks: that audit would cost more than the answer is worth, and running it would be the
same error one level up.

Roughly seventeen checks carry the frozen contract directly — the override binds in each
dimension, isolation between runs, the daemon-wide limits untouched, the static pin, validation,
restart, registration before metadata, both surfaces agreeing, and the corrupt-facade fallback
that was a real production fix. Those are not in question.

A second group is narrower but earned its place by finding something a competent implementer
could have got wrong. The task-identity pair is the clearest: production always names a task and
the entire suite called the broker without one, so the hard cap could have failed to bind on
precisely the path that spends the budget. The runtime-mode check is the second: every C2 sample
had been taken in `"off"` while `auto` is what production defaults to. The positive-exhaustion
check is the third, since stopping a run is what the sample exists for and every other check
required the exhausted set to be empty.

The tail — the fractional-versus-finite crossings, the recovered-run duplicates of live checks,
the equal-override report — is narrow, and two or three of those checks pin a clause another
check already pins.

**The important conclusion is not that some tests should be deleted.** It is that a whole family
of them exists only because the production code merges the overrides twice, once for the tracker
(`src/daemon/composition.ts:155`) and once for C2 (`src/daemon/service.ts:373`). Every "the two
surfaces can disagree" check — and that is about a third of this file — is defending a seam that
should not exist. Both reviewers said so independently. A single resolver returning the merged
`BudgetLimits` to both consumers would make that entire class of divergence **inexpressible**
rather than merely tested, and would retire those checks with it. That is a production change and
therefore belongs to whichever item next touches this seam, not to this contract; it is recorded
below. Pruning the tests without collapsing the merge would remove the evidence and keep the
hazard.

## To record at acceptance, outside this contract

Acceptance is hand-written onto `phase-c-collab` rather than merged from the candidate branch, so
the candidate's own ledger edit does not carry itself over. Both entries below must be written by
hand into `docs/ledger/B-selfhost-remaining.md` at acceptance:

- **Item 12 gains the durability half of the cap** (already written on the candidate branch, at
  both reviewers' request, while drawing this contract's scope boundary). Crash recovery loses
  accumulated *spend*, which makes a hard cap non-durable across a restart:
  `ModelBroker.restore(runId)` (`src/broker/broker.ts:274-280`) folds a run's `model.call` events
  back into the tracker but has no production caller — every call site is a test. `DaemonService`
  recovery is `engine.recover()` alone (`src/daemon/service.ts:95`). A restarted daemon therefore
  believes every run has spent nothing, and a run may spend its whole budget again after each
  restart. This item makes a run's *limits* survive a restart and deliberately stops there: the
  two are independent, since limits without spend still bind, and spend without limits binds the
  wrong number.
- **Model capability probes bypass the budget guard entirely** (raised by Claude in round 17, base
  behaviour, untouched by this change and outside the contract). The probes receive the provider
  adapter directly and never pass through the guard, so "the cap binds" is true for phase-driver
  model calls and false for probes. To be filed as a new finding.
- **One resolution of the overrides, but the merge runs twice** (raised by Claude in round 21).
  MC7's "single resolution" is satisfied — `runBudget` is the one lookup — but
  `applyRunBudgetOverrides` is then applied independently at `src/daemon/composition.ts:155` for
  the tracker and `src/daemon/service.ts:373` for C2. That duplication is precisely what makes a
  one-sided merge expressible, and four of this task's survivable mutants lived in it. A shared
  resolver returning the already-merged `BudgetLimits` would make the whole class inexpressible
  rather than merely tested. Not a defect and not in this contract — a design note for whichever
  item next touches this seam.

## Process note

Reviewer isolation is now per worktree, adopted during B-selfhost-7. Reviewers mutate sources
and restore with `git checkout --`, so two of them in one worktree can overwrite each other's
probes. The failure direction is a spurious failure rather than a spurious pass, so no accepted
item is in doubt.

Running the reviewers sequentially changes the round protocol, and round 23 got it wrong: Grok
FAILed, the coordinator fixed and committed immediately, and Claude never saw that commit at all.
**A round is both reviewers on the same commit.** From round 24, fixes are held until both have
reported on the commit under review, even when the first reviewer's verdict already guarantees
the round is not clean — the second reviewer's findings on that commit are worth more than the
few minutes saved, and the whole task's evidence is that the two find different things.

From round 23 the two reviewers run **one at a time** rather than concurrently, and the
coordinator runs no gate of its own while a reviewer is working: three uncapped `vitest` runs at
once — `pool: "forks"`, one fork per core by default — made the user's machine unusable. Gate
runs are now `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm vitest run --maxWorkers=2`,
which is also *faster* in wall clock than the uncapped run was under contention. Claude
independently reported the same effect from the other side: under load a clean tree failed 13
tests, and it re-confirmed every survivor in a quiet window. Load produces spurious failures, not
spurious passes, so nothing already banked is in doubt — but a reviewer that reads a
load-induced failure as a finding wastes a round.

A third instance of the task's recurring lesson, this time from the coordinator's tooling: the
mutation scripts lived in `/tmp`, which was cleaned between rounds. A batch re-verification of
nine mutants then reported all nine green — which reads exactly like nine surviving mutants, when
in fact no mutation had been applied at all. The run was discarded. **The number of applied
mutation lines is now printed in the same command that runs the tests**, alongside the earlier
rule that a mutation must be verified to produce the wrong behaviour it claims.
