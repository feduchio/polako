# Remaining Phase-B findings for self-host (not deferred, not optional)

These are VALID composition defects reproduced in the Phase-B re-anchor chat. They stay Phase B. They are **not** implemented as C1–C11.

Use as Mission Acceptance Corpus / explicit contracts for the self-host mission. Do not treat a previous PASS ledger as proof.

## Launch blockers (must not skip)

1. **User-pinned Supervisor Council** — ACCEPTED with host pins in `~/.polish/polish.toml`.
2. **Bounded discovery + probe INCONCLUSIVE + agent.maxTurns** — ACCEPTED, `docs/ledger/B-bootstrap-discovery.md`.
2b. **Cost eligibility + production reviewer routing** — ACCEPTED, `docs/ledger/B-bootstrap-cost-eligibility.md`. Finding 10 (`listModels()[0]`) lifted here.

## Remaining composition defects (self-host dogfood)

Full Phase-B self-host closure is **DEFERRED_BY_USER** until operator observability/resilience is mature enough for multi-hour unattended work. These items remain OPEN. They are not optional and are not fixed.

3. ~~Multi-task DONE: `assertCodeChangeMissionMayComplete` does not require every required task terminal; after first integration FSM goes to REVIEWING.~~ — **ACCEPTED** as `docs/ledger/B-selfhost-3.md` at `fd8a99c402656f7fe3aa6dc02377cc76713ab411`.
4. ~~Planning re-entry duplicates original tasks (`createPlanningDriver` always full decompose).~~ — **ACCEPTED** as `docs/ledger/B-selfhost-4.md` at `84f2f7ef55f4d97e7936b5e7d775bba358f60c90`.
5. ~~Review/evidence use `projectPath` (user checkout), not isolated checkout of `checkpointHash`.~~ — **ACCEPTED** as `docs/ledger/B-selfhost-5.md` at `916f7f26df1b7490d35289781a4e799d7cd8e7ed`.
6. ~~Runtime templates live in `project.discovered`; `validateRuntimeIfNeeded` drops evidence; `resolveRuntimeEvidence` uses a fake checkpoint hash and is not the production path.~~ — **ACCEPTED** as `docs/ledger/B-selfhost-6.md` at `df49a5ef75996da5ee17c51b4f66e974d8952fc0`.
7. ~~`createRun` mutates shared `config.runtimeValidation.mode` (concurrent-run leak).~~ — **ACCEPTED** as `docs/ledger/B-selfhost-7.md` at `1dc1c5cfbb2f92efb2fa8f58f15e92f02a3c80b2`.
8. ~~`--budget-tokens` / `--budget-usd` stored in facade metadata; `applyRunBudgetOverrides` unused; Option A hard caps required (not C2).~~ — **ACCEPTED** as `docs/ledger/B-selfhost-8.md` at `14beb802857fde8a5251404dc518301cb5b1a0a4`.
9. ~~Candidate provenance is `worker/candidate-N`.~~ — **ACCEPTED** as `docs/ledger/B-selfhost-9-19.md` at `9e157e1a0a5d7369f2be905d8c36121789e09087`. **Shape confirmed 2026-09-11**, and it is a propagation gap rather than a missing value: `createWorkerFactory` already selects a real model through the router and hands that `ModelRef` to `AgentRunner` (`src/daemon/composition.ts:442-452`), which records it on the persisted transcript (`src/agents/runner.ts:237`). The synthetic identity is minted separately and downstream: `toCandidate` hardcodes `model: { provider: "worker", model: \`candidate-${index}\` }` (`src/engine/candidateDrivers.ts:457`), and the same literal is written into the `worker.started` payload and actor (`:124-127`) and carried by every `candidate.created` / `candidate.state_changed` / `candidate.gated` actor through `appendCandidateEvents` (`:715-724`). So one candidate has two model identities in the same run — the truthful one inside the transcript artifact, the synthetic one in the event log and the `Candidate` record that the tournament, the report and the observer read. The user-visible surface is `displayModel` on `worker.started` (`src/observe/project.ts:234-241`), which renders "Candidate 0". Git branch naming is unrelated and needs no change: `polish/${runId}/candidates/${candidateId}` (`src/engine/candidates.ts:116-117`). The note at `docs/ledger/B2.md:58` — "Candidate `model` is recorded as `candidate-${index}` until the factory supplies a ModelRef" — is stale in its premise: the factory does supply one now, and only `toCandidate` fails to use it.
10. ~~Reviewer selection is `provider.listModels()[0]`~~ — lifted to bootstrap cost eligibility (Router + explicit `ReviewProvider`).
11. ~~Production tournament `new PairwiseJudge()` with no provider → heuristic-only on a
    non-dominated frontier.~~ — **ACCEPTED** with 32+34+44 as
    `docs/ledger/B-selfhost-32-34-44.md` at `78a3378`; production defaults to the broker-backed
    empirical verifier and the providerless empirical factory now fails loudly.
