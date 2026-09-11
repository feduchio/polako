# B-selfhost-9 + 19 — the production worker runs with no instruction hierarchy, and candidates are labelled with a model that does not exist

**Status:** FROZEN CONTRACT — not implemented, not accepted
**Class:** PHASE_REQUIRED with MISSION_CRITICAL invariants
**Exact base:** the merged `phase-c-collab` head carrying accepted B-selfhost-8 code (identical to `14beb802857fde8a5251404dc518301cb5b1a0a4`) plus the ledger
**Source findings:** `docs/ledger/B-selfhost-remaining.md` items **9** and **19**, plus the reviewer-protocol half of item **23**

Frozen at revision 3, after two independent reviews both returned DO NOT FREEZE. Revision 1 was returned for an unsatisfiable composition requirement, an invariant demanding a field that does not exist, and acceptance checks that already passed on this tree. Revision 2 was returned for a token-budget rule that contradicted its own MC1, and for an acceptance check that would have broken every reviewer response in production while passing. Both sets of edits are applied. After freeze, do not rewrite.

Two findings in one contract because both rewrite `createWorkerFactory` (`src/daemon/composition.ts:552-570`). Not item 18. Not item 11. Not items 12/17/21/22/25. Not C7.

## Authority

1. Finding 19: protocol composition and worker context packs are built and tested but have no production caller.
2. Finding 9: candidate provenance is `worker/candidate-N`.
3. Finding 23, reviewer-protocol half only. The detector half is not in scope.
4. Base behaviour as in `src/daemon/composition.ts`, `src/agents/runner.ts`, `src/context/worker.ts`, `src/protocols/**`, `src/review/swarm.ts`, `src/engine/candidateDrivers.ts`, `src/engine/candidates.ts`.

## Defect

### 19 — the instruction hierarchy exists and nothing uses it

`createWorkerFactory` constructs `AgentRunner` with neither `systemPrompt` nor `prompt` (`src/daemon/composition.ts:560-568`), so the first message is one `user` message whose entire content is `task.description` (`src/agents/runner.ts:45-47`). No base engineering policy, no hierarchy, no acceptance block, no fencing of repository content as untrusted.

All of it exists and is tested: `src/context/worker.ts:23-38`, `buildWorkerContextPack` (`:44`), `fenceUntrusted` (`:156-162`), `fitWorkerPack` (`:164-198`), `ProtocolRegistry.load` (`src/protocols/loader.ts:17`), `compose` (`src/protocols/composer.ts:51`), `fitToBudget` (`:80`). Verified on this base: none has a non-test caller.

`runAxisReview` hardcodes its reviewer system prompt inline (`src/review/swarm.ts:64-69`). Reviewers fence their payload (`:60`); workers do not fence at all.

### 9 — the candidate's model is a label, not a fact

The real `ModelRef` is selected in `createWorkerFactory` (`src/daemon/composition.ts:553-558`) and handed to `AgentRunner`, which records it on the transcript. `toCandidate` separately hardcodes `model: { provider: "worker", model: \`candidate-${index}\` }` (`src/engine/candidateDrivers.ts:508`), and the same literal goes into `worker.started` (`:134`, `:136`) and every `candidate.*` actor. One candidate, two model identities.

## Definitions and boundaries

**Worker composition cannot use `compose()`.** `compose` requires a `role` and validates `kind: role` (`src/protocols/composer.ts:51-71`). The tree has eleven role protocols — five `reviewer-*`, plus `evidence-agent`, `defender`, `planner`, `scope-guardian`, `judge`, `prosecutor` — and none applies to a worker. Authoring a worker role is out of scope. The seam assembles base + task protocol + optional domains itself and attaches no role. Passing `planner` or `judge` as a stand-in is forbidden.

**Reviewers must not call `compose()` either.** `runAxisReview` has a `ReviewAxis`, not a `TaskProtocolName`, and a checkpoint's `taskId` is nullable (`src/domain/checkpoint.ts:32`). It loads the mapped `reviewer-*` role protocol directly.

**Two name mappings are not identities.** `TaskKindSchema` is `bugfix | feature | refactor | simplify | investigation` (`src/domain/task.ts:34`); `TaskProtocolNameSchema` is `bugfix | feature | refactor | simplify | investigate` (`src/protocols/types.ts:31-37`). `ReviewAxisSchema` has eight members (`src/domain/finding.ts:6-15`); only five have a `reviewer-*` protocol. Production selects `DEFAULT_REVIEW_AXES` — `correctness`, `regression`, `adversarial` (`src/domain/review.ts:6`) — plus configured extras.

