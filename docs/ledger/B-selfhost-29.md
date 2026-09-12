# B-selfhost-29 — run economics as a first-class record

**Status:** DRAFT, revision 1. Not frozen. Base `89c99aa`.
**Finding:** item **29** in `docs/ledger/B-selfhost-remaining.md`.

## Why this is scheduled ahead of items 11–15

Finding 29 was produced by hand-summing the event log in a throwaway script. That is the whole
problem. The tool spends tokens across three consumer classes and has no record of how much each
one costs, so every optimisation claim it makes about itself is unfalsifiable.

The measurement that prompted this: over the six real runs in the store, the review swarm is
**78.7%** of a run's tokens, the worker loop **17.2%**, the council **4.1%**. Item 18 — fifteen
review rounds, accepted — could at its absolute ceiling remove 10.7% and actually nets 5.8%, *if*
an untested assumption about turn counts holds. The plan's remaining order was set by finding
number, not by where the tokens are, and nothing in it addresses the 78.7%.

The decision taken was to make the economics measurable **before** optimising anything further,
rather than repeat at larger scale the mistake of optimising against a model instead of a
measurement.

## The defect

There is no per-run economics record. `tokenUsage` (`src/observe/project.ts:452`) sums every
`model.call` into one number with no breakdown. `BudgetTracker.snapshot` returns
`{ runUsd, runTokens, perTask, unknownCostCalls }` — a total and a per-task total, with no split by
role or purpose, and it is **live state**, so it says nothing about a run that has already
finished. Neither can answer "what did this run spend on reviewing versus on working", and neither
pairs spend with outcome, so "cost per completed task" is not computable at all.

## What the recorded events actually carry

Verified against the store, and this is where a naive implementation fails:

- `model.call` payload has `role`, `purpose`, `taskId`, `ok`, `attempts`, `latencyMs`, `model`,
  `runUsdSoFar`, and `usage` as `{ inputTokens, outputTokens, costUsd }`. `runId` is on the event.
- **`payload.metadata` is `null` on every recorded event.** The `CompletionRequest.metadata` that
  carries role and purpose into the broker is not what the event persists; the broker lifts those
  fields onto the payload. An implementation reading `metadata.role` compiles, runs, and reports
  **zeros for everything** — which is exactly what the first attempt at finding 29's measurement
  did before it was corrected.
- **`usage.costUsd` is `null` on every call in the corpus**, because these were free models. So a
  dollar figure is not derivable from this corpus, and an implementation that sums the nulls as
  zero reports **$0.00 for 1,060,632 tokens**.

## MISSION_CRITICAL invariants

**MC1.** The report is **derived from the event log**, not accumulated live. It must produce a
complete report for a run that finished before this change existed, because the six runs in the
store are the only corpus there is and none of them was instrumented.

**MC2.** Tokens are broken down by **role**, by **purpose**, and by **task**, and each breakdown
sums exactly to the run total. No call carrying `usage` may be omitted from any breakdown, and no
call may be counted twice.

**MC3.** Calls that failed are counted and separable. `ok: false` calls consumed tokens; a retry's
tokens are spent tokens. Reporting only successful calls understates spend by exactly the amount
that retry storms cost, which is the thing most worth seeing.

**MC4.** **A dollar figure is reported only when every contributing call carries a non-null
`costUsd`.** Otherwise the report states the amount as unknown, together with how many calls lack
cost. Summing nulls as zero and presenting the result as a total is forbidden — on the present
corpus that produces `$0.00`, and a number that looks like a total but is not is the defect class
this programme has hit most often.

**MC5.** Spend is paired with **outcome**: the run's terminal phase, and each task's final state.
Cost without outcome cannot answer cost-per-completed-task, which is the question finding 29 could
not answer.

**MC6.** Deterministic and pure. The same events produce the same report, independent of the order
they are handed to the projection, ordered by `seq` internally. No clock.

**MC7.** The projection reads `payload.role`, `payload.purpose`, `payload.taskId` and
`payload.usage` — the fields the events actually carry. It must not depend on `payload.metadata`,
which is `null` in every recorded event.

## PHASE_REQUIRED

**PR1.** Reachable from production, not only from its own suite: a CLI subcommand renders the
report for a run id. Item 19 was accepted for exactly the defect of a tested module with no
production caller, and this must not repeat it.

**PR2.** At least one acceptance check must fail on the unmodified tree.

**PR3.** The existing suite passes unchanged. This item adds a projection and a command; it changes
no engine behaviour and must not.

## Acceptance checks

**AC1.** A fixture event log with known usage across three roles (`worker`, `reviewer`, a council
role), two purposes within one role, and two task ids. Assert the by-role, by-purpose and by-task
breakdowns against hand-written expected numbers, and assert each breakdown sums to the run total.
The expectations must be written literally, not computed by the code under test.

**AC2.** A call with `ok: false` and non-null usage is included in the total and appears in the
failed-call figure. A fixture with one failed call among three asserts both.

**AC3.** With one `costUsd` null among several present, the dollar amount is reported as unknown
with a count of 1, and is **not** a partial sum. Fails on any implementation that adds what it has.

**AC4.** With every `costUsd` present, the dollar amount is their exact sum.

**AC5.** Outcome pairing: the report carries the run's terminal phase and each task's final state,
asserted against a fixture whose run is `NEEDS_HUMAN` with one task complete and one not.

**AC6.** Determinism: the same events in reverse insertion order produce an identical report.

**AC7.** An event whose `payload.metadata` is `null` but whose `payload.role` is set is attributed
to that role. This is the corpus's actual shape and the check that kills the `metadata.role`
reading.

**AC8.** The CLI subcommand prints the report for a run id, and exits non-zero with a diagnostic for
an unknown run id.

**AC9.** A `model.call` event with no `usage` at all is ignored without throwing, and does not
appear as a zero-token row.

## Named fakes — each must be planted and killed

| Fake | Expected killer |
| --- | --- |
| The projection reads `payload.metadata.role` | AC7, and AC1's role breakdown |
| Nulls summed as zero and labelled a total | AC3 |
| Only `ok: true` calls counted | AC2 |
| The by-role and by-task breakdowns computed from different call sets | AC1's sum-to-total clauses |
| The report accumulated live rather than derived from events | MC1, via a fixture run with no live tracker |
| Outcome omitted, or taken from the newest event rather than the run record | AC5 |
| Events sorted by insertion order rather than `seq` | AC6 |
| A call counted once per breakdown but twice in the total | AC1's sums |
| The CLI command exists but renders nothing | AC8 |
| An event without `usage` rendered as a zero row | AC9 |

## Out of scope

- **Changing anything about what the tool spends.** This item measures; it does not optimise. Any
  reduction in the review swarm's 78.7% is a separate item that this one exists to make checkable.
- Dollar pricing tables, or inferring cost for models that do not report it. MC4 requires saying
  "unknown", not guessing.
- The A/B experiment on the fixture corpus. That is the next step and it uses this report; it is not
  this contract.
- Retrofitting `costUsd` onto the six recorded runs. It was never returned by those providers.

## Anti-fake notes for the reviewer

The corpus's real shape is the trap here. `payload.metadata` is `null` and `usage.costUsd` is
`null` on **every** recorded call, so two separate implementations that look correct report zeros
and `$0.00` respectively, and both would pass any check built on a synthetic fixture that fills
those fields in. Check that the fixtures reproduce the corpus's nulls rather than an idealised
event.

No acceptance check may assert anything about *why* the review swarm is expensive, or that it
should be cheaper. The 78.7% is an input to scheduling, not a claim this item verifies.
