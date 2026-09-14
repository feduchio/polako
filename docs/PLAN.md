# Polish — plan v2, revision 8 — FROZEN 2026-09-15

> **This document is frozen and is not the current plan.** The current plan is
> `docs/RECOVERY.md`. Nothing here is executed until `docs/RECOVERY.md` §3 is complete.
>
> **Its §2 "Facts" table has been deleted, not corrected.** Four of its entries were false at the
> time they were read: `ModelBroker.restore` has a production caller (`src/daemon/service.ts:129`,
> wired by P1.3); "External projects ever targeted | 0" is contradicted by the store, which records
> a run against `~/polish-selfhost-target` on 2026-09-03 with a fully green baseline; the 78.7% /
> 64.4% review share is a 2026-09-04 snapshot, against 32.6% / 26.7% across the store today; and
> the B-selfhost-8 commit counts exist in four mutually incompatible versions across this file,
> `PHASE-C.md:194`, finding 23 and `B-selfhost-8-run.md:106`. A facts table inside a plan goes
> stale silently and is then cited as evidence. Facts are now obtained by query — see
> `docs/RECOVERY.md` §4 rule 3.
>
> **The economic programme built on those numbers — P1.1, P1.2, P3.1, P3.2 and the §1 cost gate —
> is suspended** pending the re-measurement in `docs/RECOVERY.md` R6.

Base: HOST `4c5bb63` on `phase-c-collab`. Gate there: 860 tests, 85 files, 28.1 s, exit 0.

Scope: **execution order and acceptance process only.** Supersedes the order in
`docs/ledger/PHASE-C.md` and the finding-number queue in `docs/ledger/B-selfhost-remaining.md`.

**Architectural invariants are not amended.** User decision 2026-09-13. §7 maps every item onto
Fable §1 and ADR-0001 as written.

Standing environment for every measurement:

| Name | Value |
|---|---|
| Fixture | `fixtures/resume-dup-fetch` |
| Registered project | `polish-selfhost` → `/Users/fedorsvetlov/polish-selfhost-target` |
| Model policy | `routing.costEligibility: "free_only"` (`src/domain/config.ts:135`) |
| Model pinning | each measurement names its two models in its own ledger file; free-tier membership churns |
| Gate command | `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm vitest run --maxWorkers=2` |
| Blinded corpus | 8 pairs, `src/review/benchmarkCorpus.ts:37-50` |
| Store | `~/.polish/polish.db`; benchmark reports land in the CAS via `src/daemon/service.ts:210-239` |

Review history: rev 1 → Grok `ACCEPT WITH CHANGES`, GPT `REJECT`. rev 3 → Grok
`ACCEPT WITH CHANGES` (5), GPT `REJECT`. rev 4 → Grok `ACCEPT WITH CHANGES` (4), GPT `REJECT` (corpus).
rev 5 → Grok `ACCEPT WITH CHANGES` (3), GPT `ACCEPT WITH CHANGES` (5); no REJECT, the corpus objection
recorded as resolved. Rev 6 applies both sets. §8 lists corrections.

## 1. Goals, admission test, and the G1 exit criterion

| # | Goal (user's words) |
|---|---|
| G1 | удешевить без потери качества выполнение задач |
| G2 | автономное выполнение задач до качественного результата |
| G3 | reduce over-engineering without reducing quality (standing constraint) |

Every item states: goal · files · action · verify · estimate · deletion.

**G1 exit criterion — denominator changed 2026-09-13 on measurement, user decision.**

Revisions 5–8 measured *median total tokens per completed replay-set task*. That criterion cannot be
evaluated: the store holds **2** tasks that reached `INTEGRATED`, against P2.2's floor of 5, so the
gate reported `inconclusive` before P1 began, and at n=2 its two values differ by **7.8×**
(115,475 and 902,060). The guards worked; the denominator was wrong. Completed tasks are the scarcest
object in the store, while the thing P1 changes is a **call not issued**, which needs no completed
task to observe. Full baseline in `docs/ledger/g1-baseline.md`.

**Cost is now measured per review round, quality separately.** The two gates are decoupled, because
they need different denominators.

*Cost gate, primary.* A round is `(runId, checkpointHash, roundIndex)`. At the end of P3, the
**median reviewer tokens per review round** must be at least **20% below** the P1-entry baseline.

| P1-entry baseline | Value |
|---|---|
| Rounds | 6 |
| Reviewer tokens attributed | 834,635, none unattributed |
| Per round | 4,788 · 12,264 · 38,807 · 137,161 · 272,934 · 368,681 |
| **Median** | **87,984** |
| Mean | 139,106 |

*Attribution rule, so two implementers get the same number from the same database.*

1. Scan `events` **ordered by `(run_id, seq)`** — the projection's own order, not `ts`, which can tie.
2. Maintain, per `(runId, axis)`, the round of the most recent preceding `review.started`, taking the
   round from `payload.execution.checkpointHash` and `payload.execution.roundIndex`.
3. For each `type = 'model.call'` with `payload.role == 'reviewer'`, derive its axis as
   `payload.purpose` with the `review_` prefix removed, and attribute it to that axis's current round.
4. **A call whose `payload.usage` is `null` contributes 0 tokens** and is counted separately as
   `nullUsageCalls`. In the baseline, **83 of 209** reviewer calls are in this class — they are the
   failed calls behind finding 37's 429 storm — leaving **126** that carry tokens. An implementation
   that treats `null` as an error, or that silently drops those calls from the round, will not
   reproduce the baseline.
5. Sum `payload.usage.inputTokens + outputTokens`.

This rule attributes 834,635 of 834,635 baseline reviewer tokens with none left over. An
implementation that leaves tokens unattributed has the join wrong.

*Guard 1 — the arm is pinned, not sampled.* The post-change arm must be **all six baseline round
identities, every one of them**, compared **pairwise**, produced by replaying the **same missions and
task contracts** named in `docs/ledger/g1-baseline.md`. Both reviewers showed why: nothing else stops
the median moving on round composition. Dropping only the baseline's most expensive round (368,681)
takes the median of the remaining five to 38,807 — a 56% "improvement" with no per-round saving.
New rounds created by P1.12 or P1.13 are **not** admitted to the cost arm.

*Guard 2 — aggregate spend must not rise, at equal round incidence.* Over the pinned workload,
**total** reviewer tokens must not increase, and **both arms must report their total round count, which
must be equal**. This catches the case where the median falls because missed findings ended a run
earlier while total spend rose. Unequal round incidence is `inconclusive`, not a pass: it means the
workload was not actually matched.

*Guard 3 — companion count, immune to the 77× spread.* Defined precisely, because the obvious
definitions are both wrong: counting **completed** adversarial executions shows no drop, since P1.1
deliberately persists its skip as `completed: true`; counting `review.started` gives 2, 5, 2, 29, 46,
66 per round rather than a rate, because of the 429 storm. The metric is the **fraction of rounds that
issued at least one provider `model.call` with `payload.purpose == "review_adversarial"`**.
Baseline **1.0 — 6 of 6 rounds**. Raw per-round call counts, retries included, are 2, 4, 2, 29, 46, 66.
A "matching drop" means a fall in that rate. A median improvement without one is reported as
**`unexplained`** and is not a pass.

*Floor.* **All 6 baseline rounds must be present and paired** — not "at least 5", which would have
permitted dropping exactly the expensive round Guard 1 exists to protect. A missing pair, an unequal
round count between arms, or an undefined median is **`inconclusive`** — neither a pass nor a trigger
for the revert.

