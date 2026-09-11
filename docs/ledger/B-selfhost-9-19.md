# B-selfhost-9 + 19 — the production worker runs with no instruction hierarchy, and candidates are labelled with a model that does not exist

**Status:** DRAFT CONTRACT, revision 2 — one review returned DO NOT FREEZE; revised, not frozen, not implemented
**Class:** PHASE_REQUIRED with MISSION_CRITICAL invariants
**Exact base:** the merged `phase-c-collab` head at review time (accepted B-selfhost-8 code plus the ledger; the code is identical to `14beb802857fde8a5251404dc518301cb5b1a0a4`)
**Source findings:** `docs/ledger/B-selfhost-remaining.md` items **9** and **19**, plus the reviewer-protocol half of item **23**

Two findings in one contract because both rewrite `createWorkerFactory` (`src/daemon/composition.ts:552-570`). Not item 18 (the tool loop). Not item 11 (the `judge` role). Not items 12/17/21/22/25. Not C7 (`scout`). After freeze, do not rewrite.

## Authority

1. Finding 19: protocol composition and worker context packs are built and tested but have no production caller.
2. Finding 9: candidate provenance is `worker/candidate-N`.
3. Finding 23, reviewer-protocol half only. The detector half is **not** in scope.
4. Base behaviour as in `src/daemon/composition.ts`, `src/agents/runner.ts`, `src/context/worker.ts`, `src/protocols/**`, `src/review/swarm.ts`, `src/engine/candidateDrivers.ts`, `src/engine/candidates.ts`.

## Defect

### 19 — the instruction hierarchy exists and nothing uses it

`createWorkerFactory` constructs `AgentRunner` with neither `systemPrompt` nor `prompt` (`src/daemon/composition.ts:560-568`), so the first message is a single `user` message whose entire content is `task.description` (`src/agents/runner.ts:45-47`). No base engineering policy, no hierarchy, no acceptance block, no fencing of repository content as untrusted.

All of it exists and is tested: `src/context/worker.ts:23-38` (hierarchy, default base policy), `buildWorkerContextPack` (`:44`), `fenceUntrusted` (`:156-162`), `fitWorkerPack` (`:164-198`), `ProtocolRegistry.load` (`src/protocols/loader.ts:17`), `compose` (`src/protocols/composer.ts:51`), `fitToBudget` (`:80`). Verified on this base: none has a non-test caller; every non-test occurrence is a definition or a re-export.

`runAxisReview` hardcodes its reviewer system prompt inline (`src/review/swarm.ts:64-69`). Reviewers fence their payload as untrusted (`:60`); workers do not fence at all.

### 9 — the candidate's model is a label, not a fact

The real `ModelRef` is selected in `createWorkerFactory` (`src/daemon/composition.ts:553-558`) and handed to `AgentRunner`, which records it on the persisted transcript. The synthetic identity is minted separately: `toCandidate` hardcodes `model: { provider: "worker", model: \`candidate-${index}\` }` (`src/engine/candidateDrivers.ts:508`), and the same literal goes into the `worker.started` payload and actor (`:134`, `:136`) and every `candidate.*` actor. One candidate, two model identities: the truthful one in the transcript artifact, the synthetic one in the event log and the `Candidate` record the tournament, report and observer read.

Git branch naming is unrelated and is not changed here.

## Definitions and boundaries

**Worker composition cannot use `compose()`.** `compose` requires a `role` and validates `kind: role` (`src/protocols/composer.ts:51-71`). The tree has eleven role protocols — five `reviewer-*`, plus `evidence-agent`, `defender`, `planner`, `scope-guardian`, `judge`, `prosecutor` — and **none applies to a worker**. Authoring a worker role is out of scope. The seam therefore assembles base + task protocol + optional domains itself and attaches no role. Passing `planner` or `judge` as a stand-in is the silent-fallback this contract forbids elsewhere and is forbidden here.

**Reviewers must not call `compose()` either.** `runAxisReview` has a `ReviewAxis`, not a `TaskProtocolName`, and a checkpoint's `taskId` is nullable (`src/domain/checkpoint.ts:32`). It loads the mapped `reviewer-*` role protocol directly, and may prepend the base policy.

**Two name mappings are not identities.** `TaskKindSchema` is `bugfix | feature | refactor | simplify | investigation` (`src/domain/task.ts:34`); `TaskProtocolNameSchema` is `bugfix | feature | refactor | simplify | investigate` (`src/protocols/types.ts:31-37`). `registry.get(task.kind)` throws for an investigation task. `ReviewAxisSchema` has eight members (`src/domain/finding.ts:6-15`) and only five have a `reviewer-*` protocol; `spec_compliance`, `security` and `performance` are unmapped. Production selects only `DEFAULT_REVIEW_AXES` — `correctness`, `regression`, `adversarial` (`src/domain/review.ts:6`) — plus any configured extras.

**The pack is P, and P is paid on every turn, before and after item 18.** Finding 18's ~1,250-token figure is the budget for the *state block* item 18 will add, not for this pack. `AgentRunner.runLoop` resends the whole message array each turn today, and the SKILL.state architecture item 18 targets keeps `(P, Σ_t, O_t)` — the immutable specification stays resident. So the cap set here is permanent, not temporary.

