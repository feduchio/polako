# B-selfhost-18 — bounded worker context window

**Status:** **FROZEN**, revision 3, at the commit this file is committed in. Base `f4d47c4`.
Frozen after a third contract review returned FREEZE with no blocking defects; its three
non-blocking observations are folded in above.
Revisions 1 and 2 were both rejected in contract review, by two different reviewers, and both
rejections were correct. See *Revision history*.
**Finding:** item 18 in `docs/ledger/B-selfhost-remaining.md`.

## The defect

`AgentRunner.runLoop` uses one array for two jobs. `messages` is both the wire payload
(`messages: [...messages]`, `src/agents/runner.ts:77`) and the archive (`input.messages`,
`:247`). Because it is the archive it may never shrink, and because it is the wire payload it is
resent whole on every call. So the loop's cumulative token cost is quadratic in the turn index, and
`read` output — the dominant growth term — is never evicted.

Two consequences, both measured. Turn capacity grows as the square root of the token budget, so the
contracted `agent.maxTurns` knob (32 by default, `src/domain/config.ts:111`) is not the effective
bound: no observed loop reached it. And exhaustion yields `BUDGET_EXCEEDED` → `status: "failed"`
(`src/agents/runner.ts:286-291`), so a candidate can drop out of `COMPARING` by transcript length
rather than by evidence.

## Measurement, re-derived on this base

Over the six `agent_transcript` artifacts in `~/.polish/artifacts`: mean 14.2 turns, first-request
input 692 tokens, **input growth 203 tokens per turn**, output 164 tokens per turn, resent history
**67.0%** of all input tokens (turn-weighted). Three of six ended `BUDGET_EXCEEDED` at 32.4k–34.4k.

The 692 must be decomposed before it is used, or the pack is double-counted. The first user message
in those fixtures is 39–50 tokens, mean **43** — the old `task.description`, which the composed pack
now replaces. So the per-turn fixed overhead, which is the serialized tool schemas plus whatever the
provider counts beyond the message bodies, is **649 tokens**, and the per-turn constant is
`649 + pack`. Revision 1 wrote `692 + pack` and was wrong by those 43 tokens.

The finding's earlier framing — that items 9+19 spent "most of" the headroom — is **wrong and is
corrected here**. The instruction pack is a per-turn constant in *both* architectures, so it
shrinks the ratio but costs the digest budget only 140–420 tokens, not the whole margin.

Against the cost model *prompt = pack + digest + last turn verbatim + output*, with `g` and `O` at
their measured means and the budget at 32,000:

| Pack | Today | digest 150 | 300 | 400 | 600 | 900 | Break-even digest |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 519 (small task) | 12 turns | 1.50× | 1.42× | 1.33× | 1.17× | 1.08× | 1,131 |
| 879 (self-host scale) | 11 turns | 1.36× | 1.27× | 1.18× | 1.09× | 1.00× | 1,014 |
| 1,333 (the derived cap) | 10 turns | 1.20× | 1.20× | 1.10× | 1.00× | 0.90× | **851** |

**851 tokens is the number that governs this contract.** It is the worst case across every pack
size the accepted cap permits, and a digest above it is a regression rather than an improvement.

Every figure above comes from `constant = 649 + pack`, `g = 203`, `O = 164`, `B = 32,000`, with
`today` = the largest `T` such that `Σₜ₌₁..ₜ(constant + g(t-1) + O) ≤ B` and `bounded` = `floor(B / (constant +
digest + g + O))`. A reviewer who reproduces different totals should check those formulas first.

The structural gain is larger than the turn ratios. At a 400-token digest, reaching 32 turns costs
`32 × (649 + 519 + 400 + 203 + 164)` = 61,920 tokens under the bounded window against 143,312
today at a 519-token pack — **2.31× cheaper**, and 2.11× at an 879-token pack — because capacity
becomes linear in the budget. That, not the
1.1–1.5×, is why this is worth doing: it makes `agent.maxTurns` a knob that can be reached by
raising the budget proportionally rather than quadratically.