12. Crash recovery restores scheduler jobs only (not run settings, catalog rediscover, per-run budget, runtime mode). **Accumulated spend is among the losses, which makes a hard cap non-durable across a restart:** `ModelBroker.restore(runId)` (`src/broker/broker.ts:274-280`) folds a run's `model.call` events back into the budget tracker, but it has no production caller — every call site is a test. `DaemonService`'s recovery is `engine.recover()` alone, which restores scheduler jobs. So a restarted daemon believes every run has spent nothing, and a run may spend its whole budget again after each restart. B-selfhost-8 makes a run's budget *limits* survive a restart, resolved lazily from its `facade.json`, and deliberately stops there: restoring spend is this item's, and the two are independent — limits without spend still bind, spend without limits binds the wrong number. Recorded while drawing B-selfhost-8's scope boundary, at both reviewers' request.
13. B10 NEEDS_HUMAN / STOP-RESUME / crash through DaemonService/RPC coding composition (engine/RPC round-trips exist; daemon coding E2E is DONE-only).
14. Controlled **real-provider coding** E2E + RecordReplay (B11 recorded probes only).
15. Runtime=required happy path on a safe fixture with persisted corpus identity.
16. `corpusRuntimeEvidenceAllowsDone` has no early return for `off`, so a failed current-hash entry blocks DONE even when runtime validation is disabled. Found during B-selfhost-6 review; the helper faithfully extracts base logic, so it was left alone there. **Scheduled 2026-09-12** into item 15, which drives the `required` happy path through the same runtime-evidence helper.
17. `polish.toml`'s `runtimeValidation.mode` is dead for daemon-created runs: both the RPC handler and the CLI default an omitted `--runtime` to `"auto"`, so the configured value is never the effective one. Found during B-selfhost-7 contract review; B-selfhost-7 deliberately preserves this base behavior rather than changing it. **Scheduled 2026-09-12** into item 12, which reworks how a run's settings are resolved and restored — the same `runConfig` path where the configured mode is currently never the effective one.
18. ~~Worker tool-loop replays the whole transcript~~ — **ACCEPTED** as `docs/ledger/B-selfhost-18.md` at `8ea156db5207c5b159869b6e8ea2620c628b932f`, run record `docs/ledger/B-selfhost-18-run.md`; 15 review rounds on the Grok and GPT-5.6-sol lanes. Originally: worker tool-loop replays the whole transcript, so cumulative token cost is quadratic in turns and pre-empts the contracted `agent.maxTurns` bound. `AgentRunner.runLoop` sends `messages: [...messages]` on every call (`src/agents/runner.ts:71`) after appending the assistant message (`:89`) and every tool result (`:122`), charges the entire prompt against one cumulative counter (`totalTokens += inputTokens + outputTokens`, `:90`), and passes the remainder as that call's output cap (`remainingTokens`, `:66`). Turn capacity therefore grows as the square root of the token budget, not linearly, and the per-call generation allowance shrinks monotonically as the transcript grows. Two consequences at production defaults (`agent.maxTurns` 32, `src/domain/config.ts:92`; `maxTaskTokens` null → `32_000`, `src/daemon/composition.ts:455`): the token budget binds well before the contracted turn count, so the `agent.maxTurns` knob accepted in `docs/ledger/B-bootstrap-discovery.md` is not the effective bound; and exhaustion returns `BUDGET_EXCEEDED` → `status: "failed"` (`src/agents/runner.ts:277-282`), so candidates can drop out of `COMPARING` by transcript length rather than by evidence, biasing the tournament frontier. `read` output is the dominant growth term and is never evicted, so re-reading one file duplicates it in context for the remainder of the loop. **Measured 2026-09-10** over the 6 `agent_transcript` artifacts in `~/.polish/artifacts` (fixture runs, two `:free` models, default 32_000 cap), corroborated by the 83 recorded worker requests whose `messages` array grows monotonically from 1 to 35 entries and from 209 to ~15,100 serialized characters inside a single loop. Resent history is **61.6–72.7% of all input tokens (mean 66.9%)**. Loops ran 10–18 turns (mean 14.2) and **none reached `agent.maxTurns` = 32**; 3 of 6 ended `BUDGET_EXCEEDED` at 32.4k–34.4k total tokens. Holding the 32_000 cap fixed, a flat prompt projects to 2.3× the turns at zero state overhead, 1.5× at a 500-token state block, 1.1× at 1,000 and **0.9× — a regression — at 1,500**, with break-even near 1,250. **The state schema budget is therefore a first-class acceptance criterion, not an implementation detail:** a verbose or unbounded schema makes this change actively worse at current task sizes, and the contract must cap it (the paper's reusable CTF schema is 5 fields). The shrinking per-call output allowance is live but not yet shown to truncate — the lowest final-call allowance observed was 618 tokens, in a transcript that had produced a 578-token output earlier. Sample is thin (N=6, one fixture, two small free models); the projection is a turn-count model only and ignores the paper's noise-robustness and state-recovery effects, which this data cannot measure. Reference architecture: SKILL.state (arXiv 2608.26263), bounded `(P, Σ_t, O_t)` prompt with the reasoning trace discarded after a runtime-validated state patch. That paper's stated auditing limitation does not apply here: `persistResult` already archives the full transcript to CAS (`src/agents/runner.ts:246-251`), so Polish can drop history from the context window while keeping it in the event log. Found while evaluating arXiv 2608.26263 against the tree. **Scheduled 2026-09-10** into the pause block after finding 19 and before items 11–15; **contract FROZEN 2026-09-12** as `docs/ledger/B-selfhost-18.md`, revision 3, after three contract reviews across two model families; revisions 1 and 2 were both rejected. The line numbers cited in this item are stale as of that commit; the contract's citations are the current ones. **Baseline moved 2026-09-12 by items 9+19, and the projection must be re-derived against the new one, not the old.** A production worker's first request was `task.description` alone; it is now a composed pack, and the pack is resent every turn exactly as the transcript is. Measured on the merged base with the derived cap of 1,333 tokens at production defaults: a small task goes from 10 to 519 estimated tokens, a self-host-scale task with a 269-token description and six acceptance clauses goes from 269 to 879. The pack is therefore a permanent per-turn constant of roughly 520-880 tokens, against the ~1,250-token break-even this finding measured for such a constant. **That reading was wrong and is corrected 2026-09-12 by re-measurement on the merged base:** the pack is a per-turn constant in *both* architectures, so it shrinks the improvement ratio but costs the state budget only 140-420 tokens, not the whole margin. Re-derived against the cost model *pack + state + last turn verbatim + output*, the break-even state size is 1,088 tokens at a 519-token pack, 971 at 879, and **808 at the 1,333-token cap** -- the last being the number that governs the contract. Turn ratios are 1.10x-1.50x rather than the originally projected 2.3x. The larger gain is structural: reaching 32 turns costs 64,896 tokens under a bounded window against 144,688 today, **2.2x cheaper**, because capacity becomes linear in the budget instead of quadratic. Stated as the cost it actually is: the pack does not overrun the budget -- `runLoop` stops at `totalTokens < maxTokens` -- it **displaces turns**. Calibrated against this finding's own measurements (14.2 mean turns, quadratic history growth against a 32,000 cap), a 519-token pack costs roughly 11% of a run's worker turns and an 879-token one roughly 17%. Ordering rationale and the measurement prerequisite are in *Prompt-path ordering constraints*, `docs/ledger/PHASE-C.md`.
19. ~~Protocol composition and worker context packs are built and tested but have no production caller~~ — **ACCEPTED** as `docs/ledger/B-selfhost-9-19.md` at `9e157e1a0a5d7369f2be905d8c36121789e09087`; the two `domain` protocols remain without one, see below. Originally: protocol composition and worker context packs are built and tested but have no production caller, so the worker path runs without an instruction hierarchy. `createWorkerFactory` constructs `AgentRunner` with neither `systemPrompt` nor `prompt` (`src/daemon/composition.ts:449-457`), leaving `task.description` as a production worker's entire instruction (`src/agents/runner.ts:47`) — no base engineering policy, no untrusted-data fencing, no acceptance criteria block, all of which `src/context/worker.ts:23-38` already defines. `runAxisReview` hardcodes its reviewer system prompt inline (`src/review/swarm.ts:64-71`) rather than composing the role protocols that exist under `protocols/`; reviewers do fence their payload as untrusted (`:60`), workers do not fence at all. **Corrected 2026-09-11:** this finding originally named the reviewer, `judge`, `prosecutor` and `defender` role protocols as present in the tree. Two of those are wrong, and a contract quoting the finding verbatim would have carried an unsatisfiable clause — the failure mode B-selfhost-8's contract review caught twice. What exists is nine `kind: role` protocols: five reviewer axes (`reviewer-correctness`, `reviewer-regression`, `reviewer-adversarial`, `reviewer-architecture`, `reviewer-simplicity`), plus `evidence-agent`, `defender`, `planner`, `scope-guardian` and `judge`. There is no generic `reviewer` protocol, so composition must select a per-axis role rather than one reviewer role. **Re-corrected 2026-09-12:** the first correction also claimed there is no `prosecutor` protocol. There is one — `protocols/prosecutor/SKILL.md`, `kind: role` — added by accepted C4. The claim was made while reading `phase-c-collab`, which at that moment carried the ledger but *not* the accepted C-task code, because the two had never been merged; the merge that fixed that is `f0192f7`. A correction derived from a tree missing accepted work is the same error one level up, and it is the reason a contract must cite the base it will actually be implemented against. Full taxonomy on the merged tree: `base` (1, `base-engineering-policy`), `task` (5, `bugfix` / `feature` / `refactor` / `simplify` / `investigate`), `domain` (2, `typescript` / `react-native`), `role` (11: five `reviewer-*` axes plus `evidence-agent`, `defender`, `planner`, `scope-guardian`, `judge`, `prosecutor`). **None of the eleven roles applies to a worker**, which is why worker composition cannot use `compose()` as it stands: `compose` requires a role and validates `kind: role`. **Also unresolved by items 9+19 (2026-09-12):** the two `domain` protocols, `typescript` and `react-native`, still have no production caller. Worker composition selects base plus the task protocol and no domain, because `ProjectProfile` carries no stack signal to select one from — its `framework` field is a *test-runner* hint (`vitest | jest | node-test | unknown`, `src/project/profile.ts:8`), and an implementation that keyed a domain table on it was dead by construction. Selecting a domain needs a discovery signal the tree does not have; that is new scope, not part of finding 19. Each declares `applies_to` over `worker | reviewer | evidence | defender | supervisor` and its own `budget_tokens`; `compose()` already enforces exactly one base, one task, sorted domains and one role, and `fitToBudget` drops trailing members without ever dropping base. `ProtocolRegistry.load`, `compose()` and `buildWorkerContextPack` have no non-test callers. Distinct from item 18: this is the immutable-specification half of the same call, and is a prerequisite for any state-schema work, since a per-task-kind schema would be authored in protocol frontmatter alongside the existing `kind: task` taxonomy. **Scheduled 2026-09-10** into the pause block alongside item 9 and before findings 18 and items 11/14; contract not yet drafted. Ordering rationale in *Prompt-path ordering constraints*, `docs/ledger/PHASE-C.md`.
20. `ModelObservationRepository.recordAudition` (`src/broker/observations.ts:80`) has no caller in `src/**`, tests included. C8 (ACCEPTED at `3112038`) landed the audition observation kind, its projection and the catalog replay path (`restoreCatalog`, `:106-126`) without any producer, so `ModelRouter.expectedQuality` still falls back to a three-value tier prior (0.85 / 0.7 / 0.5) for every model lacking live call history (`src/broker/router.ts:144-146`) — the weakest input to routing. Proposed closure is an internal audition corpus scored by the existing deterministic gates and fed through `recordAudition`, not an external benchmark. Consuming LiveBench's published per-category data as a cold-start prior was evaluated and deferred: it measures generation rather than verification judgment, its model universe is paid frontier APIs against a `free_only` default cost eligibility, its per-question data is frozen at 2025-04, and its release files are undocumented URLs. Transferable part is the methodology only — objective ground truth, deterministic scoring, no LLM judge, retire tasks once saturated. Found while evaluating LiveBench against the tree. Concerns accepted C8 scope, not a Phase-B defect. **Scheduled 2026-09-10** as the final item of the pause block, after finding 18 (auditioning a worker loop that is about to be replaced discards the observations) and after item 14; contract not yet drafted. Ordering rationale in *Prompt-path ordering constraints*, `docs/ledger/PHASE-C.md`.
21. A corrupt or unreadable `facade.json` silently downgrades a `required` run to the loaded configuration's mode. `persistedRuntimeMode` catches every read and parse error and returns `null` (`src/daemon/service.ts:362-370`), after which `runConfig` falls back to the base config (`:355-357`) with no event, no log line and no run-visible signal. B-selfhost-7's MC8 permits exactly this outcome — it is the floor the contract set, and it is no worse than base, where a restarted daemon gave every recovered run the loaded mode until the next `createRun` overwrote it globally — so it was deliberately not repaired inside that contract. It remains a quiet safety regression for the affected run: the operator asked for runtime validation to be mandatory and gets whatever `polish.toml` says instead. Closure is a diagnostic, not a behavior change: the fallback is correct, its silence is not. Raised independently by both reviewers across two rounds of B-selfhost-7. **Scheduled 2026-09-12** into item 12: the silence is in the same resolution item 12 rewrites, and the diagnostic costs nothing once that code is open.
22. The static pin guarding B-selfhost-7's MC1 does not see two ways of writing the same assignment. `service.runtime-mode.test.ts` matches `/\.runtimeValidation(\.\w+)?\s*=(?!=)/` over non-test `src/**`, which catches dotted assignment including a value wrapped to the next line, but not `config["runtimeValidation"].mode = …` and not `Object.assign(config.runtimeValidation, …)`. This matters more than an ordinary test gap because `withRuntimeValidationMode` returns the base object itself when the requested mode already equals the loaded one (`src/domain/config.ts:266`), so runs whose mode matches `polish.toml` receive `PhaseContext.config === base`. For those runs isolation rests on the guarantee that nothing writes into the base object — that is, on this pin — rather than on structure. The asymmetry is invisible to a future writer, who sees a `PolishConfig` on `ctx` and has no way to tell whether it is shared. Closure is either a pin that also matches bracket access and `Object.assign`, or an unconditional copy in `withRuntimeValidationMode`, which trades one allocation per drive for structural isolation. Raised by Claude in rounds 3 and 4 of B-selfhost-7. **Scheduled 2026-09-12** into item 12, which touches `withRuntimeValidationMode` anyway; the unconditional-copy option is the structural fix and retires the pin rather than widening it.

