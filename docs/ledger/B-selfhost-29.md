# B-selfhost-29 — run economics as a first-class record

**Status:** DRAFT, revision 7. Not frozen. Implementation base `93bd7b6`.
Revisions 1–6 were corrected by five contract reviews and the prompt/runtime audit. See *Revision
history*. The contract now defines each logical call, finding outcome, payload shape and denominator.
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
- **The `metadata` key is ABSENT from every recorded payload** — all 324 `model.call` events, and
  all 6,964 events. Not present-and-null: absent. The `CompletionRequest.metadata` that carries
  role and purpose into the broker is not what the event persists; the broker lifts those fields
  onto the payload. An implementation reading `metadata.role` compiles, runs, and reports **zeros
  for everything**, which is exactly what the first attempt at finding 29's measurement did before
  it was corrected.
- **`usage.costUsd` has three states, not one.** Of the 324 `model.call` events: **228 carry
  `costUsd: 0`** (OpenRouter `:free` successes), **11 carry `costUsd: null`** (Gemini — ten planner
  calls and one judge call), and **85 carry `usage: null`** — the key is present and explicitly null, written that way by
  `src/broker/broker.ts:260`, and every one of those calls is `ok: false` (rate limits, 400s,
  timeouts). Revision 1 claimed `costUsd` was null everywhere; revision 2 then described these 85 as
  having no `usage` key. Both were wrong, and an implementation branching on key *presence* would
  pass a check written from either description and fail on every real failure. **96 of 324 calls
  therefore have no price**: 11 null-priced successes and 85 failures.
- **28 usage-bearing calls carry `taskId: null`** — 43,097 tokens, which is 100% of council spend.
  Four of the six runs have **no rows in `tasks` at all**, so for those runs a by-task breakdown
  keyed only on task ids is empty while the run total is not zero.
- **`run.phase_changed` carries only `{ run: { phase, … } }`. There is no `to` field.** Fixtures
  elsewhere in the suite do set `to`, so an outcome fold written against those fixtures passes its
  test and returns nothing on all six real runs.
- **Prior art with both defects.** `foldModelCallUsage` (`src/convergence/pathology/budget.ts:47`)
  already folds usage from the event log, orders by `seq`, and deduplicates by `callId` so a retried
  call is counted once. It also partial-sums USD and drops `taskId: null` from its per-task map —
  the two mistakes this contract must not repeat. It is not reusable here: `src/cli/` may not import
  `src/convergence/`.

## MISSION_CRITICAL invariants

**MC1.** The report is **derived from the event log**, not accumulated live. It must produce a
complete report for a run that finished before this change existed, because the six runs in the
store are the only corpus there is and none of them was instrumented.

**MC2.** Tokens are broken down by **role**, by **purpose**, and by **task**, **each with input and
output kept apart**, and each breakdown sums exactly to the run total.

Input and output are not decoration. The measurement this item exists to serve is that the review
swarm spends 138,414 input tokens against 696,221 output — **5.0× more generation than context** —
while the worker's ratio is 0.08×. Those two facts point at opposite remedies, and a report carrying
only combined totals cannot tell them apart, so it could not support the decision it is built for.
Revision 2 specified combined totals only. On this corpus no usage-bearing call has a null `role` or
`purpose`, so those two axes need no residual bucket; only `task` does. No usage-bearing call may be
omitted from any breakdown or counted twice.

A logical `model.call` group is identified by a non-empty `payload.callId`, falling back to
`event.id` when `callId` is absent. Two real events lack `callId`; one is usage-bearing and requires
the fallback. Within a group ordered by `(seq, id)`, the first event carrying a usage object is the
usage representative; if none carries usage, the first event is the null-usage representative.
Thus an earlier `usage: null` duplicate cannot suppress later recorded spend. A disagreement among
usage-bearing duplicates on tokens, cost, role, purpose or task sets the report-level boolean
`usageConflict: true`.

The by-task breakdown therefore needs an explicit **`unassigned`** bucket for usage-bearing calls
whose `taskId` is null. Without it the clause is unsatisfiable on the only corpus that exists: 28
such calls carry 43,097 tokens, all of the council's spend, and four of six runs would report an
empty by-task map against a non-zero total.

