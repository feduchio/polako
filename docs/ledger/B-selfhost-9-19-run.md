# B-selfhost-9 + 19 — run record

**Status:** TASK ACCEPTED at `9e157e1a0a5d7369f2be905d8c36121789e09087`, after two consecutive clean
rounds on the unchanged commit under the revised stopping rule in `docs/ledger/PHASE-C.md`.

## Provenance

| What | Where |
| --- | --- |
| Findings | items **9** and **19**, plus the reviewer-protocol half of item **23** |
| Exact base | `88d0c8f` — the frozen-contract commit on the merged `phase-c-collab` |
| Frozen contract | `docs/ledger/B-selfhost-9-19.md`, sha256 `85379fa218c00e5fbff07d8f1388c663006bcb3e2a0662476975352a99fae5f9` |
| Candidate branch | `task/B-selfhost-9-19-candidate` |
| Accepted commit | `9e157e1` (6 commits since base) |
| Lanes | Grok and Claude for review; coordinator implemented |

## What the two defects were

A production worker's entire instruction was `task.description`. The instruction hierarchy, the
base engineering policy, the acceptance block and the untrusted-data fencing all existed, were
tested, and had **no production caller** — `ProtocolRegistry.load`, `compose`, `fitToBudget` and
`buildWorkerContextPack` were reachable only from their own suites.

And a candidate's recorded model was `worker/candidate-N`. The router-selected `ModelRef` already
reached `AgentRunner` and the persisted transcript; only the `Candidate` record and the event
actors carried the synthetic one, so one candidate had two model identities in the same run.

## The contract cost three revisions, and that was the cheap part

Both contract reviews returned DO NOT FREEZE, twice over.

Revision 1 required worker composition to go through `compose()`. It cannot: `compose` demands a
role and validates `kind: role`, and **none of the eleven role protocols applies to a worker**. It
also required an `index` field on `Candidate`, which does not exist, and four of its acceptance
checks already passed on the untouched tree because they called `buildWorkerContextPack` directly.

Revision 2's token rule contradicted its own MC1. It capped the pack at `default × 14 ≤ 25%` of the
task budget — 571 tokens — while requiring a task protocol body that puts the measured protected
floor at 1,093 on a self-host-scale task. No number satisfied both. The reviewer measured the
sections on the tree rather than arguing: 425 protected tokens for an e2e-scale task, 1,093 for a
realistic one, and `base-engineering-policy` rendering to 188 tokens against a declared budget of
800, so `fitToBudget` and `fitWorkerPack` disagree by a factor of five.

The same review caught what would have been the worst shipped defect of the task: **the inline
reviewer literal carried the entire machine-readable output contract**, and no `reviewer-*` body
describes an output format. Replacing the literal with a role body — the obvious reading of the
finding — would have left every reviewer response failing `RawFindingSchema.parse` in production
while the acceptance check passed.

## Implementation

| Commit | What |
| --- | --- |
| `dde906a` | The model that ran a candidate, recorded instead of its index; worker resolved before the sandbox |
| `f9374c1` | That model observed where the run reports it |
| `2f2d6b9` | A composed instruction for the production worker; the seam, the derived cap, the protected task protocol |
| `ec6be1a` | A per-task pack, and the measured cost recorded |
| `1317866` | Four production defects found by review: the silent failure, the sibling leak, the dead domain branch |
| `9e157e1` | The clauses that were true and unwatched, observed |

The seam is `composeWorkerInstruction`, wired as `AgentRunnerDeps.prompt`. It attaches no role,
because none exists for a worker. The task protocol lives in its own protected section rather than
in `protocolSupplementary`, so a binding cap cannot silently remove the instruction that says how
to do this kind of work. The pack carries the text it measured, so the cap binds on what is sent.
The cap is derived — `clamp(floor(budget / 24), 1_000, ceiling)`, 1,333 at production defaults —
because the pack is resent every turn and a constant is either too small for a verbose planner's
protected task block or large enough to eat the turns. The protocol hash reaches the transcript
through the prompt's return value; a closure would have made the recorded hash order-dependent.

## What review found in the implementation

| Round | Commit | Grok | Claude | What reopened it |
| --- | --- | --- | --- | --- |
| 1 | `ec6be1a` | **FAIL** | **FAIL** | Eight findings, three shared |
| 2 | `6ff0918` | PASS | **FAIL** | The axis-to-role check derived its expectation from the map under test |
| 3 | `9e157e1` | PASS | PASS | Clean |
| 4 | `9e157e1` | PASS | PASS | Clean — accepted |

Round 1's findings were mostly mine to own. Three were production defects: a pack overflow was
indistinguishable from any other failure, because `errorToString` dropped the code and
`toCandidate` discarded `CandidateResult.error` entirely; the finding filter kept the substring arm
beside the origin check, so a worker could be handed a sibling finding's claims; and the
domain-protocol branch was **dead by construction** — keyed on `ProjectProfile.framework`, which is
a test-runner hint, never `"react-native"`. That last one is finding 19's own defect class
reproduced inside its fix, and it is the sharpest thing either reviewer said.