23. **ACCEPTED in full.** Reviewer-protocol half: items 9+19 at `9e157e1`. Detector half:
    `docs/ledger/B-selfhost-35-23.md` at `0dc54b0`, run record
    `docs/ledger/B-selfhost-35-23-run.md`. Pathology sample v2 records integrated change
    classification and `test_only_verification_treadmill` stops a configurable window directly at
    `NEEDS_HUMAN`. Original finding: **A verification loop can make real progress by every measure
    Polish has, indefinitely, without changing production behaviour — and C2 cannot see it.**
    Observed on this project, not hypothesised: B-selfhost-8 changed non-test source in three commits
    (`2ef215b`, `ad80df6`, `df24e83`, `+109/−20` lines), all within its first three review rounds,
    and then ran twenty-one further test-only rounds. The accepted detector addresses this exact
    production-versus-test checkpoint distinction; the full historical analysis remains in the
    frozen contract and prior ledger history.

24. **Model capability probes reach the provider without passing through the budget guard.** The probes receive the provider adapter directly, so "the cap binds" is true for phase-driver model calls and false for probes: a run can spend beyond its own `--budget-tokens` / `--budget-usd` on probe traffic, and that spend is invisible to the tracker. Base behaviour, untouched by B-selfhost-8 and outside its contract, which is why it was recorded rather than fixed there. Raised by Claude in round 17 of B-selfhost-8. **Scheduled 2026-09-12** into item 20: the audition producer is what issues probes, so the call path is open there and nowhere else.
25. **One resolution of a run's budget, but two merge sites, so every divergence between the enforcing surface and the reporting surface is expressible and has to be tested rather than being impossible.** `DaemonService.runBudget` is a single lookup, but `applyRunBudgetOverrides` is then applied independently at `src/daemon/composition.ts:155` for the broker's tracker and at `src/daemon/service.ts:373` for `ctx.config` and thence C2. Both reviewers named this independently, and the measurement is stark: of B-selfhost-8's twenty-four test-only commits, the majority close mutants that live in exactly this seam — one side keeping a configured `null`, one side skipping the merge in the default runtime mode, one side truncating a fraction, one side answering every recovered run with the first budget it resolved. A shared resolver returning the already-merged `BudgetLimits` to both consumers would make the whole class **inexpressible** rather than merely tested, and would retire roughly a third of `src/daemon/service.budget-override.test.ts` with it. This is a production change and belongs to whichever item next touches this seam — items 9 and 19 both edit `createWorkerFactory` in the same file. Note the order: collapsing the merge without first having the tests is how the class comes back; retiring the tests without collapsing the merge removes the evidence and keeps the hazard. **Scheduled 2026-09-12** into item 12, which owns this seam.

26. **A worker's fence is weaker in production than any fixture shows, because the injection arrives twice.** Items 9+19 fence findings as untrusted data and add the never-follow clause, and the acceptance check demonstrates that an instruction-shaped claim appears only inside the fence. In production it also appears *outside* it: the one task origin that selects a finding builds the task from that finding's text — `description: \`WHAT: ${terminalFinding.claim}\`` and `title: \`Fix: ${claim}\`` (`src/engine/reviewDrivers.ts:532-533`, and the same shape in `src/findings/validator.ts:156`) — and the `task` section is protected, unfenced, and sits above the fence in the instruction hierarchy. So a reviewer-authored claim reaches a worker as *instruction* as well as as fenced data. Not a regression: `task.description` was a production worker's entire unfenced instruction at base, and 9+19 only added a hierarchy around it. Closure is either sanitising the claim on the way into the task, or building the task from the finding's criterion and evidence rather than its prose. Raised by Claude in round 2 of items 9+19. **Recorded 2026-09-12**, not scheduled.
27. **A malformed protocol directory now prevents the daemon from constructing at all.** `buildProductionDeps` loads the registry eagerly (`src/daemon/composition.ts`), reached from the service constructor, and `ProtocolRegistry.load` throws `NOT_FOUND` for a missing directory and `INVARIANT_VIOLATION` for a duplicate or a name that does not match its folder (`src/protocols/loader.ts:17-38`); `assertReviewerRolesResolvable` throws likewise on a frontmatter `kind` typo. Before items 9+19 the registry was never loaded in production, so a malformed `protocols/**` was inert. Loading once and injecting is contractually required and fail-fast is the right polarity, so this is not a defect — but the failure surfaces as an unhandled constructor throw rather than a startup diagnostic naming the offending file. Closure is a diagnostic, not a behaviour change. Raised by Claude in round 2 of items 9+19. **Recorded 2026-09-12**, not scheduled.

