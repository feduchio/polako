# P2 block acceptance

| Field | Value |
|---|---|
| Entry base | HOST `f9195d1` (accepted P1 block) |
| Block candidate | `bc8c6c3`, reviewed by GPT-5.6-sol and then Grok |
| Plan | `docs/PLAN.md` §4 |
| Gate | Node 24.20.0; 93 files; 1,022 tests; exit 0 |
| Production change across the whole block | **none** — `git diff f9195d1..bc8c6c3 -- src/` is empty |

## The three verdicts

| Item | Verdict | Accepted at |
|---|---|---|
| P2.1 post-validation yield | `inconclusive — no post-plumbing production findings` | `0d80cb0` |
| P2.2 non-inferiority baseline | `inconclusive — insufficient replay corpus` | `d2c9588` |
| P2.3 discovery smoke on a second repository | discovery correct; **baselining records something untrue** — finding 54 | `25eca7d` |

## Exit checklist — `docs/PLAN.md` §4

- **P2.1's report exists.** `docs/ledger/P2.1-run.md`, with the read-only instrument
  `scripts/p2-1-yield.mjs`, its 52-assertion `--selfcheck` and a fourteen-row mutation table.
- **`docs/ledger/replay-set.md` exists**, with four admitted entries, the full disposition of all
  sixteen `src/e2e/` test results, the historical `INTEGRATING` tasks, and the two bars.
- **The smoke record exists.** `docs/ledger/P2.3-run.md`, with the verbatim phase sequence, the
  quoted baseline, and the discovered profile checked field by field.

## What the block establishes, and it is not what the plan expected

**Every gate P2 exists to feed is `inconclusive`, and each for a different reason.** Note what this
does and does not say about the items: P2.1 and P2.2 returned `inconclusive` verdicts, while **P2.3
succeeded** — it produced the smoke record §4 asked for and found a defect doing so. What is
`inconclusive` is the three P3 gates, not the three P2 items.

| P3 item | Blocked by | Why |
|---|---|---|
| P3.1 drop the weakest axis | P2.1 | no post-plumbing finding has ever been recorded, so there is no post-validation yield to rank axes by. P1.4 supplies no tiebreaker either: no axis had a unique hit |
| P3.2 adversarial axis as falsifier | P2.2, twice | the replay floor is unmet, and even a met floor could not discharge it, because P3.2 changes what the reviewer is asked and the corpus is frozen completions |
| P3.3 fail-to-pass on the corpus | P2.2 | the floor is unmet and MC4 makes every dependent gate `inconclusive`. Its own diff would probably not have tripped the second bar, which is a distinction a plan revision needs |

**The consequence for what may ship.** `docs/PLAN.md` §1's quality-coupling clause is binding while
the quality gate is not `pass`: no cost-reducing production behaviour may be enabled by default and
no existing path may be removed. So `review.skipAdversarialWhenClean` stays `false`, P1.5's
reasoning default stays `false`, and P3 cannot remove anything even if its mechanisms land behind
flags. P1's cost mechanisms remain mechanisms.

**The three outcomes are separate, and an earlier version of this record wrongly made them one.**
It claimed a single bottleneck — that the store has never held a post-plumbing review round — and
the block reviewer rejected that synthesis. Each needs a different thing, and pretending otherwise
would mislead whoever tries to unblock P3:

| Item | What it is actually blocked by | What would unblock it |
|---|---|---|
| P2.1 | no post-plumbing review execution exists: 11 of 17 runs began after finding 41's fix and none reached `REVIEWING` | **one** completed review round on the current tree. A round returning no findings still counts; it is a measured zero |
| P2.2 | the corpus is four committed scripted scenarios of one mission on one fixture, against a floor of five | distinct scenarios, or a second fixture, or a plan revision that decides what "evaluable" requires. More store review rounds are **not sufficient** on their own, but they are not excluded either: MC2 admits a historical store task when it is replayable, and all four currently in the store fail that test only because no replay path consumes the recorded completions. MC5's first bar points the other way — it bars *scripted* entries from §1's cost arm, not store-derived entries from this set |
| P2.3 | nothing — it **succeeded** | it is not an inconclusive verdict at all: it did what it set out to do and found finding 54 doing it |

The one thing they do share is context rather than cause: the system has completed very little on
the current tree, and each item ran into a different consequence of that.

## Finding 54, and why it outranks the two inconclusive verdicts

The block's one new defect is the only one that blocks something outside this document.
`runChecks` persists an environment failure as the project's check status
(`docs/ledger/B-selfhost-remaining.md` finding 54). On the first external project ever targeted,
that produced a baseline saying `test`, `lint` and `build` all fail on a repository whose suite
passes.

Its consequence is code-traced: `compareToBaseline` treats a fail-to-fail check with an equal
`failureFingerprint` as unchanged, and `runIndependentGates` reduces the verdict to one boolean
that mandatory-check failures do not enter, so a candidate reproducing those failures shows no
regression and the gate passes provided `silencing` and `acceptanceProblems` are empty. The remedy
has two halves and the refuse-to-record half is not optional, because an install step still leaves
the hole open whenever install fails or is skipped.

**Fable D1 cannot mean anything until that is fixed.** P2.3 reduced the external run to a two-phase
smoke, and the smoke found the reason the full run was never safe to schedule.

## Review

Under process v3 each item ran GPT-5.6-sol as the entry gate to a clean verdict, then Grok on the
same commit, with any Grok finding returning to GPT first. Rounds: P2.1 eight, P2.2 eight, P2.3
nine.

**The second lane changed the top-line claim of all three items, and in two of them it changed the
recorded result.** The distinction matters and the block reviewer insisted on it: in P2.1 every
number and the verdict itself were unaffected — the fix changed what the instrument would say about
the *next* eligible execution, not what it said about this store. In P2.2 the verdict string
changed. In P2.3 the named defect changed and with it what a fix must do. In every case the entry
gate had made the record internally consistent first, and the second lane found that the top-line
named the wrong object:

| Item | What the entry gate found | What the second lane found |
|---|---|---|
| P2.1 | fifteen defects over five rounds: eligibility fallback, timestamp classification, `RAW` triage, fixed-axis verdict, string token totals, prototype-colliding axis names | the MC3 verdict fired on zero *findings* rather than zero eligible *executions*, so the first real post-plumbing round would have been reported as an absence of rows. The current numbers and verdict were unaffected; what changed is the semantics for the next measurement |
| P2.2 | every arithmetic defect, and it adjudicated and upheld the verdict twice when asked | the count was four, not five, because a two-arm `it.each` is one committed scenario — and "floor met" was never one of MC4's two authorised strings |
| P2.3 | the rendered phase chain, the unaccounted probe attempts, the registration claim, and the gate consequence it insisted on tracing | the broken object was the persisted *meaning*, not the missing install; the isolation is the design, so a fix that only installs leaves the hole open |

The order in process v3 is what produced this. The second lane arrives at a commit whose details
are already consistent, which is when a wrong top-line claim is most visible and has nothing left
to hide behind. Recorded as evidence for the ordering, not as a comment on either lane's diligence:
the entry gate found fifteen real defects in P2.1 alone, and the second lane's findings were each
one commit's worth of work.

## Scope boundary

P2 is accepted. P3 has not started, and all three of its items are `inconclusive` before it does.
Phase C is not accepted; no `phase-c-accepted` tag is created. Phase D remains out of scope.
Finding 54 is recorded, not repaired.

## Gate

`pnpm typecheck && pnpm lint && pnpm deps:check && pnpm vitest run --maxWorkers=2`

Result at `bc8c6c3`: 93 test files, 1,022 tests, exit 0.