**Quality coupling — this is the binding clause, not an aspiration.** G1 in the user's words is
*cheaper **without losing quality***, and an `inconclusive` quality gate is not evidence of preserved
quality. Therefore: **while the quality gate (P2.2) is not `pass`, no cost-reducing production
behaviour may be enabled by default, and no existing path may be removed.** Making the overall G1
verdict `inconclusive` is not sufficient on its own, because a default-enabled change would still be
in production.

Direct consequence, stated so it is not discovered during implementation: **P1.1 ships with
`review.skipAdversarialWhenClean` defaulting to `false`.** The mechanism lands, is tested, and is
measurable; it is switched on only once P2.2 reaches `pass`. The quality corpus currently holds 2 of
the required 5 entries; how it grows is corrected in P2.2 below, because the mechanism named here in
revision 8 does not exist.

*If the cost gate is not met*, the plan reports **G1 unmet** in the ledger and reverts every
cost-only production change.

Recorded consequence, so it is not discovered later: rounds replayed from cassettes carry frozen
recorded completions, so this gate observes **calls issued**, not a change in live model output.
P1.1's saving is visible to it. A change that only alters the content of a completion is invisible to
it and must be judged by its own item-level verify clause.

**Corrected 2026-09-14: it does not observe prompt footprint.** Revision 8 said "calls issued and
prompt footprint". A replayed response carries the **recorded** `usage`, so a replayed round's token
numbers are the ones the original call reported and do not move when the prompt does. Prompt size is
observable under replay only if it is recomputed from the request the arm actually built, which is a
separate instrument this gate does not have. Until it does, the cost gate is a claim about **call
incidence** at equal round identity.

**Where the replay material is, and the pair identity, added 2026-09-14.** Guard 1 requires the same
six round identities in both arms, and replay mints new run ids, so "the same round" cannot be a run
id. Two facts settle this. The broker persists a `model_request` artifact for every call and a
`model_response` artifact for every successful one (`src/broker/broker.ts:226-269`), so the baseline's
requests and completions **already exist in the CAS** and no new capture item is needed — finding 14
stays dropped and no paid provider is implied. And a round is paired across arms by the **logical**
key `(mission hash, task contract, axis, roundIndex)`, taken from `docs/ledger/g1-baseline.md`, never
by `runId`. An implementation that pairs on run id will find zero pairs and must report
`inconclusive`, not a pass. `RecordReplayProvider` keys on the request's messages, reasoning and
`maxTokens` (`src/providers/recordReplay.ts:31-60`), so any item that changes those fields — P1.2 and
P3.2 both do — misses the baseline entries; a reconstruction must report its key-coverage rate, and a
gate evaluated at partial coverage is `inconclusive`.

This criterion is a project decision recorded here, not a Fable §1 invariant.

## 2. Facts — DELETED 2026-09-15

This table is removed, not corrected. See the freeze banner at the top of this file for the
four entries that were false, and `docs/RECOVERY.md` §4 rule 3 for the replacement practice:
every fact carries the command that reproduces it, or it is not a fact.

## 3. P1 — Live repairs, cost, and transport bounds

No architecture. Each item independently revertible. Order free.

### P1.1 Conditional adversarial skip — G1, the one unconditional cost cut

- Rationale: review is 78.7% of spend and `adversarial` alone is 64.4%. Axes are dispatched in a
  **sequential** loop in `DEFAULT_REVIEW_AXES` order (`src/domain/review.ts:6`), so `adversarial` runs
  last and the earlier axes' executions for the round are already persisted when it is reached.
  Historically 0 of 18 completed executions returned any finding.
- Action:
  1. Edit **only** the dispatch loop at `src/engine/reviewDrivers.ts:172`. Do **not** touch
     `exhaustedAxes` at `:895-915`; it counts sticky failures and is not dispatch.
  2. Before deciding, **re-read the round's persisted executions** from the store. The
     `roundExecutions` binding at `:118` is a snapshot taken before the loop, so on the same tick it
     always shows zero prior findings and would skip even when `correctness` just reported one.
  3. Skip `adversarial` when every already-completed axis of that round returned zero findings.
  4. Persist the skip through the **existing** pair `review.started` / `review.finished` via
     `appendReviewEvent` (`:1113`), producing a `ReviewExecution` with `completed: true`,
     `findings: []`, `error: "no_prior_findings"`, and the `requestedModel` that would have been
     selected for the axis. `completed: true` is required: `missingAxes` (`:823`) and
     `isReviewRoundComplete` (`src/domain/review.ts:55`) count only completed executions, so
     `completed: false` would leave the axis missing forever and requeue it.
  5. Do **not** introduce a `review.axis_skipped` event type. `ReviewExecutionSchema`
     (`src/domain/review.ts:21-33`) has no `reason` field, and projections write `review_executions`
     only from `review.started` and `review.finished` (`src/store/projections.ts:234-235`), so a new
     type would store an event that never becomes a row.
  6. New config field `review.skipAdversarialWhenClean: boolean` in `ReviewStrategySchema`
     (`src/domain/config.ts:39-52`), **default `false`**. The default is `false`, not `true`, because
     §1's quality-coupling clause forbids enabling a cost-reducing behaviour by default while the
     quality gate is not `pass`, and it currently is not. Flip the default to `true` in a separate
     one-line commit once P2.2 reaches `pass`.
- This is a reviewer-count strategy, which ADR-0001 lines 44-48 classify as configurable, not an
  invariant.
- Verify: (a) a scripted round where correctness and regression return `[]` issues two provider calls,
  not three, and the round is complete with three executions of which one has
  `error: "no_prior_findings"`; (b) a round where correctness returns one finding issues all three
  calls; (c) the skipped round does not requeue `adversarial` on the next tick.
- Estimate: 6 h.
- Deletes: up to 64.4% of review spend on clean rounds.

### P1.2 Reviewer output cap as a tail guard — G1, honest framing

- Observed reviewer completions are 435–1,107 tokens (finding 43), so a cap at 1500 **does not bind
  in the observed range**. It is a guard against a tail blow-up, not a saving. Both reviewers flagged
  rev 4 for claiming otherwise.
- Action: new config field `review.maxOutputTokens: number` (default 1500) in `ReviewStrategySchema`;
  pass it as `maxTokens` in `src/review/swarm.ts:69-88`. The provider already exposes
  `finishReason: "length"` (`src/broker/types.ts:90-95`).
  On truncation, persist a **completed** execution — `review.finished` with `completed: true`,
  `findings: []`, `error: "truncated_output"`. `completed: true` is required for the same reason as
  P1.1: `failExecution` writes `completed: false` (`src/engine/reviewDrivers.ts:1077-1085`) and
  `truncated_output` is not in `isStickyReviewSkip` (`:756-765`), so `missingAxes` would requeue the
  axis and the stated "no retry" would silently become an unbounded retry loop. No new event type.
  Rev 3's retry-at-lower-length is withdrawn.
- Derivation of 1500: 3× the ~115-token rendered size of one finding, times a 4-finding allowance,
  rounded up. Recorded as an estimate, not a measurement.
- Verify: (a) a stubbed provider returning `finishReason: "length"` produces `review.finished` with
  `completed: true` and `error: "truncated_output"`, never a silent empty findings array; (b) the axis
  is not requeued on the next tick.
- Estimate: 3 h.
- Deletes: the unbounded tail.

### P1.3 Durable spend across restart — G2 — **UNBLOCKED at `0c69901`**