**MC3.** Failure is visible. **Three counts**, because the corpus makes them three different
questions: logical calls represented by `ok: false`; logical calls whose representative `usage` is
null; and logical calls whose representative usage is present but whose `costUsd` is null, whether
that call succeeded or failed. The third is the one revision 2 had no home for, and it is the only
reason this corpus's dollar figure is unknown rather than zero. Alongside them, the tokens of any
failed call that does carry usage. A null-usage duplicate in a group that has a usage-bearing
representative does not increment the null-usage count or make MC4's dollar amount unknown.

All 85 failed calls in the corpus have `usage: null`, so their token cost is genuinely unrecorded
and no projection can recover it. What is recoverable, and what a retry storm actually shows up as,
is the count. Revision 1 asserted that failed calls "consumed tokens" as if the corpus recorded
them; it does not.

**MC4.** **A dollar figure is reported only when every contributing call has cost data** — a
non-null `costUsd` on a present `usage` object. If any contributing call has a null `costUsd` or a null
`usage`, the amount is reported as **unknown**, with the disjoint **null-cost count and null-usage
count** from MC3 attached — 11 and 85 respectively on this corpus; together they are the 96 calls
with no price. Revision 2 attached "both counts from MC3" while MC3 counted neither of the two that
matter here. "Contributing call" means the logical representative selected by MC2.

A total of `$0.00` is legitimate when every contributing call priced itself at zero, which is what
a free model does and what 228 of these calls did. The forbidden thing is narrower and is what the
tree does today: `usdUsage` (`src/observe/project.ts:468`) adds the 228 zeros, silently skips the
11 nulls and the 85 missing, and returns `0` — a figure indistinguishable from "this run was free"
when the truth is "96 of 324 calls have no price". On this corpus the honest answer is **unknown**.

**MC5a — cycles and yield.** The report states **how many cycles ran and what they produced**.
One review execution is one unique `payload.execution.id` seen in `review.started` or
`review.finished`; a later event by `(seq, id)` for the same execution id replaces its earlier
state. Requested executions are that set, including starts with no finish. A completed execution is
one whose latest payload has `execution.completed === true`. Round and axis come from
`payload.execution.roundIndex` and `payload.execution.axis`. Raw findings are unique
`finding.raised.payload.finding.id` values. A finding's validation outcome is the latest
`finding.validated.payload.validation.verdict` by `(seq, id)`, joined through
`payload.validation.findingId`. Valid findings are distinct finding ids whose latest verdict is
`VALID`; a later `REJECTED` verdict removes one from that count. A raw finding with no validation,
including one later marked `DUPLICATE` or `NOTED`, is never valid. Axis comes from
`payload.finding.axis`.

Candidate activity per task is two explicit values derived from unique
`candidate.created.payload.candidate.id` values: `candidateCount` and the maximum
`payload.candidate.attempt`.

Every incomplete review is grouped mechanically into exactly one stable cause:
`rate_limit`, `schema`, `bad_request`, `timeout`, or `other`. The classifier uses persisted error
text and must not call a model. Predicates are ordered and exclusive:

1. `rate.?limit|\b429\b` → `rate_limit`;
2. `timeout|timed out` → `timeout`;
3. `bad request|\b400\b` → `bad_request`;
4. `review response must contain a findings array`, `Expected ... after array element ... JSON`,
   or Zod `invalid_type|invalid_value` → `schema`;
5. an orphaned start with no finish/error, an empty error, or unmatched text → `other`.

Ordering matters even though `\b400\b` correctly ignores digits inside real reset timestamps. The
acceptance fixture deliberately combines a `429` rate-limit signal with a separate word-boundary
provider code `400`, so swapping rules 1 and 3 is observable. This makes losses visible at each
transition:

`review requested → review completed → raw finding raised → finding validated`.

The old corpus makes the stakes concrete: 2,600 review executions, 18 completed, zero findings,
696,221 reviewer output tokens. That corpus predates the finding-41 parser repair, so the report
must present it as history, not infer current reviewer quality from it.

**MC5b — productivity, as ratios the reader can check.** Per axis and per run:

- completion rate = completed executions / requested executions;
- raw yield = raw findings / completed executions; a completed clean axis is `0 / n = 0`;
- validation yield = valid findings / raw findings;
- reviewer output tokens per raw finding and per valid finding.

Every zero-denominator ratio is **undefined**, never zero, infinity, or an invented sentinel. These
are diagnostic ratios, not claims that a low-yield reviewer is bad: clean code can correctly yield
no finding.

**MC5.** Spend is paired with **outcome**: the run's **latest recorded phase together with whether
that phase is terminal**, and each task's final state. Cost without outcome cannot answer
cost-per-completed-task, which is the question finding 29 could not answer.