## Out of scope (Phase C — do not implement)

C1 simplification pass, C2 pathology/adaptive budget, C3 Python llm-verifier sidecar, C4 Prosecutor/Defender, C5 CodeGraph native, C6 interactive NEEDS_HUMAN answer, C7 scouts, C8 Model Audition, C9 GC/doctor beyond a B fix, C10 sandbox-exec, C11 browser/RN runtime.

28. **An older failing command can lose its exit code to the demotion regex.** `collectEntries` demotes every failing command but the newest by stripping its output tail with `text.replace(/: [\s\S]*$/, "")` (`src/agents/loopWindow.ts`), which matches from the **first** `: ` in the rendered entry rather than from the separator the renderer wrote. An argv containing `: ` — `git commit -m "fix: something"`, `node -e "console.log('a: b')"` — therefore loses its `-> exit N` along with the tail, so the digest records that the command ran and not that it failed. The newest failure is never demoted, so the most recent one is always intact. **Found 2026-09-12** by the Grok lane in the confirming round of item 18 and agreed non-blocking by both lanes, because the frozen contract does not name colon-bearing argv and acting on it would have been a new axis. The fix is to carry the tail as its own field rather than re-parsing the rendered text, which is a one-line change to `DigestEntry`. Not scheduled: it rides with the next item that touches `loopWindow.ts`, and if none does before Phase B closes it is worth its own trivial task.

29. ~~**The worker loop is 17.2% of a run's tokens; the review swarm is 78.7%, and it is output-bound.**~~
    **ACCEPTED** as `docs/ledger/B-selfhost-29.md` at
    `3d718313e8c341432e2c20d636d55bad2c3282eb`; run record
    `docs/ledger/B-selfhost-29-run.md`.
    Measured 2026-09-12 over the **six real end-to-end runs** in `~/.polish/polish.db` (6,964 events,
    1,060,632 tokens), by summing `usage` per `payload.role` from the event log. Reviewers
    834,635 (78.7%), worker loops 182,900 (17.2%), council 43,097 (4.1%). The reviewers' ratio is
    **5.0x output to input** (138,414 in, 696,221 out) and `review_adversarial` alone is 64.4% of
    all spend, so their cost is generation, not context: no prompt-window or packing work touches it.
    **This reorders the economics of the remaining plan.** Item 18, now accepted, removes resent
    worker history — 113,248 tokens, 10.7% of a run, which is its absolute ceiling — and replaces it
    with a digest plus one verbatim turn, 51,255 tokens, so its net is **5.8% of a run if turn counts
    hold**, and zero if the bounded window costs the worker one extra turn in fourteen. Items 11-15
    are ordered by finding number, and none of them addresses the 78.7%.
    **Two further cautions from the same corpus.** Only **2 of 6 runs reached `DONE`** (three
    `NEEDS_HUMAN`, one stuck in `INTERPRETING_MISSION`), so cost-per-completed-task has n=2. Those
    two disagree by a factor of seven — 123,031 and 914,392 tokens, worker share 48.5% and 13.5% —
    on one fixture with two small free models. There is no corpus on production-grade models at all,
    and acquiring one is out of bounds while paid provider APIs are forbidden.
    **Not a defect.** It is a measurement that decides what gets scheduled next, and it did:
    **scheduled and accepted 2026-09-12** as `docs/ledger/B-selfhost-29.md`, ahead of items 11-15, on the
    decision to make the economics measurable before optimising further rather than repeat at
    larger scale the mistake of optimising against a model instead of a measurement. The A/B of the
    existing fixture corpus on the same two free models, before and after item 18, follows that item
    and tests item 18's one untested assumption: that a worker needs the same number of turns with
    less context in front of it. The optimisation targets this finding implies -- the reviewer axes'
    output volume and the number of axes run per candidate -- are deliberately left unscheduled
    until the report exists to judge them by.

30. **Two existing folds carry the defects item 29 forbids in new code.** `usdUsage`
    (`src/observe/project.ts:468`) sums the `costUsd` values it finds and skips the ones it does not,
    so on the recorded corpus it returns `0` for a run where **96 of 324 calls have no price** — a
    figure indistinguishable from "this run was free". And `foldModelCallUsage`
    (`src/convergence/pathology/budget.ts:47`) drops `taskId: null` from its per-task map, which on
    this corpus silently omits all 43,097 council tokens, 100% of council spend. Both are otherwise
    sound: `foldModelCallUsage` orders by `seq` and deduplicates retried calls by `callId`, which is
    the behaviour item 29's contract adopts. **Found 2026-09-12** during item 29's contract review.
    Not scheduled: both have their own callers and their own tests, and item 29 deliberately builds a
    separate store-free fold because `src/cli/` may import neither. Worth a small task once item 29's
    report exists to compare them against.

## Sync against the two reference sources, 2026-09-12

Both were re-read in full: **SKILL.state**, arXiv 2608.26263 v3 (Badhe, Tiwari, Chung; Google /
Purdue), and **LLM-as-a-Verifier**, github.com/llm-as-a-verifier/llm-as-a-verifier with its paper
arXiv 2607.05391. The four findings below are the divergences. They are recorded rather than acted
on silently, and one of them is about an item that is already accepted.

31. **Item 18's design is the class of runtime the SKILL.state paper measured and found to
    collapse.** The paper's Experiment 5 exists for exactly this question -- "whether SKILL.state's
    performance gains stem merely from shorter prompts or from structured state representation" --
    and answers it with budget-matched controls at T=100, all pinned to SKILL.state's ~1,800-token
    footprint (Table 5): **SKILL.state 0.94, Summary-capped 0.52, Truncated sliding-window 0.18,
    ReAct+LLMLingua 0.22, and unbounded full ReAct 0.84.** Item 18's digest is a mechanically
    derived inventory plus a rolling assistant-text window plus one verbatim turn under a hard cap
    -- a hybrid of the truncation and summary-capped controls, and **not** SKILL.state, which
    requires the *model* to emit a validated `state_patch` merged by a deterministic `⊕` with
    null-deletion semantics. On the paper's own evidence that class is not merely worse than
    SKILL.state, it is **worse than the unbounded history it replaces**.
    The contract rejected the paper's design on the grounds that "a model that fails to call a patch
    tool loses all memory, and that failure mode is not testable without live models". The paper
    answers both halves directly: schema ownership and validation live in the deterministic runtime,
    so a malformed patch cannot corrupt state and triggers a **rollback-retry**, and its open-weight
    error taxonomy (68% premature state overwrite, 20% schema/type coercion, 12% JSON syntax)
    argues for **grammar-constrained decoding**, not for abandoning patches.
    **The interaction is the dangerous part.** Table 11 shows the budget-matched controls are
    comparable to each other at T=10 (0.88-1.00) and collapse from T>=25. Polish's measured loops
    are 10-18 turns, mean 14.2 -- just below the collapse. Item 18's stated benefit is *more turns
    per budget*, so its own success moves the loop into the region where its design fails. Any A/B
    must therefore measure accuracy at a long horizon, not only tokens at the current one.
    **Not a defect of item 18's acceptance**: it satisfies its frozen contract, which two reviewers
    checked over fifteen rounds. It is a defect of the contract's design choice, made by me, and it
    is what the A/B was scheduled to catch.