**The arithmetic is tight, and the cap is derived, not constant.** The effective task budget is `budget.maxTaskTokens ?? 32_000` (`src/daemon/composition.ts:566`). `agent.maxTurns` defaults to 32 but finding 18 measured that no loop reaches it: real loops ran 10–18 turns, mean 14.2, and 3 of 6 ended `BUDGET_EXCEEDED` at 32.4k–34.4k. A pack of P tokens is resent every turn, so it does not overrun the budget — `runLoop`'s guard is `totalTokens < maxTokens` — it **displaces turns**. Calibrated against that data, P = 1,000 costs 19.8% of the turns and P = 1,500 costs 27.9%.

A fixed constant is unsafe at any value: `task` and `mission` are protected, not in `DROP_ORDER`, and both are LLM-authored with no schema bound. Measured on this base by `estimateTokens` (`length / 4`): protected sections are 425 tokens for an e2e-fixture-scale task and **1,093** for a self-host-scale task with a real mission interpretation (`task` 459, `mission` 289, `basePolicy` 241, `instructionHierarchy` 90). The cap is therefore derived:

`maxPackTokens = clamp(floor(effectiveTaskBudget / 24), 1_000, config.contextBudget.maxPackTokens)`

which is **1,333** at production defaults and scales with an operator who raises the budget. A conforming implementation states this number, shows the measured worst case in scope against it, and states the resulting turn-count loss. `config.contextBudget.maxPackTokens` (default 60_000, `src/domain/config.ts:91`) remains the ceiling only; adopting it as the cap satisfies the letter and protects nothing. `config.contextBudget.workerPackFraction` (0.4, `:87`) also has no caller and is likewise forbidden as the cap — the context window is a model property and does not bound the task budget. `fitToBudget` must not be the enforcer: declared `budget_tokens` overstate real bodies by 3–7× on this tree (`base-engineering-policy` declares 800 and renders to 188).

**No interpretation is passed to the pack.** The `mission` section is protected, unbounded, and not required by MC1. Excluding it reduces the measured self-host protected floor from 1,093 to **804**, and the worst case in scope — self-host-scale task, base + task protocol + both domains — to **1,062**, leaving 271 tokens of headroom at the derived default.

**Consequence for item 18, to be recorded.** Finding 18 measured the break-even for a per-turn constant at ~1,250 tokens. A conforming pack occupies nearly all of it. Item 18's projection must be re-derived from the post-change baseline, not the pre-change one.

**`fitWorkerPack` is the enforcer and its throw is the specified outcome.** Droppable sections go in `DROP_ORDER`; protected overflow throws `BUDGET_EXCEEDED` (`src/context/worker.ts:193-198`).

**The registry is loaded once and injected.** `ProtocolRegistry.load` is synchronous `readdirSync` + `readFileSync` over every protocol directory. It is loaded once in `ProductionDeps` and passed to both the worker seam and `runAxisReview`, which gains a field for it. Loading it per call or per axis is forbidden. `composeWorkerInstruction` lives in `src/daemon/` or `src/context/`: `.dependency-cruiser.cjs`'s `agents-depends-only-on-allowed` rule (`:78-83`) does not permit `src/agents/ → src/protocols/`, and `pnpm deps:check` is a gate.

**`prompt` carries the task, `systemPrompt` does not.** `systemPrompt` is fixed at construction; `prompt` is per task. Everything task-dependent belongs in `prompt`.

**Item 9 is a propagation, not a re-selection.** Do not re-select from the router and do not read the transcript to fill the record.

**Not item 18.** No change to message accumulation, token accounting, or per-call `maxTokens`.

**Not item 11.** This contract does not compose `judge`; item 11 does. `PHASE-C.md`'s ordering note is already superseded.

**Not C7.** No `scout`, no widening of `ProtocolAppliesToSchema`.

## MISSION_CRITICAL invariants