**The blocker below is resolved, and the anomaly it describes was a misreading.** P1.7 is accepted at
`0c69901`. While reading that seam the coordinator found the explanation: the test
*"keeps the sound half of a run's persisted budget when the other half is corrupt"* writes `facade.json`
**twice**, and its second write is `{ ...metadata, budgetTokens: "lots" }` over the *original*
metadata — so `budgetUsd: 1` is restored and is the **sound** half. `limit: 1` is correct, not
mysterious; the previous session read the first write while reasoning about the second scenario. The
real obstacle is the one already given for the other three cases: these tests restart repeatedly on one
run and rely on spend resetting to zero. The original note is kept below as the record of what was
believed at the time.

**Blocker as recorded 2026-09-13, superseded.** The production change is one loop after `engine.recover()` calling
`broker.restore(run.id)` for each run in `listActive()` — the same predicate `engine.tick` drives, so
the restored set and the ticked set cannot drift. It is committed on `task/P1.3-wip` (`98d07b2`) and is
believed correct.

Restoring spend broke four pre-existing tests in `src/daemon/service.budget-override.test.ts` that had
encoded the defect as expected behaviour: they restart repeatedly on the same run and relied on spend
resetting to zero. Three were restructured correctly. The fourth, *"keeps the sound half of a run's
persisted budget when the other half is corrupt"*, hits an anomaly that is **not explained**:

- the on-disk facade contains `"budgetUsd":"lots"`;
- the resolved daemon-wide budget prints `maxRunUsd: 100`;
- the guard nevertheless rejects with `{budget: "run_usd", limit: 1, spent: 1.5}`;
- the first three calls pass and only the fourth sees limit 1.

That is the signature of a cached resolution, but `DaemonService.runBudget`'s cache is per instance and
the service is freshly constructed. The source of the `1` is neither the config nor the corrupted file.

This is the two-merge-site seam that findings 17, 21, 22 and 25 describe and that **P1.7 rewrites into
a single resolver**. Diagnosing it inside P1.3 would be guessing. User decision 2026-09-13: **do P1.7
first**, then rebase `task/P1.3-wip` onto the cleaned seam and either the anomaly disappears or it
becomes explainable.

- Problem: `ModelBroker.restore(runId)` (`src/broker/broker.ts:277-283`) folds a run's `model.call`
  events back into the budget tracker and has **no production caller**. Recovery ends at
  `this.engine.recover()` (`src/daemon/service.ts:110`). A restarted daemon believes every run has
  spent nothing. Finding 12, spend half.
- Action: **wire it.** After `engine.recover()`, call `productionDeps.broker.restore(run.id)` for
  every **resumable** run. `store.repos.runs.listActive()` (`src/store/repositories.ts:50-53`) is
  **not** the right predicate: it excludes `NEEDS_HUMAN` phases and `STOPPED` controls, both of which
  can resume later and would then restart with zero restored spend. Resumable = any run whose phase
  is not `DONE` or `FAILED`, regardless of control state.
- Verify: (a) a run with recorded `model.call` usage, after `engine.recover()`, reports non-zero
  spend and the next call exceeding the cap is rejected; (b) the same holds for a run recovered in
  `STOPPED` control and for one in `NEEDS_HUMAN` phase.
- Estimate: 1 h. Deletes: nothing; the method is correct, only the call site is missing.

### P1.4 Per-axis unique recall — G1, measurement only

- Problem: `src/review/benchmarkRunner.ts:334` hard-codes `axis: "correctness"`, so `regression` and
  `adversarial` have never been scored.
- Action: (1) parameterise the axis in the benchmark schedule and run all three per pair;
  (2) attribute each primary hit to the axes that found it; (3) add `uniqueHits` and
  `tokensPerUniqueHit` per axis to the report type returned by `runReviewerBenchmark`
  (`src/review/benchmarkRunner.ts:113-151`), which the daemon already persists as a CAS artifact
  (`src/daemon/service.ts:210-239`). Repetitions and models: as the existing corpus schedule, named
  in the run ledger. Ties: report both, do not break them.
- **Cell identity must become axis-qualified, and this is a prerequisite, not a detail.**
  `ScheduledBenchmarkCell` (`src/review/benchmarkRunner.ts:43-49`) and `BenchmarkOracle`
  (`src/review/benchmark.ts:12-20`) carry no axis, and the existing identity is
  `(seed, pairId, label, provider, model, repetition)` (`:159-172`). Scheduling three axes under that
  identity produces duplicate `cellId` values, which export and rescore reject or silently collapse,
  because they require one-to-one packet, oracle and response ids (`:260-272`). Therefore: add `axis`
  to `ScheduledBenchmarkCell`, to the persisted oracle record, to exported packets, and to rescore
  reconstruction, and derive `cellId` from
  `(seed, pairId, label, provider, model, repetition, axis)`.
- **Aggregation key, which decides P3.1 and must not be left to the implementer:** a hit is unique to
  an axis when, for a given **pair**, that axis produced a primary hit in **at least one** cell and no
  other axis produced one in **any** cell. `tokensPerUniqueHit` is that axis's total tokens across all
  its cells divided by its unique-hit count. When an axis has zero unique hits, report
  `tokensPerUniqueHit: null`, never infinity, and treat `null` as the worst value in P3.1's ordering.
- Verify: the persisted report lists, per axis, the pairs on which that axis was the sole finder, and
  a `null` for any axis with none.
- Estimate: 6 h. Deletes: nothing; it licenses P3.1.

### P1.5 Reasoning effort beyond reviewers — G1, measurement only

- Problem: the accepted 4.2× reviewer result is recorded as "transport efficiency, not a quality
  claim" (`B-selfhost-remaining.md:415-429`); it may not be extrapolated.
- Call sites: worker — `src/daemon/composition.ts` `createWorkerFactory`; council —
  `CouncilRoleAgent.analyze` (`src/council/roles.ts:19-34`).
- Action: A/B `reasoning: DISABLED_REASONING` at those two sites, 3 fixture runs per arm, models
  pinned in the run ledger. Decision predicate, made decidable: **the multiset of task *titles*
  reaching `INTEGRATING` is identical in all 3 runs of both arms, and total tokens are lower in the
  disabled arm in all 3.** Titles, not ids: ids contain random bytes (`src/shared/ids.ts:17-31`) and
  can never compare equal across runs. If the fixture is not that deterministic across 3 runs, the
  experiment reports "inconclusive — fixture nondeterministic" and the default does not change.
- Estimate: 4 h. Deletes: nothing yet.

### P1.6 Runtime mode `off` early return — G2

- `corpusRuntimeEvidenceAllowsDone` (`src/domain/acceptance.ts:121-134`) has no early return for
  `off`; siblings `runtimeAllowsDone` (`:86`) and `runtimeCorpusAllowsDone` (`:107`) do. It is the
  production DONE helper (`src/engine/convergenceDrivers.ts:440-445`). Finding 16.
- Action: copy the `mode === "off"` early return from `:86`.
- Verify: mode `off` with a failed current-hash runtime entry permits `DONE`.
- Estimate: 20 min.

### P1.7 The `runConfig` seam — G2

- Files: `src/daemon/service.ts:450-459` (`runConfig`), `:487-494` (`persistedRuntimeMode`), `:502`
  (`facade.json` path), `:458` (budget merge site 1); `src/daemon/composition.ts:169-173` (budget
  merge site 2; definition at `:138`); `src/domain/config.ts:276-282`
  (`withRuntimeValidationMode`, still returns `base` when the mode matches).
- Problems, one seam: settings and runtime mode not restored across restart (finding 12, settings
  half); `polish.toml`'s `runtimeValidation.mode` never effective because RPC and CLI both default an
  omitted `--runtime` to `auto` (17); a corrupt `facade.json` silently downgrades a `required` run
  with no event (21); the static pin misses `config["runtimeValidation"].mode` and `Object.assign`
  (22); `applyRunBudgetOverrides` applied at two independent sites (25).