## Design

The two jobs are separated. The archive keeps everything; the wire carries a bounded window.

Per-turn wire payload, in order:

1. the system message, if `deps.systemPrompt` is set — unchanged;
2. `user`: the composed instruction pack — unchanged, identical bytes every turn;
3. `user`: the rendered digest `Σ` of every turn before the last — **new**, absent on turn 1;
4. the previous assistant message and its `tool` messages, **verbatim and untruncated**.

`Σ` is derived mechanically by the runner from the turns already taken. There is no new tool and no
model cooperation.

### Why not the paper's design

`SKILL.state` (arXiv 2608.26263) has the model emit a validated state patch each turn. That is
rejected here for two reasons. A model that does not call the patch tool loses all memory, and that
failure mode is not testable without live models — the exact thing acceptance forbids. And the
measured dominant growth term is **tool output, not reasoning**: at 203 tokens per turn against a
164-token mean output, most of the growth is `read` and `run_command` results, which a mechanical
digest evicts without asking the model for anything.

The departure is deliberate and is recorded so a later reader does not mistake it for an
incomplete implementation of the paper.

### Digest contents

Mechanically derived, each part capped, oldest-first eviction, whole entries only:

- paths changed, tagged `write` or `patch` — **first in priority order**, because it is the part a
  worker most needs, so it is evicted last. It is *not* exempt from eviction: revision 2 said it
  "must never be evicted", which contradicted the cap. A single path longer than the cap, or more
  changed paths than the cap can hold, would have forced an implementation to either exceed MC4 or
  cut an entry in half against MC6;
- commands run with their exit codes, most recent first, and for the **most recent non-zero exit
  only**, a bounded tail of its output. Without that tail a worker that broke the build three turns
  ago has only `exit 1` and must re-run the command to learn anything — which may be slow,
  nondeterministic, or not idempotent. This was the sharpest unacknowledged loss the second contract
  review named, and 200 characters of the failing tail is a cheap answer to it;
- **every other tool call**, as name plus its identifying argument plus ok/error — not just `read`.
  Revision 1 listed only reads, writes and commands, which silently dropped `search`, `list`,
  `repo_intel` and `request_context`: a worker would lose the fact that it had already searched for
  a symbol and found nothing, and would search again. Errors are deduplicated with a repeat count;
- a rolling window of recent assistant message text, last.

That last part is the only carrier of the reasoning thread, and the contract does not overstate it.
In two of the six measured transcripts `assistant.content` is empty — the model spoke only in tool
calls — so on those loops the thread is nothing, and what keeps the worker oriented is the
inventory plus the verbatim last turn. The digest is an inventory of what happened, not a summary
of what the worker was thinking.

### The cap

`loopDigestCap(effectiveTaskBudget)` = `clamp(floor(budget / 80), 200, 400)` — **400 at the 32,000
production default**. The ceiling of 400 is 2.1× below the 851-token worst-case break-even, so no
pack size the accepted cap allows can turn this change into a regression. The floor of 200 keeps a
tiny budget from producing a digest too small to hold even the changed-paths list.

500 would be more useful and was rejected on the sample's thinness. The break-even is itself
derived from six fixture transcripts of two small free models, so `g = 203` carries real error. Held
against ±50% on `g` at the worst-case pack, a 400-token cap never regresses — 1.09× at `g = 101`,
1.00× at `g = 152`, 1.10× at 203, 1.22× above it. `g = 152` is the one point in that range where a
400-token cap merely breaks even; it never regresses. A 500-token cap reaches exactly 1.00× at both
`g = 101` and `g = 152`, i.e. it buys nothing if the growth rate is overestimated by a third. The
extra 100 tokens of digest are not worth a third of the plausible range delivering no gain.

At 400 tokens a realistic self-host digest is inventory and little else: roughly 250–350 tokens for
twenty paths, ten commands and a few errors, leaving one or two sentences of assistant text. That
is the intended shape, and it is why MC5 exists — the verbatim last turn, not the digest, is what
carries the working detail.