"Terminal phase" alone is unsatisfiable: one of the six runs sits in `INTERPRETING_MISSION`, which is
not terminal, and PR1 accepts any run id. A report that demands a terminal phase either fails on that
run or invents one.

**MC6.** Deterministic and pure. The same events produce the same report, independent of the order
they are handed to the projection, ordered by `seq` internally, with `id` breaking a `seq` tie. No
clock. Two usage-bearing events sharing a `callId` are one spend record: the first by that ordering
wins, and a disagreement on tokens, cost, role, purpose or task sets `usageConflict: true` rather
than silently resolving it. Null-usage duplicates are handled by MC2's representative rule.

**MC7.** The projection reads `payload.role`, `payload.purpose`, `payload.taskId` and
`payload.usage` — the fields the events actually carry. It must not depend on `payload.metadata`,
whose key is **absent** from every recorded payload.

Reviewer token usage is attributed to an axis only from `payload.purpose === "review_<axis>"`.
`model.call` carries no axis or review-execution id; task id is shared across axes. An unmatched
reviewer purpose remains under an explicit `unassigned` axis bucket rather than disappearing.

**MC8.** The outcome fold reads the snapshots as the store records them: the run's phase from
`payload.run.phase` on `run.phase_changed`, and a task's state from the task snapshot on
`task.created` and `task.state_changed`. It may not depend on a `payload.to` field, which other
fixtures in the suite carry and no recorded event does.

For both run and task fixtures, at least one state-change event contains only its snapshot and no
`from` or `to`; 13 of 21 recorded task changes have exactly that shape.

## PHASE_REQUIRED

**PR1.** Reachable from production, not only from its own suite: the CLI subcommand **`cost`**
renders the report for a run id. Item 19 was accepted for exactly the defect of a tested module
with no production caller, and this must not repeat it.

The fold must therefore be **store-free**, because `frontends-talk-to-daemon-only` forbids
`src/cli/` from importing `store`, `broker`, `convergence`, `engine`, `providers` and `project`. It
belongs in `src/observe/`, which the CLI already imports and which depends only on `domain/`. It may
not import `foldModelCallUsage`.

**PR2.** At least one acceptance check must fail on the unmodified tree.

**PR3.** The existing suite passes unchanged. This item adds a projection and a command; it changes
no engine behaviour and must not.

## Acceptance checks

**AC1.** A fixture event log with known usage across three roles (`worker`, `reviewer`, a council
role), two purposes within one role, **two task ids and one usage-bearing call with `taskId: null`**,
one retried call appearing as two disagreeing usage-bearing events sharing a `callId`, one earlier
`usage: null` event sharing that id, and two usage-bearing events with no `callId`. Assert the
by-role, by-purpose and by-task breakdowns against hand-written expected numbers, assert the
`unassigned` bucket holds the null-task call, assert the first usage-bearing duplicate wins and
raises the conflict flag, assert the null-usage event does not suppress it, assert the two
missing-`callId` events remain separate, and assert each breakdown sums to the run total. **Assert
input and output separately in every breakdown**, with a role whose ratio is output-heavy and one
whose ratio is input-heavy, so a report that folds them together fails. The expectations must be
written literally, not computed by the code under test. Also assert that the earlier null-usage
duplicate does not increment `nullUsageCalls` or make an otherwise fully priced report unknown.

Without the null-task call this check is the one revision 1 shipped: green on a fixture, and wrong
on every real run.

**AC2.** Two fixtures. One `ok: false` call **with** usage is included in the total and in the
failed-call count — synthetic, because the corpus has no such call. One `ok: false` call with
**`usage: null`** raises the failed-call count and the null-usage count, and adds nothing to the
total. Assert all four numbers.

**AC3.** Three cost cases, which is what it takes to separate "free" from "unpriced":
  - every call `costUsd: 0` → the amount is **$0.00**, reported as known;
  - one `costUsd: null` among several priced → **unknown**, with a count of 1;
  - one call with `usage: null` among several priced → **unknown**, with a null-usage count of 1.

Assert the two counts as distinct fields: a null-priced success and a null-usage failure are
different facts and revision 2 had a home for neither. Repeat the null-price case with `ok: false`
and a present usage object; it still increments `nullCostCalls`.

The first case forbids treating zero as missing; the second and third forbid the partial sum that
`usdUsage` performs today.

**AC4.** With every `costUsd` present and non-zero, the dollar amount is their exact sum. Use binary
exact fixture values such as `0.125 + 0.25 = 0.375`; no implicit rounding rule is permitted.

