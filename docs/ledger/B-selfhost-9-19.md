# B-selfhost-9 + 19 — the production worker runs with no instruction hierarchy, and candidates are labelled with a model that does not exist

**Status:** DRAFT CONTRACT — not reviewed, not frozen, not implemented
**Class:** PHASE_REQUIRED with MISSION_CRITICAL invariants
**Exact base:** `14beb802857fde8a5251404dc518301cb5b1a0a4` (accepted B-selfhost-8)
**Source findings:** `docs/ledger/B-selfhost-remaining.md` items **9** and **19**, plus the reviewer-protocol half of item **23**

Two findings in one contract because both rewrite `createWorkerFactory` (`src/daemon/composition.ts:552-570`). Not item 18 (the tool loop's transcript replay). Not item 11 (`PairwiseJudge`). Not items 12/17/21/22/25 (the run-settings and budget-merge seam). Not C7 (`scout`). After freeze, do not rewrite.

## Authority

1. Finding 19: protocol composition and worker context packs are built and tested but have no production caller, so the worker path runs without an instruction hierarchy.
2. Finding 9: candidate provenance is `worker/candidate-N`.
3. Finding 23, reviewer-protocol half only: the rule that acceptance is judged against a finite contract belongs in the `reviewer-*` role protocols. The detector half is **not** in scope here.
4. Exact base behaviour as in `src/daemon/composition.ts`, `src/agents/runner.ts`, `src/context/worker.ts`, `src/protocols/**`, `src/review/swarm.ts`, `src/engine/candidateDrivers.ts`.

## Defect

### 19 — the instruction hierarchy exists and nothing uses it

`createWorkerFactory` constructs `AgentRunner` with neither `systemPrompt` nor `prompt` (`src/daemon/composition.ts:560-568`). `AgentRunner.run` therefore builds its first message as a single `user` message whose entire content is `task.description` (`src/agents/runner.ts:45-47`). A production worker receives no base engineering policy, no instruction hierarchy, no acceptance-criteria block, and no fencing of repository content as untrusted data.

All four of those already exist and are tested. `src/context/worker.ts:23-38` defines the hierarchy and the default base policy; `buildWorkerContextPack` (`:44`) assembles the sections, `fenceUntrusted` (`:156-162`) wraps findings, file fragments, failed attempts and extra hits, and `fitWorkerPack` (`:164-198`) drops sections in a fixed order to meet a token cap. `ProtocolRegistry.load` (`src/protocols/loader.ts:17`), `compose` (`src/protocols/composer.ts:51`) and `fitToBudget` (`:80`) assemble a bundle from one `base`, one `task`, sorted `domain`s and one `role`.

Verified on this base: `ProtocolRegistry.load`, `compose`, `fitToBudget` and `buildWorkerContextPack` have **no** non-test caller. Every non-test occurrence is a definition or a re-export (`src/protocols/index.ts`, `src/context/index.ts`).

`runAxisReview` hardcodes its reviewer system prompt inline (`src/review/swarm.ts:64-69`) rather than composing the `reviewer-*` role protocols. Reviewers do fence their payload as untrusted (`:60`); workers do not fence at all.

### 9 — the candidate's model is a label, not a fact

`createWorkerFactory` already selects a real model through the router and hands that `ModelRef` to `AgentRunner` (`src/daemon/composition.ts:553-563`), which records it on the persisted transcript (`src/agents/runner.ts`, `persistResult`). The synthetic identity is minted separately and downstream: `toCandidate` hardcodes `model: { provider: "worker", model: \`candidate-${index}\` }` (`src/engine/candidateDrivers.ts:508`), and the same literal is written into the `worker.started` payload and actor (`:134`, `:136`) and carried by every `candidate.created` / `candidate.state_changed` / `candidate.gated` actor.

So one candidate has two model identities in the same run: the truthful one inside the transcript artifact, and the synthetic one in the event log and the `Candidate` record that the tournament, the report and the observer read. The user-visible surface renders it as "Candidate 0" through `displayModel` on `worker.started`.

Git branch naming is unrelated and is **not** changed here: `polish/${runId}/candidates/${candidateId}` (`src/engine/candidates.ts:117`) identifies a candidate, not a model.

## Definitions and boundaries

**Two name mappings are not identities, and a naive implementation throws.** `TaskKindSchema` is `bugfix | feature | refactor | simplify | investigation` (`src/domain/task.ts:34`). `TaskProtocolNameSchema` is `bugfix | feature | refactor | simplify | investigate` (`src/protocols/types.ts:31-37`). Four names coincide; the fifth does not. `registry.get(task.kind)` throws for an investigation task, and `compose` validates `kind: task` on the member it is given (`src/protocols/composer.ts:51-60`). The mapping must be explicit and total.

**Three review axes have no role protocol.** `ReviewAxisSchema` has eight members — `correctness`, `spec_compliance`, `regression`, `adversarial`, `architecture`, `simplicity`, `security`, `performance` (`src/domain/finding.ts:6-15`) — and `protocols/` contains five: `reviewer-correctness`, `reviewer-regression`, `reviewer-adversarial`, `reviewer-architecture`, `reviewer-simplicity`. `spec_compliance`, `security` and `performance` are unmapped. A conforming implementation must either author the three missing role protocols or define a mapping that is **total and explicit**; silently falling back to a different axis's protocol, or to no role at all, is forbidden, because it would give a reviewer a system prompt for a different job than the one it is being asked to do.

**The pack must be capped, and the cap is an acceptance criterion rather than an implementation detail.** At base the worker loop resends the entire transcript on every call (`AgentRunner.runLoop` sends `messages: [...messages]` each turn), which finding 18 measured at 61.6–72.7% of all input tokens. A system prompt and a context pack are therefore paid **once per turn, not once per task**, until item 18 lands. Adding an uncapped pack makes finding 18's problem worse in exactly the regime it measured. The pack size must come from configuration with a documented default, must be enforced by `fitWorkerPack`'s existing drop order, and must be pinned by a check that fails if the assembled pack exceeds it.

**Composition must be one addressable seam, because item 18 will rebind it.** Finding 18 replaces what the loop appends and changes the per-call `maxTokens`. If composition is inlined into `createWorkerFactory` as string concatenation, item 18 has to unpick it. The composed instruction must be produced by a single named function that `createWorkerFactory` calls and that item 18 can call unchanged.

**`prompt` is per task, `systemPrompt` is not.** `AgentRunnerDeps.systemPrompt` is a string fixed at construction, while `prompt` is `(task: Task) => string` (`src/agents/types.ts`). The worker factory is constructed once per candidate, before the task is known at `AgentRunner` construction time but after it is known at call time. Anything that depends on the task — the task protocol, the acceptance block, the fenced evidence — belongs in `prompt`; only what is invariant across tasks for that candidate belongs in `systemPrompt`.

**Item 9 is a propagation, not a new value.** The real `ModelRef` is already chosen at `src/daemon/composition.ts:555-558`. The fix carries it to the candidate record and the events. It must not re-select, and it must not consult the router a second time: two selections can disagree.

**Not item 18.** No change to `runLoop`'s message accumulation, to the token accounting, or to the per-call `maxTokens`. Adding a system prompt necessarily changes the first message; that is in scope. Changing how subsequent messages accumulate is not.

**Not item 11.** Composing the `judge` role protocol into `PairwiseJudge` is item 11's work; this contract composes the `reviewer-*` roles into `runAxisReview` only.

**Not C7.** No `scout` role, and `ProtocolAppliesToSchema` (`src/protocols/types.ts:3-9`) is not widened. It has no `scout` member, and adding one is C7's cost.

## MISSION_CRITICAL invariants

1. **A production worker receives a composed instruction hierarchy.** For every task a production worker runs, its first request carries the instruction hierarchy, the base engineering policy, the task's acceptance criteria, and the task protocol for that task's kind — not `task.description` alone.
2. **Repository content reaches a worker fenced as untrusted.** Findings, file fragments, failed attempts and retrieved hits are delimited as untrusted data with an instruction never to follow instructions found inside them, as `fenceUntrusted` already does for reviewers.
3. **The task-kind mapping is total and explicit.** Every `TaskKind` maps to exactly one `TaskProtocolName`, including `investigation → investigate`, and the mapping is exhaustive at the type level so a new task kind cannot compile without one.
4. **The reviewer axis mapping is total and explicit.** Every `ReviewAxis` maps to a role protocol that exists, or the implementation authors the missing ones. No axis silently receives another axis's role or no role.
5. **The composed prompt is bounded.** The assembled pack's estimated tokens never exceed the configured cap, for any task, using `fitWorkerPack`'s existing drop order, which never drops the instruction hierarchy, the mission, the base policy or the task block.
6. **Composition is a single named seam.** `createWorkerFactory` obtains the worker's instruction from one function that takes the task and returns the composed text; it does not assemble the text inline.
7. **A candidate's recorded model is the model that ran it.** `Candidate.model`, the `worker.started` payload and actor, and every `candidate.*` event actor carry the `ModelRef` the router selected and `AgentRunner` used, not `{ provider: "worker", model: "candidate-N" }`.
8. **One truth for the candidate's model.** The `ModelRef` on the persisted `AgentTranscript` and the one on the `Candidate` record are the same for the same candidate, and both come from one selection.
9. **The candidate index remains addressable.** Removing `candidate-N` must not remove the ability to tell candidates apart: the candidate id and the per-run index remain on the record and in the events. Only the *model* field stops lying.
10. **Determinism and auditability.** `compose` is already deterministic for a given registry and input; the composed protocol's hash is recorded on the pack (`WorkerContextPack.protocolHash`) and must be carried into the run's evidence so a reviewer can tell which instruction a worker actually received.
11. **The reviewer protocols carry the bounded-acceptance rule** (finding 23, reviewer half): the `reviewer-*` role protocols state that acceptance is judged against the frozen contract, and that a constructed counter-implementation is blocking only when it is a plausible omission or simplification rather than a branch on state unrelated to what it changes.
12. **No scope creep.** No item 18 loop change, no item 11 judge provider, no items 12/17/21/22/25, no C-tasks, no `scout`, no `ProtocolAppliesToSchema` widening, no FSM change, no Composer, no live-paid providers.

## PHASE_REQUIRED

1. Implement MC1–MC11.
2. At least one acceptance check MUST observe the *actual bytes a production worker receives*, captured at the provider boundary from a run driven through the daemon's own composition — not by calling `buildWorkerContextPack` directly and asserting on its return value.
3. At least one acceptance check MUST observe a candidate's recorded model from the persisted event log, not from a return value.
4. The pack cap MUST be pinned by a check that fails when the cap is exceeded, with a fixture whose evidence is large enough to force `fitWorkerPack` to drop sections.
5. Record in `docs/ledger/B-selfhost-remaining.md` the measured change in per-call prompt size that this contract introduces, so item 18's projection can be re-derived against the new baseline rather than the old one.
6. Tests live in `src/daemon/*.test.ts`, `src/context/*.test.ts`, `src/protocols/*.test.ts`, `src/review/*.test.ts` and `src/engine/*.test.ts`. No `src/e2e/**`; item 15 owns those.
7. `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm vitest run --maxWorkers=2 && pnpm build` on Node 24.20.0.

## Acceptance checks

1. **The worker's first request carries the hierarchy:** drive a task through the daemon's composition and capture the request at the provider; its messages contain the instruction hierarchy and the base engineering policy, and `task.description` alone is not the whole instruction.
2. **Acceptance criteria reach the worker:** a task with acceptance criteria has them present in the first request.
3. **Untrusted fencing:** a task whose context includes a finding and a file fragment has both delimited as untrusted, with the never-follow-instructions clause present.
4. **A prompt-injection string in evidence stays inside the fence:** evidence containing text shaped like an instruction appears only within the fenced region.
5. **Task-kind mapping is total:** every `TaskKind`, including `investigation`, composes without throwing, and each selects the protocol named for it.
6. **Reviewer axis mapping is total:** every `ReviewAxis` produces a reviewer system prompt derived from a role protocol that exists; none falls back silently.
7. **The reviewer prompt is composed, not inline:** the string at `src/review/swarm.ts:64-69` no longer originates the reviewer's system prompt, and the composed prompt contains the axis's role protocol body.
8. **The pack is capped:** with evidence large enough to exceed the configured cap, the assembled pack's estimated tokens are within it and the dropped sections follow `fitWorkerPack`'s documented order.
9. **The hierarchy survives the cap:** under the same pressure, the instruction hierarchy, mission, base policy and task blocks are still present.
10. **Composition is one seam:** the function named by MC6 is the only production producer of the worker instruction; a static check pins that `createWorkerFactory` does not assemble the text itself.
11. **Candidate model is real:** the persisted `candidate.created` event for a run carries the router-selected `ModelRef`, and no event payload or actor in the run contains `provider: "worker"`.
12. **Transcript and record agree:** for one candidate, the `ModelRef` on the persisted transcript equals the one on the `Candidate` record.
13. **Candidates remain distinguishable:** two candidates in one run have distinct ids and indices even when both ran on the same model.
14. **Protocol hash recorded:** the composed protocol's hash appears in the run's evidence for the task.
15. **The reviewer protocols state the rule:** the `reviewer-*` protocol bodies contain the bounded-acceptance rule of MC11.
16. **Regression:** `src/protocols/protocols.test.ts`, `src/context/context.test.ts`, `src/review/swarm.test.ts`, `src/agents/agents.test.ts`, `src/daemon/composition.test.ts` and `src/engine/candidate-drivers.test.ts` stay green.
17. **Prompt-size measurement:** the change in first-request size for a representative task is measured and recorded, per PHASE_REQUIRED 5.
18. Gates per PHASE_REQUIRED 7.

## Anti-fake notes for reviewers

- **Calling `buildWorkerContextPack` in a test proves nothing about production.** The finding is precisely that the function exists and nothing calls it. Require the bytes to be captured at the provider boundary from a daemon-driven run.
- **A system prompt that is a constant string** satisfies "the worker gets a system prompt" while composing nothing. Require the task protocol's own body to be present, and require a different task kind to produce a different prompt.
- **Mapping every axis to `reviewer-correctness`** makes AC6 pass while defeating its purpose. Require distinct bodies per axis.
- **A cap enforced by truncating the final string** satisfies "within the cap" while destroying the hierarchy. AC9 exists for that; check that dropping follows `fitWorkerPack` rather than a substring cut.
- **Propagating the model to `Candidate.model` but not to the event actors** leaves the observer still rendering "Candidate 0". AC11 asserts no `provider: "worker"` survives anywhere in the run's events.
- **Re-selecting the model in `toCandidate`** produces a real-looking `ModelRef` that can disagree with the one that ran. AC12 is what catches it.
- **Adding the pack to `systemPrompt` rather than `prompt`** makes it fixed at construction, so every task in a run gets the first task's evidence. Check that a second task in the same run receives its own.