- Action: (1) `resolveRunSettings(runId): { config: PolishConfig; budget: BudgetLimits }` — note
  `BudgetLimits` from `src/broker/quota.ts:11-15`, not `RunBudgetLimits` — owned by `DaemonService`
  and called by both consumers; (2) unconditional copy in `withRuntimeValidationMode`, retiring the
  pin rather than widening it; (3) add `run.settings_fallback` to `KNOWN_EVENT_TYPES`
  (`src/domain/event.ts:10-74`) with payload `{ reason: string; requestedMode: RuntimeCapabilityMode
  | null; effectiveMode: RuntimeCapabilityMode }`. `runId` is on the envelope, not the payload.
  `requestedMode` is **`null`** when `facade.json` is unreadable, because the requested value exists
  only in that file. Emit **at most once per run**, keyed on `runId`, not once per `runConfig` call.
  (4) For finding 17, the omission must survive the RPC boundary: `src/daemon/service.ts:145-149`
  converts an omitted `--runtime` to `"auto"` before `runConfig` can distinguish it, so the RPC
  payload must carry `runtime: null` for "not specified" and `resolveRunSettings` must resolve `null`
  to `config.runtimeValidation.mode` from `polish.toml`.
- Verify: (a) enforcing and reporting surfaces read one resolver, so divergence is unrepresentable;
  (b) a run created with no `--runtime` and `polish.toml` set to `required` is effectively `required`;
  (c) two `runConfig` calls on a run with a corrupt `facade.json` emit one
  `run.settings_fallback`, not two. Name the retired cases from `service.runtime-mode.test.ts` and
  `service.budget-override.test.ts` in the commit message.
- Estimate: 1 day. Deletes: one merge site and both source-grep pins.
- **Measured after acceptance at `0c69901`, correcting the prediction above:** the 982-line test file
  did **not** shrink by a third — it grew to 1105. Three cases were retired (finding 17's inverted
  expectation and the two pins) and nine added, because MC9 forbids retiring behavioural isolation and
  the new clauses need new cases. Recorded at the round-3 reviewer's request so **P1.3 does not expect
  a slimmer file**. Run record `docs/ledger/P1.7-run.md`.

### P1.8 Executable Mission Acceptance Corpus — G2, invariant repair

The council's fatal objection across two rounds. Both reviewers converged on the same fix
independently; it is written verbatim below.

- Problem: `createGateDeps` (`src/engine/candidateDrivers.ts:785-787`) takes a corpus-aware callback
  whose two branches are identical, so `corpus` is discarded; `verifyAcceptance` at `:789` drops it
  too. `CorpusEntry` (`src/domain/acceptance.ts:137-150`) carries `artifactHashes` and no
  `relativePath`, while `AcceptanceStorage.materialize` (`src/store/acceptance.ts:21-38`) requires
  `{relativePath, sha256}`. Admission copies hashes from validation evidence
  (`src/findings/validator.ts:140-149`), which may be command-output blobs rather than executable
  files. Protected-path inspection (`src/project/checkRunner.ts:650-669`) and canonical verification
  (`:700-716`, `:782-825`) look only at `AcceptanceArtifact[]`. Net effect: a corpus entry is
  recorded as metadata and is never injected or executed for later candidates.
- Action, one path, no fork:
  0. **Where the bytes come from**, since nothing in the tree produces an executable file today:
     the artifact is the **winning candidate's own regression test file** for the fixing task, read
     from the integration workspace after that task passes integration gates. Not
     `validation.evidenceRefs`, which are command-output blobs (`src/findings/reproduce.ts:170`), and
     not `suggestedCheck`, which is prose or a command (`:196-204`). `relativePath` is that file's
     path relative to the repository root; `sha256` is its content hash. If the fixing task's diff
     contains no test file, no corpus artifact is admitted and the corpus entry stays metadata —
     record that outcome rather than synthesising a file.
  1. Persist each executable corpus artifact **as** an `AcceptanceArtifact` with `relativePath` and
     `sha256`. The corpus entry stores that artifact's id and path, not evidence-output hashes.
  2. Admit the descriptor **after the fixing task passes integration**, atomically with the corpus
     entry.
  3. `materializeAcceptance` and `verifyAcceptance` **union** `acceptance.forTask` with the mission
     corpus artifacts, and that union feeds pre-materialization protected-path inspection,
     materialization, and post-materialization canonical hash verification.
  4. **No backfill.** Legacy hash-only entries stay metadata and are recorded as such; fail closed
     on any legacy entry that cannot be mapped to a path rather than guessing one.
- Verify: a corpus artifact admitted for task A is materialized, protected, hash-verified **and
  executed** in the evaluation checkout of a later candidate for task B; tampering with it fails the
  gate; a legacy hash-only entry produces an explicit `unmappable_legacy_corpus_entry` failure, not
  a silent skip.
- Estimate: 2 days.
- Deletes: one dead branch and the false claim that the corpus is cumulative.
- Note, out of scope unless the implementer finds it necessary: admission is not atomic today —
  validation and task events are appended before `corpus.entry_added`
  (`src/engine/reviewDrivers.ts:240-248`, `src/store/missionAcceptance.ts:45-58`).

### P1.9 Two folds that lose data — G1

- Files: `src/observe/project.ts:468` (`usdUsage`), `src/convergence/pathology/budget.ts:76-79`
  (`foldModelCallUsage`), `src/agents/loopWindow.ts:163` (`collectEntries`).
- Problems, corrected: `usdUsage` sums priced calls and returns `null` when none were priced — it
  does **not** return 0, which rev 4 claimed; the defect is that a partially priced run reports a
  number that silently omits the unpriced calls. `foldModelCallUsage` already records
  `unknownCostCalls` at `:77-78`; it drops `taskId: null` from `perTask` at `:79` only, while
  `runTokens` at `:76` is correct. `collectEntries` strips a failing command's exit code when the
  argv contains `: `.
- Action: `usdUsage` returns `{ usd: number | null; unpricedCalls: number }`; update
  `src/observe/types.ts:73-76` accordingly. For `perTask`, **bucket untasked spend by
  `payload.role`** (`src/broker/broker.ts:172`) rather than into one `__council__` key, because
  council, probes, supervisors and reviewers all omit `taskId` (`src/council/roles.ts:28-33`,
  `src/review/swarm.ts:86`). **Representation:** a separate `perRole: Record<string, number>` field on
  the fold result, **not** reserved keys inside `perTask`. Reason: `exhaustedDimensions` iterates every
  `perTask` key (`src/convergence/pathology/budget.ts:124-127`) and would enforce a role bucket as if
  it were a task; a separate field makes that inexpressible rather than merely excluded. A `model.call`
  with an absent or non-string `role` goes to a `"unknown"` bucket and is counted, never dropped.
  `DigestEntry` (`src/agents/loopWindow.ts:37-46`) carries the output tail as its own field instead of
  re-parsing rendered text.
- Verify: five tests — a partially priced run reports non-zero `unpricedCalls`; role buckets appear in
  `perRole`; `perTask` contains no non-`IdSchema` key; a call with a missing `role` lands in
  `"unknown"`; a failing `git commit -m "fix: x"` retains `-> exit 1`.
- Estimate: 5 h. Deletes: one regex.

### P1.10 Protocol load diagnostic — G2