**AC5.** Outcome pairing: the report carries the run's latest phase, **whether it is terminal**, and
each task's final state,
asserted against a fixture whose run is `NEEDS_HUMAN` with one task integrated and one not, and
whose `run.phase_changed` payload is shaped **as the store records it** — `{ run: { phase } }`, with
**no `to` field**. A fold reading `payload.to` must fail this check. A second fixture, a run still in
`INTERPRETING_MISSION`, asserts the phase is reported with `terminal: false` rather than omitted or
faked. At least one `task.state_changed` is `{ task: { id, state, ... } }` with no `from` or `to`;
its final state must still be reported.

**AC6.** Determinism: the same events in reverse insertion order produce an identical report. Two
events also share a `seq` and differ in `id`, so replacing the `(seq, id)` ordering with `(seq, ts)`
fails.

**AC7.** An event with **no `metadata` key at all** and `payload.role`, `payload.purpose` and
`payload.taskId` set is attributed to all three. The corpus's payloads omit the key rather than
nulling it, and all three fields must be covered, not only the role. A reviewer event with an
unmatched purpose is placed under the reviewer-axis `unassigned` bucket.

**AC8.** The CLI subcommand prints the report for a run id, and exits non-zero with a diagnostic for
an unknown run id.

**AC9.** A `model.call` event with **`usage: null`** — the key present and explicitly null, which is
what the store writes — contributes nothing to any token breakdown, does not appear as a zero-token
row, raises the null-usage count, and does not throw. A separate case with the `usage` key absent
must behave identically, so neither key-presence branch can pass alone.

**AC10.** Applied to a fixture built from the corpus's exact payload shapes — `metadata` key absent,
`costUsd` zero on some calls and null on others, `usage: null` on a failed call, `taskId` null on the
council call, phase carried under `run` with no `to` — the report's run total equals the hand-written
sum, input and output are separate, the dollar amount is unknown with both counts, and the by-task
breakdown sums to the total via `unassigned`. One check that fails on every mistake this contract was
rejected twice for. Assert the counts literally as `nullCostCalls: 1` and `nullUsageCalls: 1`; the
null-cost count is not their union.

**AC11a.** Cycles and yield: use exact production envelopes:
`review.started|finished.payload.execution`, `finding.raised.payload.finding`, and
`finding.validated.payload.{validation,finding}`. A fixture has two rounds and three axes. Include
one orphaned `review.started`, one completed review that raises two findings, one completed clean
review, and incomplete reviews covering all five causes. The rate-limit error deliberately contains
both a `429` signal and a separate word-boundary provider code `400`, so classifier precedence is
observable; schema errors include the recorded JSON-parse message and one Zod `invalid_value`; the
`other` cases include an orphaned start and an empty error.

The completed execution's `execution.findings` contains the same two raw finding bodies later
persisted as `finding.raised`, so double-counting fails. One finding is validated `UNCERTAIN` then
`VALID`; the other is validated `VALID` then `REJECTED`. Reviewer `model.call` events for all three
axes carry the **same** task id and distinct `purpose: review_<axis>` values with different literal
output-token counts. Include four candidate creations for one task with attempt values 1, 1, 2, 2,
mirroring the real corpus rather than making the two candidate metrics equal.
Assert:

- per-round and per-axis execution totals;
- completed/incomplete totals and all five cause buckets;
- requested counts include the orphaned start exactly once;
- raw yield for the completed clean axis is exactly `0`, while only zero-denominator validation and
  tokens-per-finding ratios are undefined;
- raw and validation yields from unique finding ids and their latest validation verdict, without
  also counting `execution.findings`;
- hand-written output tokens per raw and per valid finding for the productive axis;
- per-axis reviewer output tokens attributed through purpose, not task id;
- `candidateCount: 4` and `maxAttempt: 2` for the candidate task.

The expected figures and cause labels are hand-written literals. They may not be derived through the
classifier or aggregation function under test.