1. **A production worker receives a composed instruction.** For every task, the first provider request contains the instruction hierarchy, the base engineering policy, that task's acceptance criteria, and the body of the task protocol selected by the `TaskKind → TaskProtocolName` map. The selected task protocol's body is **protected**: the seam places it where `DROP_ORDER` cannot reach it, so a binding cap can never silently remove it, and protected overflow throws instead. `task.description` alone is not the whole instruction, and two task kinds produce two requests **whose task protocol bodies differ** — a differing `kind` label in the task block does not satisfy this.
2. **Repository content reaches a worker fenced as untrusted,** with the never-follow clause, whenever such content is supplied.
3. **The task-kind mapping is total and explicit,** including `investigation → investigate`, via `satisfies Record<TaskKind, TaskProtocolName>`.
4. **The reviewer axis mapping is total and explicit,** via `satisfies Record<ReviewAxis, string>`, and a runtime assertion resolves every one of the eight targets in the registry, since the value type is `string` and the type system cannot check it. Unmapped axes may point at an existing `reviewer-*` role; the table must name the target. Silent default, or no role, is forbidden.
5. **A successfully assembled pack is within the derived cap,** resolved only by `DROP_ORDER`, never by truncation. The cap binds on the text actually sent: `estimateTokens` over the concatenated content of every message in the first provider request, `systemPrompt` included. Protected-section overflow throws.
6. **Composition is one named function wired as `prompt`.** `createWorkerFactory` wires `composeWorkerInstruction` as `AgentRunnerDeps.prompt` and does not assemble instruction text itself. `systemPrompt`, if set, is task-invariant.
7. **A candidate's recorded model is the model that ran it,** on `Candidate.model`, on the `worker.started` payload and actor, and on every `candidate.*` actor. `runOneCandidate` resolves the worker, and therefore the model, **before** `sandbox.create`, so every `CandidateResult` carries a `ModelRef` including the failure paths; `CandidateResult.model` is non-nullable and `toCandidate` needs no fallback. `CandidateWorker` and `ScriptedCandidateWorker` are widened accordingly, as is the non-factory `worker` input path of `runCandidatesParallel`.
8. **One truth for the candidate's model:** the `ModelRef` on the persisted transcript and the one on the `Candidate` record are equal and come from one selection.
9. **Candidates remain distinguishable** by `Candidate.id`; `index` stays on `CandidateResult` and `worker.started` and is not added to `Candidate`.
10. **The composed protocol's hash is persisted** on the `AgentTranscript` for that candidate. It reaches `persistResult` by widening `AgentRunnerDeps.prompt` to `(task: Task) => { text: string; protocolHash: string | null }`. A closure variable mutated from inside `prompt` is forbidden: a runner is reusable across tasks and a side channel makes the agreement check order-dependent.
11. **The reviewer protocols carry the bounded-acceptance rule** (finding 23, reviewer half): acceptance is judged against the frozen contract, and a constructed counter-implementation blocks only when it is a plausible omission or simplification rather than a branch on state unrelated to what it changes.

**Boundary, not an invariant:** no item 18 loop change, no item 11 judge provider, no items 12/17/21/22/25, no C-tasks, no `scout`, no `ProtocolAppliesToSchema` widening, no FSM change, no Composer, no live-paid providers.

## PHASE_REQUIRED

1. Implement MC1–MC11.
2. Every acceptance check about what a worker or reviewer receives MUST capture the request at the provider boundary from production composition. Calling `buildWorkerContextPack` and asserting on its return value satisfies none of them — that already passes today. Driving `createWorkerFactory(deps, ctx)` counts as production composition; a hand-built `AgentRunner` does not.
3. The candidate's model MUST be observed from the persisted event log.
4. State the derived cap's value at production defaults, the measured worst case in scope against it, and the resulting turn-count loss.
5. Record in `docs/ledger/B-selfhost-remaining.md` the measured first-request size before and after, **and** that the pack now occupies nearly all of finding 18's measured ~1,250-token per-turn break-even, so item 18's projection is re-derived from the new baseline.
6. Tests in `src/daemon/*.test.ts`, `src/context/*.test.ts`, `src/protocols/*.test.ts`, `src/review/*.test.ts`, `src/engine/*.test.ts`. No `src/e2e/**`.
7. `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm vitest run --maxWorkers=2 && pnpm build` on Node 24.20.0 — the shell must `nvm use 24.20.0` first.

## Acceptance checks

