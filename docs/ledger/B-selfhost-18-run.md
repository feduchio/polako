# B-selfhost-18 — run record

**Status:** TASK ACCEPTED at `8ea156db5207c5b159869b6e8ea2620c628b932f`, after two consecutive clean
rounds on the unchanged commit under the revised stopping rule in `docs/ledger/PHASE-C.md`.

## Provenance

| What | Where |
| --- | --- |
| Finding | item **18** in `docs/ledger/B-selfhost-remaining.md` |
| Exact base | `f4d47c4` — the acceptance of items 9+19 on `phase-c-collab` |
| Frozen contract | `docs/ledger/B-selfhost-18.md`, revision 3, frozen at `48568f2`, sha256 `ec0b7287e27e5d89eb30938f485a2e206228c04533a957fd35e80993bf9a22b1` |
| Candidate branch | `task/B-selfhost-18-candidate` |
| Accepted commit | `8ea156d` (15 commits since the freeze) |
| Lanes | **Grok** and **GPT-5.6-sol** for review; coordinator implemented |

The reviewer lanes changed with this item. The coordinator is Claude, so the Claude lane used for
items 3–19 was same-family and no longer independent. Review ran on Grok and GPT-5.6-sol
throughout; Composer, Max and Ultra remain out of bounds.

## The defect

`AgentRunner.runLoop` used one array for two jobs. `messages` was both the wire payload and the
archive, so because it was the archive it could never shrink, and because it was the wire payload
it was resent whole every turn. Cumulative cost was quadratic in the turn index, and `read` output —
the dominant growth term — was never evicted.

## The measurement the contract rests on, and the correction inside it

Re-derived from the six `agent_transcript` artifacts in `~/.polish/artifacts`: mean 14.2 turns,
first-request input 692 tokens, growth **203 tokens per turn**, output 164, resent history **67.0%**
of all input. Three of six ended `BUDGET_EXCEEDED` at 32.4k–34.4k.

The finding's earlier claim — that items 9+19 had spent "most of" the headroom — was **wrong**. The
instruction pack is a per-turn constant in *both* architectures, so it shrinks the improvement ratio
but costs the digest budget only 140–420 tokens. Correcting that, and decomposing the 692 into a
649-token fixed overhead plus the 43-token old `task.description` so the pack is not double-counted,
the worst-case break-even is **851 tokens** at the largest pack the worker cap allows.

Against that, at the 400-token cap the change buys 1.10×–1.50× more turns. The reason to do it is
not that ratio: reaching 32 turns costs 61,920 tokens under the bounded window against 143,312
today, **2.3× cheaper**, because capacity becomes linear in the budget instead of quadratic. That is
what makes the `agent.maxTurns` knob reachable at all.

**What this does not establish, stated plainly because the first draft of this record blurred it.**
Cost per task is **not** proven. Two things are proven, by tests: the historical footprint of a
request is constant in the turn index, and the archive is intact. Everything quantitative above is a
**turn-count model** whose load-bearing assumption is that a worker needs the same number of turns
to do the same job with less context in front of it. That assumption is untested, and the contract
forbids any acceptance check from asserting it either way.

Measured afterwards against the six real end-to-end runs in `~/.polish/polish.db` (finding 29), the
ceiling is smaller than the ratios suggest. The worker loop is **17.2%** of a run's 1,060,632
tokens; resent history inside it is **10.7%**, which is the most this change could ever remove; the
digest and verbatim turn that replace it cost **4.8%**. So the net is **5.8% of a run if turn counts
hold, and zero if the bounded window costs the worker one extra turn in fourteen.** The review swarm
is **78.7%** of spend at a 5:1 output-to-input ratio, which no prompt-window work reaches.

## Design

Per request: the system message if configured, the instruction pack, a bounded digest of everything
before the most recent turn, and that turn **verbatim** — sliced out of the archive rather than
rebuilt, which is what keeps each assistant message paired with its tool results. The archive keeps
everything.

The digest is derived mechanically from the turns already taken. **No new tool, no model
cooperation.** The contract records why this departs from `SKILL.state` (arXiv 2608.26263): a model
that fails to call a patch tool loses all memory, and that failure mode is not testable without
live models, which acceptance forbids. And the measured dominant growth term is tool output, not
reasoning.

The cap is `clamp(floor(budget / 80), 200, 400)`, 400 at production defaults. 500 was rejected on
the sample's thinness: held against ±50% on the measured growth rate, a 400-token cap never
regresses, while 500 reaches exactly break-even at two points in that range.

## Contract review: three revisions, two rejections

Revision 1's MC3 specified a message ordering `runLoop` **cannot produce**. It required every `tool`
message to be immediately preceded by an assistant message, but the loop pushes one `tool` message
per call, so on a two-call turn the second follows a `tool`. The only implementations satisfying its
letter were the two that break production. The clause meant to protect the provider contract
specified a violation of it — and AC3 as written could not have caught it, because its fixture had
one tool per turn.

Revision 2 fixed the tool coverage and, in the same pass, introduced "changed paths must never be
evicted", which contradicted the cap and the whole-entry rule. Resolved by bounding each entry's
*rendering* rather than exempting any field.

Revision 3 was frozen after a third review returned FREEZE with no blocking defects.

## Fifteen rounds