**AC11.** MC1, observed at the seam rather than asserted as a preference. A test persists a
**completed Run row and its historical events**, constructs the production path that `cost` uses
**without any live budget tracker or running daemon engine**, invokes `runCli(["cost", runId])`
through an injected or in-process daemon transport, and asserts the rendered report. It must not
call the process-autostart path. An implementation that consults live state renders nothing or
throws. Revision 2 listed this as a named fake with no acceptance check behind it, which is the same
class of gap this programme has found repeatedly: the fold's own tests and a mocked CLI test can
both be green while production still reads live state.

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
| `taskId: null` calls dropped from the by-task breakdown | AC1's `unassigned` bucket and its sum |
| A retried call counted once per event rather than once per `callId` | AC1's retried-call clause |
| Zero treated as missing, so a free run reports "unknown" | AC3's first case |
| The outcome fold reading `payload.to` | AC5 |
| Input and output folded into one number per row | AC1's separate assertions |
| Branching on the absence of the `usage` key rather than its null value | AC9's two cases |
| A null-priced success counted as a null-usage failure | AC3's distinct counts |
| A non-terminal run given a faked terminal phase, or omitted | AC5's second fixture |
| The report reading live budget state instead of the event log | AC11 |
| Only the role read from the payload, purpose and task from `metadata` | AC7 |
| Every incomplete review grouped as `other` | AC11a's five literal cause buckets |
| Schema failures grouped with provider 400s | AC11a's separate `schema` and `bad_request` buckets |
| Raw findings counted as valid without the latest `finding.validated` verdict | AC11a's validation sequences |
| Zero-findings axis reports zero tokens-per-finding | AC11a's undefined-ratio assertions |
| A rate-limit error containing a separate code `400` classified as `bad_request` | AC11a's collision error |
| `execution.findings` and `finding.raised` both counted as raw findings | AC11a's literal raw count |
| Two missing-`callId` calls merged under one null key | AC1's two-event assertion |
| An early `usage: null` suppresses a later usage-bearing duplicate | AC1's retry fixture |
| Reviewer usage joined to an axis through task id | AC11a's shared-task multi-axis fixture |
| `candidateCount` and `maxAttempt` rendered from one value | AC11a's 4-vs-2 literals |
| Unmatched reviewer purpose dropped instead of assigned | AC7's reviewer-axis `unassigned` bucket |

## Out of scope

- **Changing anything about what the tool spends.** This item measures; it does not optimise. Any
  reduction in the review swarm's 78.7% is a separate item that this one exists to make checkable.
- Dollar pricing tables, or inferring cost for models that do not report it. MC4 requires saying
  "unknown", not guessing.
- The A/B experiment on the fixture corpus. That is the next step and it uses this report; it is not
  this contract.
- Retrofitting `costUsd` onto the six recorded runs. 228 calls priced themselves at zero, 11
  returned no price, and 85 failed before reporting usage; none of that is recoverable now.
- Fixing `usdUsage`'s partial sum or `foldModelCallUsage`'s dropped `taskId`. Both are prior art
  with the defects this contract forbids in the new code, and both are recorded as finding **30**
  rather than changed here, because they have their own callers and their own tests.
- **Printing a single cost-per-completed-task number.** The report must carry per-task spend,
  including `unassigned`, and per-task final state, so the ratio can be computed against an explicit
  definition of "completed". It must not print the ratio itself: `INTEGRATED`, `REJECTED` and
  `CANCELLED` are the domain's terminals while `observe` also treats `DONE` and `GATED` as ends,
  both finished runs in the corpus still have `READY` siblings, and council spend is unattributed to
  any task. A single printed ratio would be exactly the kind of number that looks like an answer and
  is not — which is the defect class this programme has hit most often.

## Revision history

**Revision 6 → 7**, after both Grok and Claude rejected the same commit:

- corrected MC4's disjoint counts to 11 null-cost and 85 null-usage calls; 96 is their union;
- made candidate count and maximum attempt unequal and corpus-shaped (4 versus 2);
- defined completed executions and the exact round/axis fields;
- defined a report-level usage-conflict flag;
- covered null-cost failed calls, `seq` ties, unmatched reviewer purposes and binary-exact USD sums;
- required literal per-axis productivity ratios.

**Revision 5 → 6**, after the Claude contract review:

- reconciled null-usage and usage-bearing duplicates through a logical-call representative rule;
- defined valid findings by their latest validation verdict, including repeated debate validations;
- made classifier precedence observable with a true word-boundary collision;
- added same-task, different-purpose reviewer calls so axis attribution cannot use task id;
- corrected the corpus fact: two events lack `callId`, but only one is usage-bearing;
- defined candidate activity as candidate count plus maximum attempt;
- required completed executions to carry the same findings as `finding.raised`, preventing
  double-counting.

**Revision 4 → 5**, after the Grok contract review:

- resolved the clean-axis contradiction: raw yield is zero; only zero-denominator ratios are
  undefined;