32. **ACCEPTED with deliberate free-tier departure** as
    `docs/ledger/B-selfhost-32-34-44.md` at `78a3378`, run record
    `docs/ledger/B-selfhost-32-34-44-run.md`. Free providers returned no token distributions, so the
    accepted implementation uses honestly named repeated empirical 0–4 rewards rather than claiming
    logprob expectation. Original finding: **Our review swarm is LLM-as-a-Judge where the reference
    is a verifier, and that is the whole
    of the 78.7%.** `REVIEWER_OUTPUT_CONTRACT` (`src/review/reviewerProtocol.ts:14`) asks each axis
    for "JSON only as an array of findings", each with claim, evidence, reproduction -- generated
    prose. Measured consequence (finding 29): reviewers spend 138,414 input against **696,221
    output tokens, a 5.0x ratio**, and `review_adversarial` alone is 64.4% of every token the tool
    spends.
    LLM-as-a-Verifier's stated key idea is the opposite: "Rather than reducing each distribution
    into a single discrete score (as in LLM-as-a-Judge)", it takes the **expectation over the full
    logprob distribution of score tokens**, `R(x,τ) = (1/CK) Σ_c Σ_k Σ_g p(v_g | x,c,τ)·φ(v_g)`,
    with C criteria, K repeats and G score tokens. The output is a handful of score tokens, so cost
    moves to the input, which is then cacheable -- their 0.2.0 reports **~3.4x fewer uncached input
    tokens** via prefix caching on trajectory-heavy benchmarks.
    And it delivers the thing this tool exists for. Best-of-5 **self**-verification on
    Terminal-Bench 2.1: Pass@1 78.7% -> **88.0%** with the same model as verifier (oracle 96.6%).
    SWE-Bench Verified 76.1% -> **78.2%**; Terminal-Bench V2 83.1% -> **86.5%**; MedAgentBench
    70.2% -> **73.3%**. That is "better than one flagship model at lower cost", demonstrated, and
    Polish is on the wrong side of the architecture that produces it.

33. ~~**The tournament is the wrong algorithm, and it is also unwired.**~~ **CORRECTED 2026-09-12,
    the same day it was written: the algorithm is not wrong, and saying so was my error from reading
    `PairwiseJudge` without reading `tournament.ts`.** `TournamentSelectionMethod` already includes
    `"ppt"`; `selectTournamentWinner` already takes `pivotFrom`, `pivots`, `repeats` and
    `granularity` -- the reference's exact dials; `createVerifierStrategy`
    (`src/verify/sidecar.ts:471`) already takes `{backend, repeats, granularity, criteria,
    pivotTournamentFrom}`; and `VerifierAdapter.selectFrontier` (`:143`) is the delegation seam that
    records `logprobScheme`, `nComparisons`, `criteria`, `client` and `fallback`. The intended
    production path is `backend: "sidecar"` -- an **external** verifier process -- and the natural
    implementation of that sidecar is the `llm-verifier` package itself. The design already is the
    reference architecture; what is missing is an implementation behind the seam. The original text
    of this finding, which stands only as to the wiring, follows.
    Original: **the tournament is unwired.** Item 11 already records that
    production constructs `new PairwiseJudge()` with no provider, so `comparePair` returns
    `heuristicVerdict` (`src/verify/pairwise.ts:25`) and nothing in `src/daemon/composition.ts`
    wires a verifier strategy at all. The reference algorithm is a **Probabilistic Pivot
    Tournament**: a ring pass over a random Hamiltonian cycle that puts every candidate once in each
    slot to cancel positional bias, top-k by ring score as pivots, then non-pivot-vs-pivot and
    pivot-vs-pivot comparisons aggregated as `p(a ≻ b) = σ(R_a - R_b)` with win mass over count --
    **O(Nk) instead of O(N²)**, with `pivots` as the explicit cost-accuracy dial. Item 11 as
    scheduled ("wire a provider") is therefore too small: wiring a provider into an O(N²)
    prose-judging tournament buys the expensive half of the reference and none of the cheap half.

34. **ACCEPTED** with 32 as `docs/ledger/B-selfhost-32-34-44.md` at `78a3378`.
    `logprobScheme` remains null unless TypeScript observes distributions; sidecar assertions are
    recorded separately as `claimedLogprobScheme`. Original finding:
    **`logprobScheme` is provenance we record and never compute.** `VerifierAdapter`
    (`src/verify/sidecar.ts:67`) accepts `scores` and a `logprobScheme` of `"direct" | "two_stage"`
    from an external sidecar and threads it into `VerifierProvenance`
    (`src/engine/candidateDrivers.ts:252`). Nothing in the tree ever reads a logprob: the field
    records what a sidecar *claims* about how it scored. This is item 19's defect class -- built,
    typed, tested, no production computation behind it -- one level up, at the architecture.

35. **ACCEPTED** with finding 23 as `docs/ledger/B-selfhost-35-23.md` at `0dc54b0`, run record
    `docs/ledger/B-selfhost-35-23-run.md`. The production worker now has bounded prefix progress,
    two-family literal-zero abandonment and task-attributed economics. Original finding:
    **There is no progress signal, so nothing can be abandoned early.** The reference ships
    `ProgressTracker`: feed each step as it happens, get a live fine-grained score, "abandon a
    hopeless rollout early or decide when to resample", with the explicit property that the verifier
    only sees steps so far and cannot peek ahead. Polish has the negative of this in finding 23 --
    a verification treadmill that `detectNoProgress` cannot see -- and paid for it directly: item 8
    ran 26 review rounds and item 18 ran 15. A progress score is the principled form of that
    detector, and abandoning a hopeless candidate is the largest single token saving available,
    because it cuts whole rounds rather than trimming prompts.

## The review swarm has never produced a finding, 2026-09-12

Measured while extending item 29's contract, by querying `review_executions` and the event log
directly. This is the most consequential measurement of the programme so far and it reframes the
remaining plan, so the numbers come first.

**2,600 review executions. 18 completed. Zero findings.** Not "few findings" -- the `findings`
table has **0 rows**, and every one of the 18 completed executions returned an empty array, evenly
across all three axes (correctness 6, regression 6, adversarial 6). The 126 successful reviewer
model calls generated **696,221 output tokens, 5,526 per call**, against **0 findings**.

Why the other 2,582 did not complete:

| Cause | Executions |
| --- | --- |
| `rate limited` 429 from the free OpenRouter tier | 2,465 |
| **Schema failure** -- `{"expected":"array"}` / "review response must contain a findings" | **105** |
| `bad request (400)` | 6 |

36. **The reviewer output contract is beyond the models it is given to.** 108 executions had
    validation-like failures: 105 in the two narrow array/findings-array signatures, plus one JSON
    parse error and `invalid_type` / `invalid_value` cases. The 18 that validated returned
    `[]` after 5,526 output tokens apiece. `REVIEWER_OUTPUT_CONTRACT`
    (`src/review/reviewerProtocol.ts:14`) demands "JSON only as an array of findings", each with
    criterion, severity, blocking, claim, evidence, reproduction and optional suggestedCheck -- from
    `google/gemma-4-26b-a4b-it:free` and its peers. This is precisely the failure mode SKILL.state
    documents for open-weight models: its error taxonomy attributes 68% to premature state
    overwrite, 20% to schema comprehension and 12% to JSON syntax, and concludes that "small-model
    degradation stems from structured output adherence rather than reasoning capacity". Two remedies
    exist in the references and neither is in the tree: **grammar-constrained decoding**, or
    **dropping structured generation entirely** in favour of LLM-as-a-Verifier's logprob-expectation
    scoring, where there is no JSON to get wrong because the output is a handful of score tokens.
    Finding 32 argued this from cost; this argues it from the reviews not working at all.

37. **There is no circuit breaker on review retries.** One run executed **2,391 correctness reviews
    in a single round**: 2,389 rate-limited, one schema failure and one completion, alongside 269
    `model.retry_scheduled` events.
    The loop kept re-executing an axis that the provider was refusing. Nothing bounded it by
    consecutive failures, by wall clock, or by fraction of a round's executions failing. Finding 23
    named the verification treadmill from the *agent's* side; this is the same pathology in the
    *provider* dimension, and it is cheaper to fix because the rule is local: stop an axis after N
    consecutive provider failures and record the round as unverified rather than retrying it 2,389
    times.