`src/agents/loopWindow.ts` is the home. `src/agents/` may import `src/context/` (for
`estimateTokens`) and `src/broker/` (for `ChatMessage`); `src/context/` may import neither
`broker` nor `agents`, so the builder cannot live there.

## MISSION_CRITICAL invariants

**MC1.** The **historical** footprint of a request is bounded by a constant, independent of the turn
index: every request consists of the fixed prompt, at most one digest of cap size, and the single
most recent turn. It is not O(t). This is the defect and it is what the change must fix.

Revision 2 said "per-request input size is bounded by a constant", which **contradicted MC5**. The
`read` tool returns whatever line range it was asked for and defaults to the whole file
(`src/agents/tools.ts:69-72`); there is no output cap anywhere in the tool layer. One `read` of a
large file makes the most recent turn arbitrarily large, so no implementation can bound the total
request while also sending the newest results verbatim. The two clauses as written admitted only
implementations that violated one of them.

Bounding the newest turn as well would require an output cap on `read` and `run_command`. That is a
separate change with its own risk — it changes what every worker sees, not merely what it
remembers — and it is **out of scope** here.

**MC2.** **Archive completeness does not regress.** The persisted `AgentTranscript.messages`
contains every message of the loop, in order, with the same content as today. The finding's
justification for dropping history from the context window is that the event log keeps it; if the
archive shrinks too, the change trades a token cost for an audit loss.

**MC3.** Provider validity. Every `role: "tool"` message sent belongs to a **contiguous run of
`tool` messages immediately following an assistant message whose `toolCalls` contain its `id`**,
with no `user` or `system` message interleaved, and the run covers every `toolCall` the assistant
made that the loop executed. `toOpenAIMessage` maps `tool` to `tool_call_id`
(`src/providers/openaiCompat.ts:189-190`), and an orphaned or unanswered `tool_call_id` is a hard
400 from every OpenAI-compatible provider.

Revision 1 said "the message immediately before it is an assistant message". That is **wrong and
unsatisfiable**: `runLoop` pushes one `tool` message per call in a loop
(`src/agents/runner.ts:116-128`), so on a turn with two tool calls the second `tool` message
follows a `tool` message. The only implementations satisfying revision 1's letter were the two that
break production — drop every tool result after the first, or synthesize assistant messages that
the model never sent. The clause meant to protect the provider contract specified a violation of
it.

A window that drops an assistant message while keeping its tool results, or keeps an assistant
message while dropping one of its tool results, breaks production while passing any check that only
measures size.

**MC4.** The rendered digest never exceeds the cap, for any input. Adversarial inputs included:
hundreds of files, a 50,000-character command output, a single path longer than the cap.

**MC5.** The most recent turn's tool results reach the model **in full, untruncated**. Eviction
targets history. A worker that just read a file must see what it read.

**MC6.** Eviction removes **whole rendered entries**, lowest-priority-and-oldest first, and every
part of the digest is bounded. No field may grow without limit, and no entry is ever cut mid-render.

For this to be jointly satisfiable with MC4, **each entry has a bounded rendering**: a path is
rendered as at most its last 80 characters, prefixed with `…` when shortened, and an error or
output tail at most 200 characters. Bounding the *rendering* rather than exempting any field is what
lets the cap hold against a single pathological input while keeping every surviving entry whole.
Priority order is: changed paths, then the most recent failing command, then remaining commands,
then other tool calls, then assistant text. **This order governs eviction**, and where it differs
from the reading order of the digest-contents list above — which puts the failing command among the
commands — this clause is the one an implementation must satisfy. Rendering commands most-recent
first and evicting successful and older ones before the failing one satisfies both.

Not every argument has a stated render bound: a 50,000-character `run_command` argv or `search`
query has no shortened form specified, so the only legal move is to evict that entry whole. That is
intended and is what keeps MC4 and MC6 jointly satisfiable for every input — at the limit the
digest may carry no commands at all.