- defined requested executions, orphaned starts, raw-finding identity, validation identity and
  exact production payload envelopes;
- made the five failure causes ordered and exclusive against real error collisions;
- defined missing-`callId`, usage-bearing deduplication and conflict semantics;
- required task snapshots without `payload.to`;
- named the only valid reviewer-axis join, `model.call.payload.purpose`;
- made candidate attempts observable;
- specified the production CLI seam precisely.

**Revision 3 → 4**, after the source sync and prompt/runtime audit:

- the report now separates every communication stage—requested review, completed review, raw
  finding, validation—rather than calling any non-empty model output productive;
- incomplete reviews have five deterministic cause buckets;
- productivity includes completion, raw-yield and validation-yield ratios;
- reviewer output tokens are reported per raw and per valid finding;
- zero-denominator ratios are undefined;
- the stale duplicate revision-1 history was removed.

**Revision 2 → 3**, after a second contract review by a different reviewer, which found five blocking
defects the first review missed. All five upheld:

- **The report could not reproduce the finding it exists to serve.** Revision 2 carried combined
  tokens only, so it could not distinguish the review swarm's 5.0× output-to-input ratio from a
  context problem — and those two point at opposite remedies. Input and output are now separate in
  every breakdown.
- **The 85 failures carry `usage: null`, not an absent key.** My third consecutive mis-description of
  this corpus. An implementation branching on key presence would have passed a check written from
  either of my earlier descriptions and failed on every real failure.
- **MC4's "unknown" attached counts that MC3 did not count.** A successful call with a null
  `costUsd` — the only reason this corpus is unknown rather than zero — had no field. MC3 now has
  three counts.
- **"Terminal phase" was unsatisfiable.** One of the six runs is in `INTERPRETING_MISSION`, and PR1
  accepts any run id, so the report must give the latest phase and say whether it is terminal.
- **MC1 had no acceptance check.** "Derived from the event log, not accumulated live" was listed in
  the named-fakes table with nothing behind it; AC11 now observes it at the production seam.

Corrected in the same pass: the eleven null-priced calls are ten planner and one judge, not eleven
planner; and `callId` conflict resolution is specified rather than left to the implementation.

**Revision 1 → 2**, after the first contract review. Two blocking defects and six corrections, all
upheld:

- **`usage.costUsd` is not null everywhere.** It is zero on 228 calls, null on 11, and `usage` is
  explicitly null on 85. MC4's rationale rested on the false claim, and as written it would
  have forced an all-free run to report `$0.00` as the very number the clause exists to forbid. The
  rule is now about *missing* price, not about zero, and `usdUsage`'s actual behaviour is quoted
  instead of an invented one.
- **MC2 was unsatisfiable on the only corpus.** 28 usage-bearing calls carry `taskId: null` — all
  43,097 council tokens — and four of six runs have no task rows at all, so "each breakdown sums
  exactly to the run total" could not hold. An `unassigned` bucket is now required, and AC1 must
  contain such a call; without it AC1 was green on a fixture and wrong on every real run.
- The `metadata` key is **absent**, not present-and-null.
- Every failed call in the corpus lacks usable usage, so MC3's "failed calls consumed tokens" was
  wrong about the data; the recoverable signal is the counts.
- `run.phase_changed` carries **no `to` field**; an outcome fold written against the suite's other
  fixtures would pass and return nothing on all six real runs.
- Placement and reuse were unstated: the fold must be store-free under `src/observe/` because the
  CLI may not import `store`, `broker` or `convergence`, which also rules out reusing
  `foldModelCallUsage`. The command is named `cost`.

Also added on the first reviewer's scope observation: the report may not print a
cost-per-completed-task ratio, and why.

## Anti-fake notes for the reviewer

The corpus's real shape is the trap, and revision 1 got it wrong twice over. The `metadata` key is
absent; `costUsd` is zero far more often than it is null; failed calls carry `usage: null`;
`taskId` is null on every council call; the phase lives under `run`. Five separate implementations
that look correct return zeros, `$0.00`, an under-total, an empty by-task map, and no phase
respectively — and each would pass a check built on an idealised fixture. **Verify that every
fixture reproduces the corpus's shape rather than a tidy one**, and verify it against
`~/.polish/polish.db` rather than against this contract's description of it.

No acceptance check may assert anything about *why* the review swarm is expensive, or that it
should be cheaper. The 78.7% is an input to scheduling, not a claim this item verifies.