- Problem: `buildProductionDeps` loads the registry eagerly from the `DaemonService` constructor.
  `ProtocolRegistry.load` throws `NOT_FOUND` for a missing directory and `INVARIANT_VIOLATION` for a
  duplicate or a name/folder mismatch (`src/protocols/loader.ts:17-38`), and **those errors do not
  carry the path**. Finding 27.
- Action: the wrapper supplies the path, because the loader does not. Wrap the eager load; on
  `PolishError` from the loader, re-scan `protocols/*/SKILL.md`, identify the offending entry by
  re-applying the loader's own name/folder check, and rethrow a `PolishError` with message
  `protocol registry failed to load: <code> at <absolute path to the offending SKILL.md, or to the
  protocols directory when no single entry can be identified>`. Write the same line to stderr. Do
  not catch and continue.
- Verify: a protocol directory whose `SKILL.md` name does not match its folder yields a message
  containing both the code and that folder's absolute `SKILL.md` path.
- Estimate: 1 h.

### P1.11 Finding 31 — decide, do not dismiss — G3

- Rev 3 closed it with a spend-share argument, which answers the wrong question: finding 31 is an
  accuracy claim, that item 18's bounded window belongs to the class SKILL.state measured as
  collapsing at T≥25 while our loops run 10–18 turns.
- Action, default **(b)**: record finding 31 as an accepted risk in
  `docs/ledger/B-selfhost-remaining.md` under finding 31, with the reason that the worker loop is
  17.2% of spend, that no long-horizon fixture exists, and that it is revisited if any run produces
  a worker loop of 25 turns or more. Option (a), the long-horizon arm, requires a fixture we do not have
  and is not scheduled. No file is deleted by this item; rev 5 named a deletion target in §12 that
  does not exist there, and that instruction is withdrawn.
- Verify: `docs/ledger/B-selfhost-remaining.md` finding 31 begins with `**ACCEPTED RISK**`, states
  the 17.2% figure, states the missing-fixture reason, and states the revisit trigger (any worker loop
  of **25 turns or more**). No other file changes.
- **Trigger bound corrected 2026-09-14**, from "exceeding 25 turns". The collapse the finding cites
  begins at **T≥25**, so exactly 25 is inside the region and the exclusive wording would have let the
  one value the trigger most needs to catch pass unnoticed. Found in the process-v3 re-check.
- Estimate: 1 h.

### P1.12 Finding 13 — daemon coding E2E — G2

- Problem: engine and RPC round-trips exist; the daemon coding E2E is `DONE`-only.
- Files: extend `src/e2e/b10-daemon.test.ts`.
- Action: three scenarios through `DaemonService` RPC on `fixtures/resume-dup-fetch` with
  `ScriptedProvider`: (1) a run that reaches `NEEDS_HUMAN` and answers via the RPC answer flow, then
  resumes to a terminal phase; (2) a run that receives `STOP_REQUESTED` mid-`EXECUTING`, reaches
  `STOPPED`, then `resume` returns it to `EXECUTING`; (3) a run killed by destroying the service
  mid-`EXECUTING`, then recovered by a fresh `DaemonService` over the same store.
- Verify, per scenario, since rev 5's single "terminal phase" clause did not match the three
  scenarios: (1) asserts phase `NEEDS_HUMAN`, then after the answer asserts phase `DONE`;
  (2) asserts control `STOPPED` with phase preserved, then after `resume` asserts control `RUNNING`
  and phase `EXECUTING`; (3) asserts the recovered run's phase equals the pre-kill phase, its job set
  is restored, and — after P1.3 — its spend is non-zero. All three additionally assert event causality
  is unbroken and no worktree is left behind.
- Estimate: 1 day.

### P1.13 Finding 15 — `runtime=required` happy path — G2

- Depends on P1.6 and P1.8.
- Files: `src/e2e/`, `fixtures/resume-dup-fetch`, `src/runtime/fixtureRunner.ts`.
- Action: one scripted E2E with `--runtime required` that reaches `DONE`. "Persisted corpus
  identity" means: the `RuntimeEvidence` recorded for the accepted checkpoint references a corpus
  entry whose artifact id and `relativePath` are stable across a daemon restart, asserted by
  reloading the store and re-reading the entry.
- Verify: the run reaches `DONE`; removing the runtime evidence makes the same run fail to reach
  `DONE`; the corpus entry survives a restart with the same identity.
- Estimate: 1 day.

**P1 exit:** gate green. Baseline recorded for the G1 exit criterion. P1.4 report persisted.
Findings 12, 13, 15, 16, 17, 21, 22, 25, 27, 28, 30, 31 and the corpus defect closed or explicitly
accepted.

## 4. P2 — Measurements that gate P3

No production change.

### P2.1 Post-validation yield — gates P3.1

- The 60.0% clean-site false-positive figure is measured on **raw reviewer output**. Production runs
  findings through triage and reproduction (`src/findings/validator.ts:82-161`,
  `src/engine/checkpointCheckout.ts:88-104`, `src/engine/reviewDrivers.ts:206-249`). What survives
  has never been counted.
- Council correction: this measures **attrition, not precision**; a count cannot say which survivors
  are false positives. And `ReviewExecution` (`src/domain/review.ts:21-33`) has no token fields, so
  tokens must come from `model.call` events joined on `purpose: review_<axis>`.
- Action: query `review_executions`, `findings`, `finding_validations`, `tasks` and `model.call` in
  `~/.polish/polish.db`. Report per axis: raw findings, surviving triage, surviving reproduction,
  tasks spawned, tokens. Then hand-adjudicate the survivors; the row count makes this tractable.
- **Eligibility, added 2026-09-14, because without it this item measures the wrong thing.** Only
  review executions **after finding 41's plumbing fix** are admissible. Finding 41 established that
  the request asked for a JSON object while the parser demanded an array, so every earlier execution's
  recorded emptiness is discarded parser output, not yield. Measured 2026-09-14: the store holds 2,600
  review executions, 18 of them completed, and **all 2,600 belong to the two runs last updated
  2026-09-04** — so the eligible set is currently **empty**, and it is empty for a reason that has
  nothing to do with review quality. The correct statement is "no eligible rows", never "zero
  findings".
- **Verdict when the eligible set is empty:** P2.1 reports
  **`inconclusive — no post-plumbing production findings`**, and the report states the eligible count
  and the cut-off it applied. It does not report a yield of zero.
- Estimate: 4 h.

### P2.2 Non-inferiority baseline — gates P3.2 and P3.3 (quality only)

Scope narrowed 2026-09-13: this set governs **quality non-inferiority**, not the cost metric. The
cost denominator is the review round, defined in §1, because only 2 tasks in the store reached
`INTEGRATED` and the 5/2 floor could never be met. If this set stays short, the **quality** gate
reports `inconclusive` and P3.2/P3.3 do not proceed; the cost gate is unaffected.

- Action: write `docs/ledger/replay-set.md` containing the fixture mission plus every task in
  `~/.polish/polish.db` that reached `INTEGRATING`, each with run id, task id, checkpoint hash and
  recorded token cost, and the two model names pinned. Runner: the scripted E2E harness under
  `src/e2e/`. Repetitions: 3 per arm.
- Reconstruction rule, since historical runs cannot be replayed verbatim: a replay-set entry is
  reproduced by re-running its **mission and task contract** against the fixture with
  `ScriptedProvider` cassettes where they exist, and is otherwise recorded as
  `not_replayable(reason)` and excluded from the gate. State the excluded count in the file.