| Round | Grok | GPT | What reopened it |
| --- | --- | --- | --- |
| 1 | **FAIL** | — | Broken typecheck; a tautological tail assertion |
| 2 | — | **FAIL** | A production defect, two surviving mutants, a second tautology |
| 3 | **FAIL** | **FAIL** | A production defect; three unobserved MC6 clauses |
| 4 | **FAIL** | **FAIL** | The eviction priority order, entirely unobserved; the ok/error outcome |
| 5 | PASS | **FAIL** | `floor`/`ceil`; the standing system prompt; two priority pairs |
| 6 | — | **FAIL** | The token accounting the outcomes could not see |
| 7 | PASS | **FAIL** | Two thirds of MC2's archive clause; AC8's no-system branch |
| 8 | — | **FAIL** | AC9 observed at the builder, not on requests; one priority pair |
| 9 | PASS | **FAIL** | The cap formula's linear region |
| 10 | — | **FAIL** | The production system-prompt insertion |
| 11 | PASS | **FAIL** | The later-request instruction pack |
| 12 | — | **FAIL** | AC8's exact no-system request count |
| 13 | — | **FAIL** | MC6's `search` query, named beside the argv |
| 14 | PASS | PASS | Clean |
| 15 | PASS | PASS | Clean — accepted |

Rounds 1 and 2 broke the round protocol: I reviewed with one lane, fixed, then reviewed with the
other, so neither PASS attested the commit the other had seen. From round 3 a round is both
reviewers on the same commit with fixes held until both report.

## What review actually found

**Two production defects.** A failed non-command tool call lost its identifying argument, so a
worker was told `read failed` without being told which path it may not read. And two failing
commands in the *same turn* both kept their output, because the newest failure was tracked by turn
number and a turn can make several calls — now tracked by call position.

**Thirty unobserved clauses or tautological checks.** The distribution is the interesting part.

*Four assertions were satisfied by their input for a reason unrelated to what they claimed.* The
AC6 failing-output check was wrong three separate times: the marker was also in the command's argv;
then `src/math.ts` reached the digest from `apply_patch` and from the task description as well as
from the `read`; then the output was shorter than the 200-character bound, so `head()` and `tail()`
were identical. This is the same mistake as the previous item's "two literal matches are not a
comparison", and it took three corrections in one clause to stop making it.

*Eight clauses were observed at the wrong level.* The contract words MC1, AC8 and AC9 about a
**request**; I observed them on the builder. A builder test cannot see what the runner does with the
builder's output, and four separate mutants exploited exactly that: the system prompt dropped once a
digest appears, the pack stripped after turn one, an empty digest slot on turn one, and prose
stripped before the digest was built. Every one of those was invisible to a green builder test.

*One clause was observed only where its formula is degenerate.* Every budget in AC10's table sat on
a clamp plateau, so neither the division by 80 nor the flooring was ever exercised; a step function
and `Math.round` both passed. Two values in the linear region closed it.

*Three were conjuncts.* MC2 requires every message "in order, with the same content as today"; a
length check and one sampled body observe one third of that, and a reversed archive passed.

*And the eviction priority order was unobserved entirely.* Flattening every priority to zero left
the suite green, because in every fixture the highest-priority entry was also the most recent, so
recency alone explained each outcome. Six fixtures at measured minimum caps now put an older
high-priority entry against a newer low-priority one, covering every adjacent pair the contract
names.

## Anti-fake evidence

Every fake the contract names was planted and killed. The confirming round added twenty and sixteen
further fresh mutations across the two lanes; all but the agreed non-blocking survivors died, each
with a named assertion. Recorded in full in the round reports.

## Gates

`typecheck`, `lint`, `deps:check`, `vitest run --maxWorkers=2` and `build` on Node 24.20.0:
719 tests across 75 files, 265 modules with no dependency violations. Reproduced independently by
both reviewers in every round.

## Recorded, not fixed

Agreed non-blocking by both lanes; each is a case the frozen contract does not name, so acting on it
would have been a new axis:

- Within-section display order is unasserted. MC6 makes eviction, not reading order, governing.
- A `request_context` query has no over-cap whole-eviction fixture; MC6 names only the `run_command`
  argv and the `search` query.
- Changed paths and successful tool calls are deduplicated in code but nothing requires it; the
  contract requires deduplication only of errors.
- **The demotion of an older failing command uses `text.replace(/: [\s\S]*$/, "")`, which eats from
  the first `: ` in the argv.** An older failing `git commit -m "fix: …"` can therefore lose its exit
  code. This is a real if small wart and is filed as finding **28**.
- An output cap on `read` and `run_command` remains out of scope: MC1 bounds only the historical
  footprint precisely because capping tool output changes what a worker *sees*, not what it
  remembers, and needs its own measurement.
- `RecordReplayProvider.requestKey` hashes `messages`, so any worker cassette recorded before this
  change misses from the first altered request onward. No such cassette exists and `PHASE-C.md`
  schedules recording after this item.

## Process note

Fifteen rounds is the second-longest run of this programme, and unlike the twenty-six of
B-selfhost-8 it was not caused by an unsatisfiable stopping rule. Findings per round went
2, 4, 7, 2, 4, 1, 3, 2, 1, 1, 1, 1, 1, 0, 0 — monotone once the round protocol was fixed, and
terminating because the contract is finite. Twelve of the last thirteen findings came from the GPT
lane while the Grok lane passed; the disagreements were about classification, not about facts, and
in each case the reviewer who could quote a contract fragment was right.

The lesson worth carrying is narrower than "write better tests". Three of the four defect shapes are
about **where** and **against what** a check is written, not about whether the behaviour is correct:

1. An assertion whose expected value also appears in the input for an unrelated reason proves
   nothing. Check every expected string against the task description, the pack, the fixture paths,
   the tool arguments and the other tools in the same fixture before believing it.
2. A clause worded about a production request must be observed on a production request. A builder
   test is a different claim, and the gap between them is exactly where four mutants lived.
3. A bound or a formula must be exercised where it bites. Sampling only the plateau of a clamp, or
   only inputs shorter than a truncation limit, observes nothing.
4. An ordering rule must be tested where the simpler property disagrees with it. If the
   highest-priority entry is also the newest, recency explains the result and the priority table is
   never exercised.