38. **Zero findings is not yet proof the reviewers are useless, and saying otherwise would repeat
    this programme's worst habit.** Three readings fit the data and it does not separate them: the
    reviewed code was clean; the reviewers cannot express what they find through this contract
    (finding 36 makes this the most likely); or findings were produced and not persisted. What
    *is* established is narrower and sufficient: **78.7% of every token this tool has ever spent
    went to a review swarm whose recorded output is nothing at all.** The corpus is also from
    2026-09-04/05, several accepted items ago -- C4 added the prosecutor protocol and items 3-19
    have landed since -- so the zero must be re-measured on the current tree before it is treated as
    a property of the code rather than of that snapshot. **That re-measurement is the first thing
    the item 29 report should be pointed at**, and it is the reason the report must carry review
    yield, not only tokens.

**Consequence for the order.** Item 29 stays first and grows to carry the yield figures, because
every number above was obtained by hand-querying SQLite and would have been invisible otherwise.
Findings 36 and 37 come next, ahead of items 11-15: a review swarm that spends 79% of the budget
and returns nothing is a larger defect than anything remaining on the finding list, and finding 37
is a small, local fix. Findings 32 and 33 -- verifier scoring and the pivot tournament -- are the
architectural answer and follow them.

39. **`PairwiseJudge` swallows every provider and parse failure, silently and unrecorded, so wiring
    a provider into it would buy a silent heuristic.** `comparePair` ends in
    `catch { return heuristicVerdict(a, b); }` (`src/verify/pairwise.ts:44-46`), which catches the
    provider error, the `responseFormat: "json"` parse, and every `TypeError` that `parseVerdict`
    throws for a missing rationale, an out-of-pair winner, or non-finite scores. The call is paid
    for and the verdict is thrown away. Nothing records it: `TournamentSelection.fallback` is only
    populated on the `VerifierAdapter` path, and the in-tree path hard-codes `fallback: false`
    (`src/verify/tournament.ts:178`).
    Its output contract is `{"winner","rationale","scores"}` as generated JSON -- the same
    structured-output demand that failed 105 review executions in finding 36. So attaching a free
    model to `PairwiseJudge` today most likely produces: tokens spent, JSON rejected, heuristic
    returned, `fallback: false` recorded. That is strictly worse than the present honest heuristic,
    because it looks wired. **Make the discarded verdict observable before wiring anything**; it is a
    small local change and without it the wiring cannot be measured, which is item 29's whole
    lesson.

40. **The broker cannot ask for or read logprobs, but six free models offer them, so the
    reference's scoring is reachable at zero marginal cost.** `CompletionRequest`
    (`src/broker/types.ts:50`) has no logprobs field and `openaiCompat` neither sends
    `logprobs`/`top_logprobs` nor parses `choices[].logprobs`, so Polish cannot compute
    LLM-as-a-Verifier's `R(x,τ) = (1/CK) Σ p(v_g|x,c,τ)·φ(v_g)` itself -- which is why finding 34
    found `logprobScheme` to be provenance only.
    **Measured 2026-09-12** against OpenRouter's public `/api/v1/models` (no key required): of 445
    models, 155 advertise `logprobs` and `top_logprobs`, and **6 of the 19 free models do** --
    `nex-agi/nex-n2.5-mini:free`, `nex-agi/nex-n2.5-pro:free`, `inclusionai/ling-3.0-flash-vl:free`,
    `inclusionai/ling-3.0-flash-sante:free`, `inclusionai/ling-3.0-flash-fin:free`,
    `liquid/lfm-2.5-2.6b:free`. The routing gate already defaults to `costEligibility: "free_only"`
    (`src/domain/config.ts:121`), so these are inside policy.
    The blocker is therefore one bounded broker-layer change -- two request fields, one response
    field -- and not an architectural one. It should be verified with a live probe against one of
    those six before anything is built on it, because advertising a parameter is not the same as
    returning useful score-token distributions.
    **PROBED 2026-09-12 and the caution was right: advertised is not returned.** All of
    `nex-n2.5-pro`, `nex-n2.5-mini`, `ling-3.0-flash-vl`, `lfm-2.5-2.6b` and
    `nemotron-3-super-120b` answered `http=200` with **`logprobs: null`**, under both
    `{logprobs, top_logprobs: 5}` and `{logprobs}` alone, at `max_tokens` 4 and 64. So
    LLM-as-a-Verifier's logprob-expectation scoring is **not reachable on the free tier**, and the
    broker change this finding sized would buy nothing today. The tree already anticipates this:
    `logprobScheme` admits `"two_stage"` beside `"direct"`, and a two-stage discrete score needs no
    logprobs. That is the reachable form of fine-grained reward here.

41. **The review swarm has never produced a finding because the request demands a JSON object while
    the parser demands an array. The reviewers work; the plumbing discards their answers.**
    `runAxisReview` sends `responseFormat: "json"` (`src/review/swarm.ts:73`), which `openaiCompat`
    turns into `response_format: {type: "json_object"}` (`src/providers/openaiCompat.ts:66`). A JSON
    **object** cannot be a top-level array. But `REVIEWER_OUTPUT_CONTRACT` says "Return JSON only as
    an array of findings" (`src/review/reviewerProtocol.ts:15`) and `parseRawFindings`
    (`src/review/swarm.ts:154-163`) accepts only a top-level array or `{findings: [...]}`, throwing
    "review response must contain a findings array" otherwise. **A model that honours
    structured-output mode cannot satisfy the contract it was given.**
    **Measured 2026-09-12** with a live probe reproducing `runAxisReview`'s exact request -- the real
    `reviewerSystemPrompt(registry, "correctness")`, the real context-pack user message,
    `response_format: json_object`, `temperature: 0` -- against a diff carrying one planted defect,
    a budget guard changed from `spent < cap` to `spent <= cap`. Of five free models two got past the
    rate limiter, and **both found the defect correctly**:
      - `nex-agi/nex-n2.5-pro:free`, 691 output tokens: `{"criterion": "The budget guard must not
        admit a spend equal to the cap when the cap is exclusive elsewhere.", "severity": "High",
        "blocking": true, ...}`
      - `nvidia/nemotron-3-super-120b-a12b:free`, 662 output tokens: `{"criterion": "withinBudget
        must not admit a spend equal to the cap when the cap is exclusive elsewhere", "severity":
        "high", "blocking": true, ...}`
    Both returned the finding as a **single object** -- the natural shape under `json_object` mode --
    and `parseRawFindings` threw both away. The two `gemma-4*:free` models returned `429`
    immediately; `thinkingmachines/inkling:free` returned `403`, harness-only.
    This explains why semantically valid lone-object responses were discarded. Of the 108
    validation-like failures, 105 have the two array/findings-array signatures this contradiction
    produces; the other three are distinct JSON/Zod shape failures. The 18 "completed" executions
    parsed to an empty array.
    **Zero findings was never evidence about the code under review, or about the models. It was
    this.**
    The fix is two lines and no new dependency: accept a bare finding object as a one-element array
    in `parseRawFindings`, and reword `REVIEWER_OUTPUT_CONTRACT` to ask for `{"findings": [...]}`,
    which is what `json_object` mode can return. **This supersedes finding 36's diagnosis** -- the
    models are not failing at structured output; our two halves ask for incompatible structures --
    and it takes precedence over every other open item, including 29. It is the difference between a
    review swarm that costs 78.7% of the budget and returns nothing, and one that returns what it
    already knows.

## Findings 41, 39 and 37 fixed, 2026-09-12

Branch `task/B-review-plumbing`, eight commits on `3022deb`. Gate green: 732 tests, 75 files.
Each fix was verified by planting the defect back and watching a named assertion fail, and each was
then reviewed by Grok and GPT-5.6-sol independently. **Both reviews found real blocking defects in
my fixes**, listed below, and all are repaired.