**MC7.** Token accounting and stopping conditions keep their present semantics:
`totalTokens += inputTokens + outputTokens`, the `while` guard, the mid-loop `BUDGET_EXCEEDED`
checks, and the post-loop reclassification all behave as they do today.

**MC8.** The digest cap is strictly below 851 tokens at **every** integer budget, not merely at
sampled ones. `clamp(floor(b / 80), 200, 400)` is bounded above by its own ceiling, so this holds by
construction — but it must be checked over the domain rather than at four points, because a
piecewise implementation can hit four sampled values and exceed the bound between them.

## PHASE_REQUIRED

**PR1.** The window is what production sends. The seam is inside `AgentRunner.runLoop`, which is
already the production path; no composition change is required, and none may be needed to activate
it. There is no configuration flag: a flag would create a branch that no production configuration
takes, which is the defect class item 19 was accepted for.

**PR2.** At least one acceptance check must fail on the unmodified tree. A check that passes at
`f4d47c4` measures something other than this defect.

**PR3.** The existing suite passes unchanged. In particular `src/agents/agents.test.ts:87,112,163,192`
assert that the last wire message carries the current turn's tool error; they are pre-existing and
now also pin MC5. They may not be edited.

## Acceptance checks

**AC1.** A scripted 20-turn loop whose `read` results are ~2,000 characters each. Assert the
estimated size of the 20th request is within one digest cap of the 5th, measured as
`estimateTokens` over the **concatenated content of `request.messages`**.

It may **not** be measured from `usage.inputTokens`: `ScriptedProvider` reports a fixed 10
(`src/providers/scripted.ts:60`), so that version of the check is already green at `f4d47c4` and
would violate PR2. Measured on the message bodies it fails decisively today — simulated over 20
turns, turn 5 is ~2,078 tokens and turn 20 ~9,683, a gap of 7,605 against a 400-token cap.

**AC2.** After that loop, the persisted transcript's `messages` array has the full length implied
by the turns taken, and contains the text of the **first** turn's tool result — which by then is no
longer on the wire. Pins MC2.

**AC3.** For every request in that loop, walk the messages and assert MC3 as stated: each maximal
run of `tool` messages is preceded by an assistant message, and the run's `toolCallId`s equal that
assistant's executed `toolCalls` ids, in order.

**The loop must contain at least one turn whose assistant message makes two tool calls, and it may
not be the last turn** — a later request must actually carry it, or a window that keeps only the
first result of each turn still passes. AC1's
one-read-per-turn loop can only ever produce `[assistant, tool]`, under which a window that keeps
only the first tool result of each turn passes — and that window loses evidence in production.
Neither `ScriptedProvider` nor any existing fixture validates pairing, and no fixture in the tree
scripts two `toolCalls` in one assistant message, so nothing else in the suite can see this.

**AC4.** Four adversarial renderings, each no larger than the cap: 300 read paths; a
50,000-character command output; a 5,000-character error; **a 50,000-character command argv**, whose
entry has no shortened form and must therefore be evicted whole; and — the case revision 2 could
not see — **300 changed paths together with one changed path longer than the cap by itself**. Assert in that
last case both that the cap holds and that whatever entries remain are whole, so neither MC4 nor
MC6 can be satisfied at the other's expense. Pins MC4 and MC6 together.

**AC5.** The four pre-existing assertions of PR3 pass untouched, and one new check reads a
4,000-character file and asserts the **whole** content is present in the next request. Pins MC5.

**AC6.** One loop that exercises **every non-terminal tool** — all eight of `AGENT_TOOL_NAMES`
except `finish`: `read`, `list`, `search`, `repo_intel`, `write`, `apply_patch`, `run_command`,
`request_context` — with a later request's digest asserted to carry, for each, its name and its
identifying argument, plus `write` and `apply_patch` distinguished by their tags, plus the non-zero
exit code of a failing command, plus a distinctive substring of that failing command's output tail.