1. **Composed instruction at the provider:** drive a task through production composition and capture the first `complete` request. It contains the hierarchy, the base policy, the acceptance lines, and the selected task protocol's body. A second drive with `kind: "investigation"` contains the `investigate` body and not the first kind's body.
2. **Fencing:** the finding supplied to the pack is selected by `task.origin.findingId` when the origin is `valid_finding`, not by a substring match of the evidence path against `task.description`. With such a task the captured request delimits the finding with `BEGIN UNTRUSTED` / `END UNTRUSTED` and carries the never-follow clause. `buildWorkerContextPack`'s existing filter — `taskFiles.has(e.path) || task.description.includes(e.path)` — cannot select a finding in production, because `FileFragment` has no producer anywhere in `src/**` and `taskFiles` is therefore always empty.
3. **Injection stays fenced:** a finding whose claim is shaped like an instruction appears only inside the fenced region.
4. **Task-kind mapping is total:** every `TaskKind`, including `investigation`, composes without throwing and selects the protocol named for it.
5. **Reviewer axis mapping is total:** for every one of the eight `ReviewAxis` values, the system message captured at the reviewer provider derives from the mapped role protocol's body. Calling `runAxisReview` per axis with a capturing provider satisfies PHASE_REQUIRED 2; production's `resolveAxes` returns only the three defaults, so driving the review driver cannot reach all eight.
6. **The reviewer prompt is composed and the output contract survives:** `runAxisReview`'s system message is assembled from the mapped `reviewer-*` role body plus the JSON output contract, and the captured system message contains the role body, the MC11 sentence, and the field list `RawFindingSchema` parses (`criterion`, `severity`, `blocking`, `claim`, `evidence`, `reproduction`, optional `suggestedCheck`). **No `reviewer-*` body on this base contains any output-format instruction** — the only near-match is the prose "Severity labels required" — so removing the inline literal without relocating that contract makes every reviewer response fail `RawFindingSchema.parse` in production while this check passes. The output contract moves to one shared constant or into the role bodies. A check that the literal is absent from `src/review/swarm.ts` is **not** part of this criterion: it has finding 22's hole. The reviewer request stays exactly two messages, so the base policy, if prepended, goes inside the system message.
7. **The cap binds at the provider:** with a cap small enough that droppable evidence must go and large enough for the protected sections, `estimateTokens` over the concatenated content of every message in the captured first request is within the cap; the request still contains the hierarchy, the base policy, the task block and the selected task protocol body; and the sections dropped follow `DROP_ORDER` over the entries the fixture actually supplied.
8. **Protected overflow throws:** a fixture whose protected sections alone exceed the cap raises `BUDGET_EXCEEDED`.
9. **Protected overflow is diagnosable, not a silent task death:** the cap and the task are the same for all N candidates, so every candidate fails identically — `runOneCandidate` catches at `src/engine/candidates.ts:206`, giving `status: "error"` → `DISCARDED` → zero survivors → retry → the same throw until `retry.maxAttempts`. The captured candidate error names `BUDGET_EXCEEDED` with the required and available token counts, and a run-visible event distinguishes it from a sandbox or gate failure.
10. **Second task gets its own pack:** one `AgentRunner` from the factory runs task A then task B; the second captured request carries B's acceptance and protocol and none of A's evidence.
11. **Candidate model is real:** across the whole run's event list, `candidate.created` and `worker.started` carry the same `ModelRef` the factory handed to `AgentRunner`, and no event has `model.provider === "worker"`. Match on the model field, not on `actor.kind`.
12. **Transcript and record agree:** `Candidate.model` comes from `CandidateResult.model` and the transcript's model from `AgentRunner`'s own dep; the two recordings are equal. Retrieve the transcript through `candidate.transcriptRef` — `persistResult` labels the artifact `${runId}:${taskId}`, which N candidates share.
13. **Protocol hash persisted:** the `agent_transcript` artifact for that candidate carries the hash the seam produced for that task.
14. **The reviewer protocols state the rule:** the `reviewer-*` bodies contain MC11's sentence.
15. **Regression:** the existing protocol, context, review, agent, composition and candidate-driver suites stay green. Expectation updates are permitted only where a hardcoded `provider: "worker"` forces them — there are exactly four such sites — and at `src/review/swarm.test.ts:48`, which asserts the reviewer request has exactly two messages.
16. Gates per PHASE_REQUIRED 7.

## Anti-fake notes for reviewers

- **Calling `buildWorkerContextPack` in a test proves nothing.** The finding is that it exists and nothing calls it.
- **A constant system prompt** satisfies "the worker gets a hierarchy" while composing nothing. AC1's two-kinds-differ-by-body clause kills it.
- **A differing `kind` label** in the task block makes two requests differ without any protocol being composed. MC1 requires the bodies to differ.
- **Mapping every axis to `reviewer-correctness`** makes a total-mapping check pass while defeating it. AC5 requires the body to match the axis's own role.
- **Relocating the inline reviewer literal to a sibling module** and concatenating it passes any static absence check. That is why AC6 does not contain one.
- **A cap enforced by truncating the final string** destroys the hierarchy. AC7 requires `DROP_ORDER`, AC8 the throw.
- **Fitting the pack and then adding a `systemPrompt`** keeps the pack within the cap while the request exceeds it. MC5 binds on the sent text.
- **Adopting `maxPackTokens`' 60_000, or `workerPackFraction`,** satisfies "a configured cap" and never binds.
- **Propagating the model to `Candidate.model` but not to the event actors** leaves the observer rendering "Candidate 0". AC11 covers the whole event stream.
- **Re-selecting from the router in `toCandidate`,** or filling the record from the transcript, makes AC12 a tautology. Neither is observable from the assertion; read the implementation.
- **Putting the pack in `systemPrompt`** freezes the first task's evidence for the candidate's lifetime. AC10 catches it.
- **A closure side channel for `protocolHash`** makes AC13 order-dependent. MC10 forbids it.