**The arithmetic is tight and the default must be justified against it, not chosen by feel.** Effective task budget is `budget.maxTaskTokens ?? 32_000` (`src/daemon/composition.ts:566`) and `agent.maxTurns` defaults to 32. A pack of P tokens resent every turn costs `P × turns`. At P = 1500 and 32 turns that is 48,000 tokens against a 32,000 budget — the run cannot finish. At P = 500 it is 16,000, half the budget. Finding 18 measured real loops at 10–18 turns, mean 14.2, so the realistic multiplier is ~14, not 32. **A conforming implementation states its chosen production default and shows `default × 14 ≤ 25%` of the effective task budget**, or argues explicitly for a different fraction. `config.contextBudget.maxPackTokens` already exists with a default of **60_000** and `min(1000)` (`src/domain/config.ts:91`) and has no production caller; adopting 60_000 satisfies the letter of a cap and protects nothing, so it is forbidden. Lowering the schema minimum is permitted if the justified default is below 1000.

**`fitWorkerPack` is the enforcer, and its throw is the specified outcome.** Droppable sections go in `DROP_ORDER`. If the protected sections alone — hierarchy, mission, base policy, task block — exceed the cap, `fitWorkerPack` throws `BUDGET_EXCEEDED` (`src/context/worker.ts:193-198`). That is correct behaviour, not a violation.

**`prompt` carries the task, `systemPrompt` does not.** `systemPrompt` is a fixed string set at construction; `prompt` is `(task: Task) => string`. The factory is constructed per candidate, before the task is known. Everything task-dependent belongs in `prompt`. `systemPrompt`, if used at all, holds only task-invariant text and must never close over a construction-time task or its evidence.

**Item 9 is a propagation, not a re-selection.** `runOneCandidate` constructs the worker before `onWorkerStart` and before `run` (`src/engine/candidates.ts:132-137`), so `worker.started` cannot read a transcript that does not exist yet. The seam is: expose the model on the worker, copy it onto `CandidateResult` at construction, widen `onWorkerStart` to carry it, and have `toCandidate` use `result.model`. `appendCandidateEvents` already writes `actor.model` from `candidate.model`, so the `candidate.*` actors follow. Do not re-select from the router, and do not read the transcript to fill the record — that would make the agreement check a tautology.

**Not item 18.** No change to message accumulation, token accounting, or per-call `maxTokens`. The first message changes; that is in scope.

**Not item 11.** This contract does not compose the `judge` role. `PHASE-C.md`'s soft constraint "19 before 11 because 19 composes the judge protocol" is superseded: item 11 composes `judge` itself. The ordering still holds for a weaker reason — 11 should not author a judge prompt from scratch while this contract establishes how protocols are loaded.

**Not C7.** No `scout`, no widening of `ProtocolAppliesToSchema`.

## MISSION_CRITICAL invariants

1. **A production worker receives a composed instruction.** For every task, the first provider request contains the instruction hierarchy, the base engineering policy, that task's acceptance criteria, and the body of the task protocol selected by the `TaskKind → TaskProtocolName` map. `task.description` alone is not the whole instruction, and two different task kinds produce two different first requests.
2. **Repository content reaches a worker fenced as untrusted,** with the never-follow-instructions clause, whenever such content is supplied at all.
3. **The task-kind mapping is total and explicit,** including `investigation → investigate`, exhaustive at the type level via `satisfies Record<TaskKind, TaskProtocolName>`.
4. **The reviewer axis mapping is total and explicit,** via `satisfies Record<ReviewAxis, string>` onto role protocols that `ProtocolRegistry` can `get`. Unmapped axes may point at an existing `reviewer-*` role, but the table must name the target. Silent default, or no role, is forbidden. Authoring new protocols is required only for axes the implementation actually starts selecting.
5. **A successfully assembled pack is within the configured cap,** resolved only by `fitWorkerPack`'s `DROP_ORDER`, never by truncation. Protected-section overflow throws.
6. **Composition is one named function wired as `prompt`.** `createWorkerFactory` wires `composeWorkerInstruction` (or the name chosen at implementation, recorded in the commit) as `AgentRunnerDeps.prompt` and does not assemble instruction text itself. `systemPrompt`, if set, is task-invariant.
7. **A candidate's recorded model is the model that ran it,** on `Candidate.model`, on the `worker.started` payload and actor, and on every `candidate.*` actor.
8. **One truth for the candidate's model:** the `ModelRef` on the persisted transcript and the one on the `Candidate` record are the same and come from one selection.
9. **Candidates remain distinguishable** by `Candidate.id`; `index` stays on `CandidateResult` and `worker.started` and is not added to `Candidate`.
10. **The composed protocol's hash is persisted** on the `AgentTranscript` for that candidate, alongside the model `persistResult` already writes.
11. **The reviewer protocols carry the bounded-acceptance rule** (finding 23, reviewer half): acceptance is judged against the frozen contract, and a constructed counter-implementation blocks only when it is a plausible omission or simplification rather than a branch on state unrelated to what it changes.