Five more were clauses that were true in the code and observed by nothing: the protected task
protocol (adding it to `DROP_ORDER` was green), the derived cap (`return ceiling` was green, which
is the contract's own named fake), fencing at the provider, the hash's identity, and the equality
of the two model recordings.

Round 2's single finding is the one worth carrying forward. My reviewer check read its expected
role body **through `REVIEW_AXIS_ROLE`, the map it was validating**, so every possible assignment
of axes to roles satisfied it identically; pointing `regression` at the correctness role left all
695 tests green. The same commit had already pinned task kinds correctly, with an independent table
and negative assertions against the other four bodies, and that check does kill its mis-mapping.
One author, one commit, two checks of the same shape, one of them written right.

## Anti-fake evidence

Every fake the contract names was planted and killed, most of them by both reviewers
independently:

| Fake | Killed by |
| --- | --- |
| The seam not wired at all | Both composition checks |
| A constant system prompt | AC1's two-kinds-differ-by-body clause |
| Every axis mapped to `reviewer-correctness` | AC5, against the independent expectation table |
| The inline reviewer literal restored | AC5/AC6 at the provider |
| `workerPackCap` returning the ceiling | The unit assertion on 1,333 |
| The pack cached in a closure across tasks | AC10's second task |
| A pack fitted, then a `systemPrompt` added past the cap | AC7 — 712 against 530 |
| `taskProtocol` added to `DROP_ORDER` | The 450-token cap, between 386 and 517 |
| The hybrid origin-or-substring filter | The sibling whose evidence path the description names |
| `errorToString` dropping the code, `toCandidate` dropping the error | The diagnosable-overflow check |
| The synthetic `worker/candidate-N` restored | The provenance check, and nothing else |
| A mis-mapped `TaskKind` | The per-kind body phrases |

One mutant survived deliberately and was killed by reading rather than by running: `toCandidate`
re-selecting from the router. The contract predicts exactly this and instructs the reviewer to read
the implementation. The single `router.select` is evaluated once per factory, outside the per-index
closure, so the re-selection cannot disagree — but no assertion can see that.

## Gates

`typecheck`, `lint`, `deps:check`, `vitest run --maxWorkers=2` and `build` on Node 24.20.0:
696 tests across 73 files, 262 modules with no dependency violations. Reproduced independently by
both reviewers in every round.

## Measured cost

The pack is resent on every turn, today and under the architecture item 18 targets, so it displaces
worker turns rather than overrunning the budget. A small task's first request goes from 10 to 519
estimated tokens; a self-host-scale one from 269 to 879, against a derived cap of 1,333. That is
roughly 11% and 17% of a run's worker turns. Finding 18 measured the break-even for a per-turn
constant at ~1,250 tokens, so most of that headroom is now spent before item 18 is drafted — which
is recorded in the finding itself, so its projection is re-derived from this baseline and not the
empty one it was measured against.

## Recorded, not fixed

- **Finding 26.** A reviewer-authored claim reaches a worker twice: fenced as evidence, and
  unfenced inside the protected task block, because the task is built from that claim. Base
  behaviour that this change only wrapped a hierarchy around.
- **Finding 27.** A malformed protocol directory now fails daemon construction rather than
  producing a startup diagnostic. Fail-fast is the right polarity; the missing diagnostic is not.
- Both `domain` protocols still have no production caller, because `ProjectProfile` carries no
  stack signal to select one from. Recorded on item 19 rather than guessed at.
- The production call site of `assertReviewerRolesResolvable` is unobserved; deleting it is green,
  and on a well-formed tree there is no behaviour delta.
- Neither AC12 nor AC13 retrieves a transcript through `candidate.transcriptRef`, so the shared
  `${runId}:${taskId}` artifact label is never exercised.
- `Candidate.error` is persisted unredacted while `AgentRunner` redacts its own error text. AC9
  requires the string, so the asymmetry is inherent to the contract rather than to the code.

## Process note

Four rounds, six commits, and the shape is the opposite of the previous item's twenty-six. The
difference is not the code; it is that acceptance was judged against a finite contract. Findings
per round went eight, one, zero, zero. Under the old rule — any survivable mutant blocks — round 3
would have produced the `assertReviewerRolesResolvable` mutant as a blocker and the loop would have
continued, because a mutant conditioned on unobserved ambient state can always be constructed.

Two mistakes of my own are worth keeping. I restored a mutation with `git checkout --` while my own
work in that file was uncommitted, and lost an hour of it; the restore discipline that is safe for
a reviewer, whose tree is clean, is not safe for an implementer. And I built the axis-to-role check
by deriving its expectation from the table under test, in the same commit where I had already
built the analogous check correctly — which is the same failure as the previous item's "two literal
matches are not a comparison", one level up.