**41 — the request asked for an object, the parser demanded an array.** `REVIEWER_OUTPUT_CONTRACT`
now asks for `{"findings": [...]}`, which is what `response_format: {type: "json_object"}` can
return. `findingValues` accepts that form, a bare array, or a lone finding object. `normalizeFinding`
wraps the singular containers live models actually returned -- `evidence` as one object,
`reproduction` as one string -- and lower-cases `severity`, because a probe returned `"High"` and
the enum is lower-case. Field validation is untouched: `RawFindingSchema` still rejects a malformed
evidence ref, and both reviewers traced it to confirm nothing was loosened.

**39 — a discarded verdict now says why.** `PairwiseJudge` exposes `usedFallback` and
`fallbackReason`, appends the reason to the heuristic rationale, and the tournament reads the real
state instead of hard-coding `fallback: false`. Two review findings: the flag was
**last-comparison state**, so a later success erased an earlier fallback -- it is now sticky per
judge, which is what a tournament-level `fallback` has to mean; and `provider.listModels()` sat
**outside** the `try`, so a rejection there escaped the fallback path entirely.

**37 — a bound on review attempts per axis.** `review.maxAxisAttemptsPerRound`, default 6,
counted from persisted executions so it holds across scheduler ticks. Three review findings, all
serious:
  - The stop returned **`NEEDS_HUMAN`, which `RUN_PHASE_TABLE` forbids out of `REVIEWING`**. The
    engine would have thrown `INVALID_TRANSITION` on every tick: an unbounded retry loop traded for
    an unbounded crash loop. Now `EXHAUSTED_NEXT_PHASE = "FAILED"` with a `providers_unavailable`
    terminal reason, asserted through `canTransitionPhase` rather than against a copy of the table.
  - The **empty-reviewer wait ran before the exhaustion check**, so once sticky failures excluded
    every model the driver waited forever -- the same unbounded loop in a quieter form. Exhaustion
    is now checked first.
  - **Every failure counted**, so one transient outage across six models could terminate a sound
    run. Only failures `isStickyReviewSkip` classes as non-retryable now count; a 503 or a timeout
    buys another tick.

**Where the implementation departs from finding 37's wording, and why.** The finding said "record
the round as unverified rather than retrying it 2,389 times". The implementation fails the run
terminally instead. Advancing to `VALIDATING` with a round nobody reviewed would admit an unreviewed
checkpoint into convergence, which is a worse failure than stopping; and `REVIEWING` has no third
exit. Recorded as a deliberate departure rather than silently satisfied.

**42. ~~Review quality is still unmeasured, and my own probe was contaminated.~~ ACCEPTED** as
`docs/ledger/B-selfhost-42.md` at `b055c81a6f1c42c0b14bede314803ae2f4d32309`; live report
`docs/ledger/B-selfhost-42-run.md`. The first probe that
"proved" free models find real defects listed, among its acceptance criteria, *"the budget guard
must not admit a spend equal to the cap when the cap is exclusive elsewhere"* — which is the
finding. I had written the answer into the question. Re-probed with a single honest criterion
("withinBudget must reject a spend that would exceed the cap"), `nex-agi/nex-n2.5-pro:free` returned
`{"findings": []}` in 81 output tokens, and it is arguably right: `spent <= cap` does not admit a
spend that *exceeds* the cap. So what is established is that the plumbing no longer discards
reviews. **Whether the reviews are any good is open**, and the honest next measurement is a
defect-injection corpus whose acceptance text does not name the defect.

## Prompt audit, 2026-09-12

Audited every prompt surface: the nineteen `protocols/*/SKILL.md`, `REVIEWER_OUTPUT_CONTRACT`,
`src/verify/pairwise.ts`'s judge prompt, `src/council/roles.ts` and `src/findings/debate.ts`.

**No flattery, no padding instruction, and no hedging language anywhere.** A case-insensitive
sweep for `helpful|please|thank|hope|feel free|great|excellent|friendly|apolog|I think|maybe|
perhaps|comprehensive|elaborate` returns exactly one hit, and it is an *anti*-pattern being
forbidden: `"Out of scope but helpful" | Reject` in
`protocols/base-engineering-policy/references/anti-rationalization.md`. The policy already reads
"Terse prose, never terse code", "Do not claim success without fresh command output", "Prefer
evidence over confidence", and each `reviewer-*` body opens with "Assume the author is
overconfident. Cite file:line or command evidence."

43. **ACCEPTED** with 32+44 at `78a3378`. Strict reviewer and empirical-score requests now use
    `reasoning:{effort:"none",exclude:true}`; the seed-43 original-model A/B cut reviewer output
    from 87,090 to 20,653 tokens while increasing completed cells from 61 to 73. This is transport
    efficiency, not a quality claim. Original finding:
    **The reviewers' token cost is reasoning, not prose, and an economy clause makes it worse.**
    Measured against two free models at `temperature: 0` on one diff. The returned JSON is already
    mechanically precise and compact -- a full finding renders to roughly 450 characters, about 115
    tokens -- while `completion_tokens` is 435-1,107. The gap is the model's own reasoning, which no
    instruction in the system prompt removes.
    A/B on the same input with a clause appended demanding one-sentence claims, imperative
    reproduction steps, no hedging, no adjectives and no prose outside the JSON: output went **up**,
    315 -> 349 tokens on `nex-n2.5-pro` and 719 -> 895 on `nemotron-3-super-120b`. Telling a
    reasoning model to be terse gives it more to reason about. Recorded so nobody re-adds the clause
    on the assumption it helps. The lever that would work is not a prompt: it is a non-reasoning
    verifier, a reasoning-effort parameter, or LLM-as-a-Verifier's scoring, where the output is a
    handful of score tokens and there is no prose to economise.

44. **ACCEPTED** with 32 at `78a3378`. The production path now uses an exact strict JSON Schema and
    fail-closed active capability probes; replay normalisation remains compatibility only. Live
    seed-43 schema failures were 11/96 on legacy, 2/96 on strict original, and 0/96 on the strict
    operational replicate. Original finding:
    **Shape variance is the dominant reviewer failure mode, and patching observed variants does not
    converge.** Four `evidence` shapes seen across four probes of the same two models on nearly the
    same input: an array of refs (valid); a single ref object (fixed by `normalizeFinding`); a ref
    using `startLine` instead of `line` (survives, Zod strips the extra key); and one whose `path`
    was not a string at all, which `RawFindingSchema` rejected at `evidence.0.path`. Also two
    `reproduction` shapes and two `severity` casings. Temperature is 0; the variance is between runs
    and between models, not from sampling.
    I was two patches into chasing this before noticing that each branch only covers the variant I
    happened to observe. **Stop patching.** The structural answers are the ones both reference
    sources already give: grammar-constrained decoding, which SKILL.state recommends precisely
    because open-weight failures are "structured output adherence rather than reasoning capacity";
    or scoring instead of generation, which removes the schema from the response entirely.
    Meanwhile the cheap and honest move is to make rejections **countable**: `review_executions`
    already persists `error`, so item 29's report must group failures by cause and show shape
    rejections as their own class rather than burying them in a total.

45. **MEASURED by accepted item 42.** The reviewers do find real defects, but the free two-model
    team is not yet suitable for gating: 82.6% primary recall, 60.0% clean-site false positives and
    36.8% pair discrimination on the blinded eight-pair corpus. Originally: given an
    honest acceptance criterion -- "remaining must never report a negative amount", which states a
    property without naming the defect -- both free models independently found that
    `remaining(spent, cap) { return cap - spent }` returns a negative value when `spent > cap`, both
    cited `limits.ts` with a line range, both supplied a runnable reproduction, and both proposed a
    check. That is a genuine, mechanically checkable finding from a free model. What remains
    unmeasured is the rate: one injected defect found twice is not a hit rate, and the corpus needed
    for one is still the next measurement finding 42 names.
    **Re-measured after accepted 32+34+44, seed 43:** strict output fixes shape but not judgement.
    The strict original arm completed 73/96 with 2 schema failures, 72.7% false positives and 9.5%
    discrimination; the operational-strict replicate completed 60/96 with zero schema failures,
    85.7% false positives and 5.9% discrimination. Different completion denominators prohibit a
    quality A/B claim. Raw review remains unsuitable for production gating; full provenance is in
    `docs/ledger/B-selfhost-32-34-44-run.md`.


