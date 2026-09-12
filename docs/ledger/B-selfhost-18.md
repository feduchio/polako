# B-selfhost-18 — bounded worker context window

**Status:** DRAFT, revision 1. Not frozen. Base `f4d47c4`.
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
**67.0%** of all input tokens. Three of six ended `BUDGET_EXCEEDED` at 32.4k–34.4k.

The finding's earlier framing — that items 9+19 spent "most of" the headroom — is **wrong and is
corrected here**. The instruction pack is a per-turn constant in *both* architectures, so it
shrinks the ratio but costs the digest budget only 140–420 tokens, not the whole margin.

Against the cost model *prompt = pack + digest + last turn verbatim + output*, with `g` and `O` at
their measured means and the budget at 32,000:

| Pack | Today | digest 150 | 300 | 450 | 600 | 900 | Break-even digest |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 519 (small task) | 12 turns | 1.50× | 1.42× | 1.25× | 1.17× | 1.00× | 1,088 |
| 879 (self-host scale) | 11 turns | 1.36× | 1.27× | 1.18× | 1.09× | 1.00× | 971 |
| 1,333 (the derived cap) | 10 turns | 1.20× | 1.10× | 1.10× | 1.00× | 0.90× | **808** |

**808 tokens is the number that governs this contract.** It is the worst case across every pack
size the accepted cap permits, and a digest above it is a regression rather than an improvement.

The structural gain is larger than the turn ratios. Reaching 32 turns costs 64,896 tokens under the
bounded window against 144,688 today at a 519-token pack — **2.2× cheaper** — because capacity
becomes linear in the budget. That, not the 1.1–1.5×, is why this is worth doing: it makes
`agent.maxTurns` a knob that can be reached by raising the budget proportionally.

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

- files read (paths, deduplicated);
- paths changed, tagged `write` or `patch`;
- commands run with their exit codes, most recent first;
- failed tool calls: name and error text, deduplicated with a repeat count;
- a rolling window of recent assistant message text.

The last part is what keeps the reasoning thread: the worker's own prior sentences survive in
compressed form, so dropping history does not make it restart its thinking every turn.

### The cap

`loopDigestCap(effectiveTaskBudget)` = `clamp(floor(budget / 80), 200, 400)` — **400 at the 32,000
production default**. The ceiling of 400 sits at half of the 808-token worst-case break-even, so no
pack size the accepted cap allows can turn this change into a regression. The floor of 200 keeps a
tiny budget from producing a digest too small to hold even the changed-paths list.

`src/agents/loopWindow.ts` is the home. `src/agents/` may import `src/context/` (for
`estimateTokens`) and `src/broker/` (for `ChatMessage`); `src/context/` may import neither
`broker` nor `agents`, so the builder cannot live there.

## MISSION_CRITICAL invariants

**MC1.** Per-request input size is bounded by a constant in the turn index. It is not O(t). This is
the defect and it is what the change must fix.

**MC2.** **Archive completeness does not regress.** The persisted `AgentTranscript.messages`
contains every message of the loop, in order, with the same content as today. The finding's
justification for dropping history from the context window is that the event log keeps it; if the
archive shrinks too, the change trades a token cost for an audit loss.

**MC3.** Provider validity. No `role: "tool"` message is ever sent unless the message immediately
before it is an assistant message whose `toolCalls` contain a matching `id`. `toOpenAIMessage`
maps `tool` to `tool_call_id` (`src/providers/openaiCompat.ts:189-190`), and an orphaned
`tool_call_id` is a hard 400 from every OpenAI-compatible provider. A window that drops an
assistant message while keeping its tool results breaks production while passing any test that
only measures size.

**MC4.** The rendered digest never exceeds the cap, for any input. Adversarial inputs included:
hundreds of files, a 50,000-character command output, a single path longer than the cap.

**MC5.** The most recent turn's tool results reach the model **in full, untruncated**. Eviction
targets history. A worker that just read a file must see what it read.

**MC6.** Eviction is oldest-first and every part of the digest is bounded. No field may grow
without limit.

**MC7.** Token accounting and stopping conditions keep their present semantics:
`totalTokens += inputTokens + outputTokens`, the `while` guard, the mid-loop `BUDGET_EXCEEDED`
checks, and the post-loop reclassification all behave as they do today.

**MC8.** The digest cap is strictly below 808 tokens at every budget the clamp permits.

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
estimated input size of the 20th request is within one digest cap of the 5th. Fails on the
unmodified tree, where the 20th is several thousand tokens larger.

**AC2.** After that loop, the persisted transcript's `messages` array has the full length implied
by the turns taken, and contains the text of the **first** turn's tool result — which by then is no
longer on the wire. Pins MC2.

**AC3.** For every request in that loop, every `tool` message is immediately preceded by an
assistant message whose `toolCalls` include its `toolCallId`. Pins MC3.

**AC4.** A digest built from 300 read paths, a 50,000-character command output and a 5,000-character
error renders to no more than the cap. Pins MC4.

**AC5.** The four pre-existing assertions of PR3 pass untouched, and one new check reads a
4,000-character file and asserts the **whole** content is present in the next request. Pins MC5.

**AC6.** A loop that reads `alpha.ts`, writes `beta.ts` and runs a command exiting non-zero: the
third request's digest names `alpha.ts`, names `beta.ts` as changed, and records the non-zero exit.
Pins that the digest is derived from what happened rather than being a constant.

**AC7.** With a cap that binds, assert the newest command entry is present **with its exit code**
and the oldest read path is absent. Two assertions, not one: a mid-entry string truncation would
satisfy a size check while destroying the newest entry.

**AC8.** Turn 1's request has no digest message. Its message count is exactly the system message,
if any, plus the pack.

**AC9.** A distinctive phrase in turn 1's assistant content appears in turn 3's request, and is
absent from turn 15's. Pins the rolling assistant window and its eviction together.

**AC10.** `loopDigestCap` asserted against an **independently written** table of expected values —
`(32_000, 400)`, `(16_000, 200)`, `(8_000, 200)`, `(80_000, 400)` — none of them computed by calling
the function or by re-deriving the clamp. The previous item shipped a check that read its
expectation through the map it was validating; that is the mistake this clause exists to prevent.

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

## Anti-fake notes for the reviewer

The turn ratios in the table are 1.1–1.5×, not the 2.3× the finding originally projected against an
empty prompt. If an implementation claims a larger gain, the claim is wrong; measure the requests.

The sample behind `g = 203` and `O = 164` is six fixture transcripts from two small free models.
The cost model is a turn-count model only. It cannot speak to whether a bounded window makes the
worker *better* or *worse* at its task, and no acceptance check may assert that it does.

MC3 is not observable from any size or content assertion. Read the constructed window and check the
pairing directly.