Revision 2 named only read, write and command here, so an implementation that dropped `list`,
`repo_intel` and `request_context` entirely passed every check while the design required them.
Enumerate the tool names in the assertion; do not spot-check three. Pins that the digest is derived
from what happened rather than being a constant.

**AC7.** With a cap that binds, assert the newest command entry is present **with its exit code**
and the oldest read path is absent. Two assertions, not one: a mid-entry string truncation would
satisfy a size check while destroying the newest entry.

**AC8.** Turn 1's request has no digest message. Its message count is exactly the system message,
if any, plus the pack.

**AC9.** With a cap that binds — the assistant contents must be long enough that the rolling window
overflows before turn 15, which the check must arrange and not assume — a distinctive phrase in
turn 1's assistant content appears in turn 3's request and is absent from turn 15's. Pins the
rolling assistant window and its eviction together. Without the binding cap a short phrase can
survive to turn 15 legitimately, and the check would be asserting nothing.

**AC10.** `loopDigestCap` asserted against an **independently written** table of expected values —
`(32_000, 400)`, `(16_000, 200)`, `(8_000, 200)`, `(80_000, 400)` — none of them computed by calling
the function or by re-deriving the clamp. The previous item shipped a check that read its
expectation through the map it was validating; that is the mistake this clause exists to prevent.

Plus a check over the **domain**, not four points: for every budget in a dense sweep of the valid
range, `loopDigestCap(b) ≤ 400` and `≥ 200`. Four sampled values cannot see a piecewise
implementation that agrees at those four and exceeds the bound between them, and MC8 is stated over
every budget.

**AC11.** Budget and turn semantics unchanged: a loop whose usage exceeds `maxTokens` still ends
`BUDGET_EXCEEDED`; a loop that reaches `maxTurns` without finishing still ends `BUDGET_EXCEEDED`; a
loop that calls `finish` with valid evidence still ends `FINISHED`.

## Named fakes — each must be planted and killed

| Fake | Expected killer |
| --- | --- |
| The window builder exists; `runLoop` still sends `[...messages]` | AC1 |
| The digest is rendered but never capped | AC4 |
| The cap is applied by truncating the rendered string mid-entry | AC7's exit-code assertion |
| The archive is switched to the windowed messages | AC2 |
| The previous assistant message is dropped, its `tool` messages kept | AC3 |
| The last turn's tool results are truncated like history | AC5 and PR3's four assertions |
| `loopDigestCap` returns a large constant | AC10, and AC1's bound |
| The digest is computed once on turn 2 and cached | AC6 or AC9 |
| Eviction is newest-first | AC7 |
| The digest is a constant string that names no actual file | AC6 |
| Only the first tool result of each turn is kept | AC3's two-call turn |
| `search` / `list` / `repo_intel` / `request_context` leave no trace in the digest | AC6's tool enumeration |
| The changed-paths list is exempted from the cap so it can never be evicted | AC4's over-cap changed path |
| An over-cap entry is cut in half rather than shortened by its bounded rendering | AC4's wholeness assertion |
| `loopDigestCap` is piecewise and agrees with the four sampled budgets | AC10's domain sweep |
| The failing command's output tail is dropped, leaving only the exit code | AC6's output-tail substring |

A fake that survives every check must be reported with the assertion that should have caught it,
per the stopping rule in `docs/ledger/PHASE-C.md`.

## Out of scope

- Model-authored state patches, and any change requiring the worker to cooperate.
- The `agent.maxTurns` default (32) and the `maxTaskTokens` default (null → 32,000). This change
  makes the turn knob reachable; choosing a new number is a separate decision with its own cost.
- Finding 23's no-progress detector, finding 24's capability probes, item 12's spend durability.
- The shrinking per-call output allowance (`remainingTokens`). The bounded window relieves it as a
  side effect, but the finding records it as live and **not yet shown to truncate**, so no
  acceptance check may claim a fix for it.