---

# ARCHIVAL APPENDIX — disposition of all 45 findings, 2026-09-13

**This file is no longer a schedule.** The finding-number namespace 3–45 is retired. Numbers 3–28
were assigned in the order defects were *discovered* in the Phase-B re-anchor chat; numbers 29–45
were minted from measurements on 2026-09-12/13. The execution order built on those numbers was
rewritten five times, each time "on measurement", which is why the order stopped being legible.

The schedule is now `docs/PLAN.md` (plan v2, revision 8), accepted by Grok and GPT-5.6-sol after
seven review rounds. Every finding below has exactly one disposition. None is dropped silently.

| Finding | Disposition |
|---|---|
| 3, 4, 5, 6, 7, 8, 9 | ACCEPTED; historical |
| 10 | ACCEPTED as `B-bootstrap-cost-eligibility` (lifted out of this list) |
| 11 | ACCEPTED with 32+34+44 at `78a3378` |
| 12 | **`docs/PLAN.md` P1.3** (spend restore) + **P1.7** (settings restore). Split because the halves are independent: limits without spend still bind, spend without limits binds the wrong number |
| 13 | **P1.12** — daemon coding E2E for `NEEDS_HUMAN`, STOP/RESUME, crash recovery |
| 14 | **DROPPED.** Requires real paid provider APIs, which policy forbids. Transport-layer cassettes if the need returns |
| 15 | **P1.13** — `runtime=required` happy path; depends on P1.6 and P1.8 |
| 16 | **P1.6** — one-line missing `off` early return in `corpusRuntimeEvidenceAllowsDone` |
| 17, 21, 22, 25 | **P1.7** — one seam, one rewrite: `DaemonService.runConfig`, `withRuntimeValidationMode`, the two budget merge sites |
| 18 | ACCEPTED at `8ea156d`; 15 rounds |
| 19 | ACCEPTED at `9e157e1` |
| 20, 24 | **DEFERRED until after P2.** Auditioning models against a review layer that P3 may change discards the observations. Finding 24 (probes bypassing the budget guard) rides with 20, since the audition producer is what issues probes |
| 23 | Reviewer half ACCEPTED at `9e157e1`; detector half ACCEPTED with 35+23 at `4c5bb63` |
| 26 | **OPEN, UNSCHEDULED.** Known weakness: a reviewer-authored claim reaches a worker as unfenced instruction via `task.description` (`src/engine/reviewDrivers.ts:532-533`, `src/findings/validator.ts:156`). Its structural closure was the reviewer-supplied-reproduction design, which the council rejected twice and plan v2 withdrew. Recorded, not fixed |
| 27 | **P1.10** — startup diagnostic naming the offending protocol file |
| 28 | **P1.9** — one-line `DigestEntry` tail field |
| 29 | ACCEPTED at `3d71831` |
| 30 | **P1.9** — the two folds that lose unpriced calls and untasked spend |
| 31 | **P1.11 — ACCEPTED RISK.** See the entry below |
| 32, 34, 43, 44 | ACCEPTED at `78a3378` |
| 33, 36, 38, 40 | SUPERSEDED by later measurement; historical. 33 was self-corrected the day it was written; 36's diagnosis was replaced by 41; 38's three readings were settled by 41; 40's logprob path was probed and found unreachable on the free tier |
| 35 | ACCEPTED with 23 at `4c5bb63` |
| 37, 39, 41 | ACCEPTED; fixed on `task/B-review-plumbing` |
| 42, 45 | ACCEPTED at `b055c81`; re-measured after 32+34+44 |
| **new (2026-09-13)** | **Corpus discarded during materialization** → **P1.8**. `createGateDeps` (`src/engine/candidateDrivers.ts:784-786`) takes a corpus-aware callback whose two branches are identical, so the `corpus` parameter is discarded and `verifyAcceptance` drops it too. A Mission Acceptance Corpus entry is recorded as metadata and never injected or executed for later candidates. This is the "corpus is cumulative and first-class" invariant failing in production. Found by the council during plan review, not by the code audit |

## Finding 31 — ACCEPTED RISK, 2026-09-13

Recorded per `docs/PLAN.md` P1.11.

Item 18's bounded-window design belongs to the class SKILL.state (arXiv 2608.26263) measured as
collapsing at T≥25, and our worker loops run 10–18 turns, mean 14.2 — just below that threshold,
with item 18's own stated benefit being *more turns per budget*.

Accepted as a risk rather than closed, for two reasons. First, **the worker loop is 17.2% of a run's
tokens**, so by Amdahl's law nothing in that region can be a headline win; item 18's measured ~5.8%
net is the ceiling of the region, not a design failure. Second, **no long-horizon fixture exists**:
testing the claim needs a task that forces a worker past 25 turns, and `fixtures/resume-dup-fetch`
does not produce one.

**Revisit trigger:** any run, on any project, that produces a worker loop exceeding 25 turns. At that
point run the arm the finding asks for — bounded window versus full history, compared on task
outcome, not on tokens.

## Findings that changed the plan rather than the code

Recorded because two of the most consequential entries in this file produced no commit and would
otherwise look like unfinished work.

- **29** established that the review swarm is 78.7% of all spend at a 5:1 output-to-input ratio, and
  that `review_adversarial` alone is 64.4%. That measurement is why plan v2's only unconditional cost
  item is a conditional skip of the adversarial axis.
- **41** established that the review swarm had never produced a finding because the request asked for
  a JSON object while the parser demanded an array. Before that fix, every conclusion drawn from
  "zero findings" was a conclusion about the plumbing.

46. **Reviewer exclusions never expire, so a universal rate limit waits forever.**
    `recentlyRateLimitedReviewModels` (`src/engine/reviewDrivers.ts`) has no recency despite its name.
    A model excluded by a sticky failure stays excluded for the rest of the checkpoint, and the only
    thing that rehabilitates it is a *completed* execution for that checkpoint — which an excluded model
    cannot produce, because routing never offers it again. When every model is rate-limited the driver
    therefore returns `waiting` on every tick indefinitely. There is no `retryAfterMs` honoured and no
    elapsed-time release. **Found 2026-09-13** by the GPT-5.6-sol lane in round 2 of P1.2, reproduced
    with a 429 carrying `retryAfterMs: 1` followed by three queued successes: after advancing the clock
    60 seconds and four further ticks the provider had still been called once and the run was still
    `REVIEWING`. Pre-existing and untouched by P1.2, which converted the *truncation* case from this
    same hang into a visible failure. Not scheduled: it rides with the next item that opens the
    exclusion path.

47. **Sticky classification is lossy across persistence, so three error kinds never bound anything.**
    `isStickyReviewSkip` accepts `(err, message)` and branches on `ProviderError.kind` for `bad_request`,
    `auth`, `not_found` and `context_length` — but both production callers pass `undefined` as `err`
    plus the persisted `execution.error` string, so that branch is dead and only the message patterns
    apply. `auth failed (401)`, `not found:` and `This model's maximum context length is …` match none
    of them, so those failures enter neither the exclusion set nor `exhaustedAxes`. `context_length` is
    deterministic — same prompt, same model, same checkpoint — so such an axis retries forever with no
    counter advancing and no exclusion forming. **Found 2026-09-13** independently by both lanes in
    round 2 of P1.2; the Grok lane tabulated every kind against its persisted message. Pre-existing.
    Closure is either to persist the error *kind* alongside the message, or to widen the message
    patterns — the former, since matching prose is what produced this. Rides with the next item that
    touches this seam.