- **Minimum denominator, so the gate cannot become vacuous:** the replay set must contain **at least
  5 replayable entries**, of which at least 2 reached `DONE`. `completed` means the entry's terminal
  phase is `DONE`. If fewer, P2.2 reports **`inconclusive — insufficient replay corpus`**, and every
  gate that depends on it (P3.2, P3.3) reports `inconclusive` rather than passing. A set that **does**
  meet the floor is evaluated normally, cassettes included. There is no separate cassette-only
  prohibition. **Measured 2026-09-13: the store holds 2 such tasks, so this floor is currently unmet
  and the quality gate is `inconclusive` until the corpus grows.**
- **How the corpus grows — corrected 2026-09-14, because revision 8's mechanism does not exist.**
  Revision 8 said the corpus grows as a by-product of P1.12 and P1.13. It cannot. Every E2E builds its
  own `home` with `mkdtempSync` and deletes it in `afterEach` (`src/e2e/b10-daemon.test.ts:141-150`,
  `:200-201`, `:286-289`), so no scripted run has ever inserted a row into `~/.polish/polish.db` and
  none ever will. Since P2.2's runner is already the scripted harness, the entry — not the row — is
  what matters: **a replay-set entry may be a committed scripted scenario**, a fixture mission plus
  task contract that the harness takes to a named terminal state, recorded in
  `docs/ledger/replay-set.md` with that state, and it counts toward the 5/2 floor even though its
  store was deleted. Two consequences, both binding. Such an entry is **not** admitted to §1's cost
  arm: `ScriptedProvider` does not report real spend. And frozen completions test **orchestration**,
  not model output, so a set made only of them can establish that a change did not break the pipeline
  and can **never** discharge quality non-inferiority for a change that alters what a model is asked
  or what it returns; such a change is `inconclusive` here regardless of the floor.
- Gate, quality only: a change may replace an existing path only if every replayable entry reaches the
  **same terminal state** in all 3 repetitions. The phrase "at equal or lower cost" is **removed**:
  cost is §1's gate on its own denominator, and leaving a cost comparison here re-imported the retired
  task-based metric into a quality-only section, where it was also unevaluable at n=2. Token cost stays
  in `replay-set.md` as metadata for §1's use, not as a condition of this gate.
- Estimate: 6 h.

### P2.3 Discovery smoke on a second repository — G2

- Action: `polish run <repo> --runtime off`, stop after `DISCOVERING_PROJECT` and `BASELINING`.
  Repository: named by the user at execution time; if unnamed, a clean clone of a small public
  TypeScript repo with a working `pnpm test`.
- Not Fable D1. The full external run is not scheduled in this document.
- Estimate: 1 h.

**P2 exit:** P2.1 report, `docs/ledger/replay-set.md`, and the smoke record exist.

## 5. P3 — Conditional, gated

Starts only after P2. Each item lands behind a config flag with the existing path retained, and must
pass P2.2 before the old path may be removed.

### P3.1 Drop the weakest axis — G1

- Gated on **P2.1**, not P1.4 alone: rev 4 was corrected for deciding G1 by the raw metric P2.1
  exists to replace.
- Mechanism: `reviewersPerRound` is a **count** cycling `DEFAULT_REVIEW_AXES`
  (`src/domain/review.ts:6-18`), so lowering it drops `adversarial` regardless of measurement.
  Dropping a named axis requires changing `DEFAULT_REVIEW_AXES` **and** the
  `axes.length < DEFAULT_REVIEW_AXES.length` guard at `:10-11` in the same change.
- Criterion: lowest **VALID findings per token** from P2.1; ties broken in favour of higher unique
  raw recall from P1.4.
- **P1.4 has reported, and it supplies no tiebreaker.** Measured 2026-09-14 at seed 43, 168 of 288
  cells: **no axis has a unique hit.** `correctness` and `regression` each hit all eight pairs and
  `adversarial` six, all shared, so `tokensPerUniqueHit` is `null` for all three and the tie above
  cannot be broken. P3.1 is therefore decided by P2.1 alone, or reports that it cannot be decided.
  Two further figures from the same run, so this item does not start from the assumption that
  `adversarial` is the axis to drop: the worst clean-site false-positive rate is `correctness` at
  80.0%, and the best pair discrimination by a wide margin is `regression` at 70.6% against
  `adversarial`'s 26.7% and `correctness`'s 17.6%. `adversarial` is the weakest on raw recall
  (65.0%), which is what the plan expected. Full record in `docs/ledger/P1.4-run.md`.
- **When P2.1 is `inconclusive`, P3.1 reports `inconclusive — no post-validation yield data` and
  drops no axis. Added 2026-09-14, with two bounds on what that means.** First, it is **not** a
  licence to re-point this item at the blinded corpus: that criterion was moved off raw recall in
  revision 4 on purpose, and P1.4 has already reported the raw numbers. An undecidable P3.1 stays
  undecided. Second, it does **not** cascade. P3.2 is void only if P3.1 *drops* `adversarial`, which
  an undecided P3.1 does not do, and P3.3 depends on P1.8 and P2.2 and not on P2.1 at all. Both remain
  gated exactly as written below.
- Void if P1.1's conditional skip already reduced the axis to near-zero use; check the skip rate
  first.
- Verify: recall on the 8 pairs must not fall; P2.2 replay set unchanged.
- Estimate: 4 h.

### P3.2 Adversarial axis as falsifier — G1

- Void if P3.1 dropped `adversarial`. The axis sees only the diff and the other axes' findings and
  may only refute, bounding its output by the number of existing findings.
- Verify: P2.2 replay set unchanged; recall on the 8 pairs must not fall.
- Estimate: 1 day.

### P3.3 Fail-to-pass on the corpus — G2

- Depends on P1.8, without which corpus entries are never executed at all.
- Check first whether admission already requires the artifact to have failed before the change;
  baseline-relative gates compare check results, which is not the same requirement. If absent, add
  it. Touches neither `src/verify/` nor convergence accounting.
- Estimate: 1 day including the check.

### Withdrawn, with reasons

| Withdrawn | Reason |
|---|---|
| **Reviewer-supplied reproduction** | Rejected by both reviewers over two rounds. Not a change of author: today `ProjectFindingEvidenceWorker` infers a command from prose and runs it one-sidedly, fail⇒`VALID` (`src/findings/reproduce.ts:28-38,115-167`), so a two-sided discriminating test is a new oracle and a new pre-VALID filter. It also required corpus materialization, which was broken. And it added a second reproduction mechanism while keeping prose review and the Evidence Agent, deleting nothing — fails G3. **Unscheduled option**; revisit only after P1.8 ships and P2.1 shows validation does not already filter the false positives. |
| Delete `src/verify/` | `EmpiricalVerifier` wired at `composition.ts:715`, accepted 2026-09-13 at `78a3378`. Only the unread key `verifier.empiricalPivots` goes. |
| Delete pathology, re-implement no-progress | `detectTestOnlyTreadmill` shipped with accepted 35+23. |
| One clean round instead of N | `B-selfhost-8-run.md:8-14`: accepted after rounds 14–15, wrongly; five further rounds reopened it. |
| `git checkout --` replacing `ProtectedChangeWaiver` | The invariant expressly permits mission-authorised test and config changes under independent validation. |
| Delete `NEEDS_HUMAN` | Termination is not success. |
| Workers over ACP / subscription CLI | Contradicted the Amdahl argument: worker loop is 17.2% of spend. Also blamed workers for the 429 storm, which finding 37 records as 2,465 rate-limited **review** executions. User authorisation for personal local use is recorded and unused. |
| Full external run as Fable D1 | Reduced to P2.3. |
| Review cache | Withdrawn; key was incomplete and the win is unquantified. |
| Retry truncated reviewer calls at a lower length | Withdrawn; fail closed instead. |

## 6. P4 — Confirmed dead code