- Compressing the pack itself. It is a constant in both architectures and item 19 fixed its cap.
- **An output cap on `read` and `run_command`.** MC1 bounds only the historical footprint precisely
  because capping tool output is a different change: it alters what a worker sees, not what it
  remembers, and it would need its own measurement of how often a truncated read costs a task.
  Recorded as a follow-on, not done here.
- Re-recording provider cassettes. `RecordReplayProvider.requestKey` hashes `messages`
  (`src/providers/recordReplay.ts:32-40`), so any worker cassette recorded before this change misses
  from the first altered request onward. No such cassette exists in this tree and `PHASE-C.md`
  schedules recording after this item, so the cost is a sequencing constraint rather than work.

## Which checks carry PR2, and which are pins

AC1, AC6, AC7, AC9 and AC10 fail on the unmodified tree and carry PR2. **AC2, AC3, AC5, AC8 and
AC11 are already green at `f4d47c4`** and are non-regression pins, not evidence. That is stated so
a later reader does not mistake their passing for proof the change works.

One consequence of the design worth recording for whoever writes the tests: from turn 2 onward the
last `user` message on the wire is the digest, not the pack, so `ScriptedProvider`'s fallback echo
(`src/providers/scripted.ts:70`) will echo the digest. The existing suite scripts explicit replies
and is unaffected; a new test that leans on the fallback will see the digest.

## Revision history

**Revision 2 → 3**, after a second contract review by a different reviewer, which found four
blocking defects the first review missed. All four upheld:

- **MC1 contradicted MC5.** No output cap exists in the tool layer, so "per-request input bounded by
  a constant" and "the newest tool results verbatim and untruncated" could not both hold. MC1 now
  bounds the historical footprint and an output cap is explicitly out of scope.
- **"Changed paths must never be evicted" contradicted MC4 and MC6.** Introduced in revision 2 while
  fixing something else. Resolved by bounding each entry's *rendering* and making the list
  highest-priority rather than exempt.
- **The all-tools requirement was unobserved.** Revision 2 broadened the design to nine tools and
  left AC6 naming three, so an implementation could drop `list`, `repo_intel` and `request_context`
  and pass everything.
- **MC8 was stated over every budget and checked at four points.**

One unacknowledged loss the same review named is now in the design: a failing command's output was
being reduced to its exit code, so a worker that broke the build three turns ago had to re-run it.

Arithmetic corrected in the same pass: the worst-case break-even is **851**, not 850, and the
self-host-scale one **1,014**, not 1,013 — my binary search was inclusive by one. The 32-turn totals
are now given as the formula that produces them, since revision 2's figures came from unrounded
intermediates and could not be reproduced from the printed constants.

**Revision 1 → 2**, after the first contract review. One blocking defect and five corrections, all
from the review and all upheld:

- MC3 specified a message ordering that `runLoop` cannot produce and that would have forced an
  implementation to break the provider contract. AC3 could not have caught it.
- AC1's measurement source was unspecified and the natural reading was already green.
- The per-turn constant double-counted the old `task.description`; the worst-case break-even is 850,
  not 808, and the 32-turn figures were quoted at a 450-token digest rather than the production 400.
- The digest inventoried three tool names out of nine.
- AC9 did not require its cap to bind.
- The contract did not say which checks are evidence and which are pins.

## Anti-fake notes for the reviewer

The turn ratios in the table are 1.1–1.5×, not the 2.3× the finding originally projected against an
empty prompt. If an implementation claims a larger gain, the claim is wrong; measure the requests.

The sample behind `g = 203` and `O = 164` is six fixture transcripts from two small free models.
The cost model is a turn-count model only. It cannot speak to whether a bounded window makes the
worker *better* or *worse* at its task, and no acceptance check may assert that it does.

MC3 is not observable from any size or content assertion, and it is the clause revision 1 got
wrong. Read the constructed window and check the pairing directly, on a turn with more than one
tool call.

The digest's usefulness is not asserted anywhere and cannot be. If an implementation's digest is
within the cap, derived from the loop, and evicts oldest-first, it satisfies this contract even if
a human would have written a better summary.