**Boundary, not an invariant:** no item 18 loop change, no item 11 judge provider, no items 12/17/21/22/25, no C-tasks, no `scout`, no `ProtocolAppliesToSchema` widening, no FSM change, no Composer, no live-paid providers.

## PHASE_REQUIRED

1. Implement MC1–MC11.
2. Every acceptance check about what a worker or reviewer receives MUST capture the request at the provider boundary from a run driven through production composition. Calling `buildWorkerContextPack` and asserting on its return value does not satisfy any of them — that is what already passes today.
3. The candidate's model MUST be observed from the persisted event log.
4. State the chosen production cap and show the arithmetic of *The arithmetic is tight* against `agent.maxTurns` and the effective task budget.
5. Record in `docs/ledger/B-selfhost-remaining.md` the measured first-request size before and after, so item 18's projection is re-derived against the new baseline.
6. Tests in `src/daemon/*.test.ts`, `src/context/*.test.ts`, `src/protocols/*.test.ts`, `src/review/*.test.ts`, `src/engine/*.test.ts`. No `src/e2e/**`.
7. `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm vitest run --maxWorkers=2 && pnpm build` on Node 24.20.0.

## Acceptance checks

1. **Composed instruction at the provider:** drive a task through production composition and capture the first `complete` request. It contains the hierarchy, the base policy, the acceptance lines, and the selected task protocol's body. A second drive with `kind: "investigation"` contains the `investigate` body and not the first kind's body.
2. **Fencing:** with a VALID finding associated with the task, the captured request delimits it with `BEGIN UNTRUSTED` / `END UNTRUSTED` and carries the never-follow clause.
3. **Injection stays fenced:** a finding whose claim is shaped like an instruction appears only inside the fenced region of the captured request.
4. **Task-kind mapping is total:** every `TaskKind`, including `investigation`, composes without throwing and selects the protocol named for it.
5. **Reviewer axis mapping is total:** for every `ReviewAxis`, the system message captured at the reviewer provider derives from the mapped role protocol's body; none falls back silently.
6. **The inline reviewer prompt is gone:** `src/review/swarm.ts` no longer contains the literal "You are an independent … reviewer. Return JSON only…", and the captured system message contains the mapped role body and the MC11 sentence.
7. **The cap binds at the provider:** with a cap small enough that droppable evidence must go and large enough for the protected sections, the captured first request is within the cap by `estimateTokens`, still contains hierarchy, mission, base policy and task, and the sections dropped follow `DROP_ORDER`.
8. **Protected overflow throws:** a fixture whose protected sections alone exceed the cap raises `BUDGET_EXCEEDED`.
9. **Second task gets its own pack:** one `AgentRunner` from the factory runs task A then task B; the second captured request carries B's acceptance and protocol and none of A's evidence.
10. **Candidate model is real:** the persisted `candidate.created` and `worker.started` carry the same `ModelRef` the factory handed to `AgentRunner`, and no event has `model.provider === "worker"`. Match on the model field, not on `actor.kind`.
11. **Transcript and record agree:** `Candidate.model` comes from `CandidateResult.model` and the transcript's model from `AgentRunner`'s own dep; the two recordings are equal. `toCandidate` must not read the transcript.
12. **Protocol hash persisted:** the `agent_transcript` artifact for that candidate carries the hash the seam produced for that task.
13. **The reviewer protocols state the rule:** the `reviewer-*` bodies contain MC11's sentence, and AC6 shows it reaching the provider.
14. **Regression:** the existing protocol, context, review, agent, composition and candidate-driver suites stay green; expectation updates are permitted only where a hardcoded `provider: "worker"` forces them.
15. Gates per PHASE_REQUIRED 7.

## Anti-fake notes for reviewers

- **Calling `buildWorkerContextPack` in a test proves nothing.** The finding is that it exists and nothing calls it. Everything must be captured at the provider boundary.
- **A constant system prompt** satisfies "the worker gets a hierarchy" while composing nothing. AC1's two-kinds clause is what kills it.
- **Mapping every axis to `reviewer-correctness`** makes a total-mapping check pass while defeating it. AC5 requires the body to match the axis's own role.
- **A cap enforced by truncating the final string** destroys the hierarchy. AC7 requires `DROP_ORDER`, AC8 requires the throw.
- **Adopting `maxPackTokens`' existing 60_000 default** satisfies "a configured cap" and never binds. PHASE_REQUIRED 4 is what catches it.
- **Propagating the model to `Candidate.model` but not to the event actors** leaves the observer rendering "Candidate 0". AC10 covers the whole event stream.
- **Re-selecting from the router in `toCandidate`** yields a real-looking ref that can disagree with the one that ran. AC11 catches it.
- **Filling the record from the transcript** makes AC11 a tautology. The contract forbids it; check the implementation, not only the assertion.
- **Putting the pack in `systemPrompt`** freezes the first task's evidence for the candidate's lifetime. AC9 is what catches it.