Grep-confirmed unused at `4c5bb63`. Delete outright; git history is the backup.

| Target | Lines | Evidence |
|---|---|---|
| `src/context/facts.ts:FactsService` | 187 | no production instantiation |
| `src/intel/codegraphCli.ts` + `composite.ts` | 378 | not imported by `composition.ts`; production uses `new BasicIntel` at `src/agents/runner.ts:52` |
| `CleanRoundTracker` class | ~60 of `tracker.ts`'s 110 | superseded by `hasConverged` / `recordCleanRoundEvent`; **keep** `preferRotatedEnsemble`, live at `pathology/ensemble.ts:17` |
| `buildSupervisorView`, `ProtocolRegistry.readResource`, `executionEvidenceIsSufficient` | ~120 | test-only callers |
| `protocols/typescript`, `protocols/react-native` | 34 | no selector; `ProjectProfile.framework` is a test-runner hint |
| Unread config fields | ~40 | `review.rotateEnsembles`, `retry.freshWorkerAttempts`, `retry.escalateTierFromAttempt`, `contextBudget.workerPackFraction`, `supervisorViewFraction`, `verifier.empiricalPivots`, `sandbox.backend`, unused lane limits |
| Duplicate `RunHead` | 8 | `engine/integration.ts:16`, `convergence/rollback.ts:7` |

Total ≈ 830 lines, about 2.7% of `src/`. Estimate: 1 day including gate.

**Struck:** `ModelObservationRepository.recordQuality` — called in production at
`src/broker/observations.ts:206` and `:211` inside `restoreCatalog`.
**Separate task, not a janitor item:** `TASK_TABLE` / `CANDIDATE_TABLE` / `validateTable` are unused
because they were never wired, while `FINDING_TABLE` **is** wired (`reviewDrivers.ts:542-543`).
Deleting them removes a specification without adding enforcement. Decide explicitly: wire or delete.

CodeGraph is named in ADR-0001. Deleting the CLI backend needs a one-paragraph ADR note, not an
invariant amendment: the `RepositoryIntelligence` seam and `BasicIntel` remain.

## 7. How this plan stays inside the invariants

| Invariant | Status |
|---|---|
| Task origin ∈ `valid_finding \| mission_requirement \| investigation` | Untouched. The only item that pressured it is withdrawn. Shape enforced by `TaskStrictSchema` (`src/store/projections.ts:104-108`); the finding/validation relationship by the factory (`src/domain/task.ts:197-233`), not the store. |
| Clean rounds bound to `checkpoint_hash`, invalidated by any code change | Untouched. Accounting stays (`src/convergence/record.ts:99-157`). No item changes `required_clean_rounds` from its default of 3 (`src/domain/config.ts:55`). |
| Mission Acceptance Corpus cumulative and first-class | **Violated in production today**; repaired by P1.8, which is the plan's answer to the council's fatal objection. |
| ProtectedChangeWaiver | Kept. |
| Deterministic evidence before opinion | Unchanged. Gates precede review. |
| No model names in core | Unchanged. ACP withdrawn. |
| Reviewer counts / axes | ADR-0001 lines 44-48 classify these as configurable strategy, which is what P1.1 and P3.1 change. |

## 8. Corrections carried from earlier revisions

| Earlier claim | Correct value |
|---|---|
| intel backends ~700 lines | 378 |
| `src/` 29,852 / 29,187 | 30,347 / 30,116 |
| `CleanRoundTracker` ~80 lines | ~60 of 110 |
| B-selfhost-8 test file 955 lines | 982 |
| B-selfhost-8 "3 commits, 24 test-only" | 2 behaviour commits, 26 test-only |
| `src/verify/` deletable | wired in production |
| `recordQuality` test-only | called at `observations.ts:206,211` |
| findings 17, 21, 22, 25 dead machinery | live behaviour defects, now P1.7 |
| finding 16 settled by an external run | one-line early return, now P1.6 |
| finding 31 closed by a spend-share argument | accepted risk, P1.11 |
| `service.ts:355-373` for the seam | `:450-459`, `:487-494`, `:502` |
| `config.ts:266` for `withRuntimeValidationMode` | `:276-282` |
| `composition.ts:139-141` as merge consumer | definition; consumers are `composition.ts:169-173` and `service.ts:458` |
| `config.ts:121` for `costEligibility` | `:135` |
| "drop an axis by config" | `reviewersPerRound` is a count; `DEFAULT_REVIEW_AXES` is the lever |
| `usdUsage` "returns 0" on unpriced calls | returns `null` when none priced; the defect is silent omission in partially priced runs |
| all `taskId: null` is council spend | probes, supervisors and reviewers also omit it; bucket by `role` |
| 1500-token cap is a saving | observed completions are 435–1,107; it is a tail guard |
| review cache, truncation retry | withdrawn |
| "§6 states how" | §7 |
| "seven blocks" | four phases |
| `reviewDrivers.ts:905` is a dispatch site | it is `exhaustedAxes`; dispatch is `:172` with axis order at `:815-828` |
| a `review.axis_skipped` row is representable | it is not; projections write `review_executions` only from `review.started` / `review.finished` (`projections.ts:234-235`) |
| `completed: false` implements "no retry" | it requeues the axis via `missingAxes`; skips and truncations must be `completed: true` |
| `listActive()` is the set of runs to restore spend for | it excludes `NEEDS_HUMAN` and `STOPPED`, both resumable |
| task ids comparable across runs | ids carry random bytes (`src/shared/ids.ts:17-31`); compare titles |
| role buckets as reserved keys in `perTask` | a separate `perRole` field; `exhaustedDimensions` iterates every `perTask` key |
| corpus artifact bytes come from validation evidence | they come from the winning candidate's regression test file after integration |
| `889b62d` appears nowhere in the ledger | it is the frozen base in `B-selfhost-35-23.md:3` and `B-selfhost-35-23-run.md:7`; what was missing from `PHASE-C.md` was the integrated HOST `4c5bb63` |
| the stale `916f7f2` base is a repo file | it is a Cursor user rule; every repo occurrence is a legitimate historical record |
| the quality corpus grows from P1.12 and P1.13 | it cannot: every E2E deletes its `home` in `afterEach`, so no scripted run ever writes `~/.polish/polish.db`. A replay-set entry is a committed scripted scenario, and such entries are barred from §1's cost arm |
| cassette replay observes calls issued **and prompt footprint** | only calls issued; a replayed response carries the recorded `usage`, which does not move when the prompt does |
| Guard 1's "same six rounds" needs no pair key | replay mints new run ids; the pair key is `(mission hash, task contract, axis, roundIndex)`, and key coverage must be reported |
| §1 needs a cassette-capture item | it does not: the CAS already holds `model_request` and `model_response` for every baseline call (`src/broker/broker.ts:226-269`). Finding 14 stays dropped |
| P2.1 has no input rows | it has 2,600 review executions and no **eligible** ones: all predate finding 41's fix, so their emptiness is discarded parser output |
| an undecidable P3.1 stops P3.2 and P3.3 | it stops neither: P3.2 is void only if P3.1 *drops* `adversarial`, and P3.3 depends on P1.8 and P2.2 |

## 9. Verification process v2

User instruction: one reviewer per task, two at block completion. Our own run records falsify the
strong form, so the economy is kept where the data allows it.

**Per task**

1. Freeze and content-hash the contract in `docs/ledger/<task>.md` before any code.
2. Implement.
3. Coordinator runs the gate. A failure returns to step 2 with no reviewer involvement.
4. Reviewers, each in its own worktree at the commit under review, receiving diff plus frozen
   contract only. **Both lanes review every item, including documentation-only ones.**

### Process v3 — review order and termination. User decision 2026-09-14, supersedes v2 §4–§7.

**The order is fixed, not a matter of scheduling.**

5. **GPT-5.6-sol reviews first.** Always. It is the entry gate.
6. **A finding from GPT is fixed immediately, and GPT reviews again.** Repeat until GPT returns a
   clean verdict. There is **no cap** on this loop.
7. **Grok reviews second, and only on a commit GPT has already passed.** Grok is never run on a
   commit GPT has not cleared.
8. **If Grok finds anything, the fix goes back to step 5.** GPT must clear the fixed commit before
   Grok sees it again. A verdict is only worth what it was given on: a pass on an earlier commit is
   not a pass on this one.
9. **The item is accepted when both lanes have returned clean on the *same* commit.** Not on
   adjacent commits, not one on the code and the other on a predecessor.

**There is no maximum number of reviews.** v2's budget of three, and its `deferred(unconfirmed_fix)`
escape at the fourth, are withdrawn. An item runs until it is clean from both lanes.

**Why the order, and why it is not arbitrary.** Over P1.6–P1.7 the two lanes were run in parallel on
the same commit and the record is lopsided: GPT raised the blocking finding in P1.10 round 1, P1.9
rounds 1 and 2, P1.7 rounds 1 and 2, and P1.3 round 1 — including every defect Grok had passed over in
the same round. Grok passed commits that GPT then failed four separate times. Serialising with GPT
first spends the cheaper, more productive check before the second one, and stops Grok reviewing code
that is already known to need changing.

**Consequence, applied retroactively 2026-09-14.** Under v2's budget, four accepted items ended with
their final commit reviewed by only one lane, because the budget expired or a confirming review was
substituted for a second opinion:

| Item | Accepted at | Lane that never saw the accepted commit |
|---|---|---|
| P1.10 | `44d4256` | **Grok** — its last look was `cfab2d6`, which it failed |
| P1.9 | `485132b` | **GPT** — its last look was `72bc940`, which it failed |
| P1.7 | `0c69901` | **GPT** — its last look was `e3dda5f`, which it failed |
| P1.11 | `8fed854` | **GPT** — v2 assigned one reviewer to a documentation-only item |

Each is re-reviewed by the missing lane under v3, and re-accepted only on a clean verdict. **P1.6 is
not in the table**: both lanes returned clean on `e45aebc` itself, which is what §9 now requires.

**Per block.** Two reviewers of different families, once, against the block contract and G1/G2. Two
clean verdicts accept the block.

**Reviewer rules.** `NONE` is a valid verdict. Blocking is a user-visible behaviour change or an
invariant violation with an accepted reproduction — not file classification, and not a survivable
mutant. Test-strength observations are notes and do not reopen a round.

**Abandonment.** A task ends when a round produces neither a production change nor a
production-relevant finding. Accepted 35+23 already detects this shape.

**The compulsory-axis instruction.** "Name an axis none of these covers" is a **coordinator**
instruction at `docs/ledger/PHASE-C.md:159` and `B-selfhost-8-run.md:191`. It is not in
`src/review/reviewerProtocol.ts` or `protocols/reviewer-*/SKILL.md`, which already permit an empty
findings array. It is deleted from this process document and nowhere else.

**Why not one reviewer everywhere.** `B-selfhost-18-run.md:99-106`: one lane passed while the other
found defects in rounds 5, 7, 9 and 11; twelve of item 18's last thirteen findings came from one lane.

**Why not a hard two-round cap.** Item 18 found production defects in rounds 2 **and** 3.

**Machine load.** Reviewers run one at a time. The coordinator runs no gate while a reviewer works.
Gates use `--maxWorkers=2`, never bare `pnpm check`; `vitest.config.ts` sets `pool: "forks"`.

## 10. Prerequisite checklist — DONE 2026-09-13, no code

1. **DONE.** `docs/ledger/PHASE-C.md` reconciled with `git log`. Added a supersession banner pointing
   here; added `4c5bb63` as the current HOST with its gate result; recorded the intermediate merge
   commits `889b62d`, `34c3cd4`, `4c5bb63`, because the trusted-generations table previously listed
   only candidate-branch commits and the integrated HOST could not be identified from that file;
   replaced the hardcoded reviewer pair with a family-exclusion rule.
   **One claim in revision 5 of this document was wrong:** `889b62d` does *not* appear nowhere in the
   ledger — it is the frozen base cited by `docs/ledger/B-selfhost-35-23.md:3` and
   `B-selfhost-35-23-run.md:7`. What was missing from `PHASE-C.md` was the integrated HOST `4c5bb63`.
2. **BLOCKED — requires the user.** The stale base is in a **Cursor user rule**, not in this
   repository. Every `916f7f2` occurrence in the tree is a legitimate historical record: it is
   B-selfhost-5's acceptance commit (`PHASE-C.md:24`, `B-selfhost-remaining.md:19`,
   `B-selfhost-5-run.md`) and a row in `docs/ledger/task-provenance.md`. There is no tool available
   for editing user rules. The rule text to change is:
   *"Exact base = latest accepted HOST (currently B-selfhost-5 `916f7f2` until superseded)"* →
   **`4c5bb63`**. Better still, replace the pinned hash with *"latest accepted HOST per the
   trusted-generations table in `docs/ledger/PHASE-C.md`"*, so it cannot go stale again. The same rule
   also names an execution order that this document supersedes.
3. **DONE.** Process v2 recorded in `docs/BVP.md` as a section preceding Level 1, with Level 1 marked
   historical, its §6 two-round bound annotated as never honoured (A2 7, A3 7, A6 9, B-selfhost-8 26,
   B-selfhost-18 15), and two new degeneration signals added: commits touching no non-test file while
   findings keep arriving, and test volume out of proportion to the production change.
4. **DONE.** §11 written into `docs/ledger/B-selfhost-remaining.md` as an archival appendix, with the
   finding-31 accepted-risk entry and a short section on the two findings that changed the plan rather
   than the code.

## 11. Disposition of the 45 findings

| Findings | Disposition |
|---|---|
| 3–9, 11, 18, 19, 23, 29, 32, 34, 35, 37, 39, 41–45 | ACCEPTED; historical |
| 10 | ACCEPTED as `B-bootstrap-cost-eligibility` |
| 12 | P1.3 (spend) + P1.7 (settings) |
| 13 | P1.12 |
| 14 | dropped: needs paid provider APIs, forbidden |
| 15 | P1.13 |
| 16 | P1.6 |
| 17, 21, 22, 25 | P1.7 |
| 20, 24 | deferred until after P2 |
| 26 | open, unscheduled. Known weakness: a reviewer-authored claim reaches a worker as unfenced instruction via `task.description`. Closed only by the withdrawn reviewer-reproduction item |
| 27 | P1.10 |
| 28, 30 | P1.9 |
| 31 | P1.11, accepted risk |
| 33, 36, 38, 40 | superseded by measurement; historical |
| **new** | corpus discarded during materialization → P1.8 |

## 12. Out of scope

- Durable-execution products (Temporal, Restate, DBOS, LangGraph): each adds Postgres, a non-MIT
  server, or a second daemon, and none removes the phase machine, the gating logic, or the baseline
  comparison.
- A summariser or compactor: FIFO truncation matches LLM summarisation at every budget except the
  most extreme, and re-compaction compounds the loss.
- A learned progress score: process reward models respond to formatting artifacts and can be driven
  above 0.9 reward at under 4% ground-truth accuracy.
- paperclip as a product.
- Phase D. No widening of Fable's architectural scope.
