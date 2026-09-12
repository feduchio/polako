# Phase C — full v1 (in progress)

Phase B remains **OPEN**. This file does not accept Phase B and does not accept Phase C.

## Collaboration lanes (user decision 2026-09-04)

Independent implementation and review lanes are **Grok / Claude / Polish**.

Composer is **not** used from this decision onward (implementers, blind compare, or adversarial review). Historical Composer C3 artifacts remain in the ledger as evidence already obtained; they are not a reason to launch Composer again.

Clean rounds for remaining C work require fresh **Grok** and **Claude** reviewers, plus Polish verification when HOST can complete it.

## Trusted generations

| Role | Object | Notes |
|---|---|---|
| HOST (immutable during a C task verification run) | tag `phase-b-collab-base` → `0b21a6182507e9883d020ceba0c39aa4edcfff5b` | Used for C3 Polish lane. Phase B not fully accepted. |
| C3 accepted | `0abcf62e8d277481dfb34aa8a047a9c40f4e8c50` on `task/C3-integration` | Task C3 only. Phase C not accepted. Do not tag `phase-c-accepted`. |
| C2 accepted | `7139e9cc2ad8a58e35a5b1535941eddbf4c25f13` on `task/C2-integration` | Task C2 only. B-8 remains OPEN. Phase C not accepted. Do not tag `phase-c-accepted`. |
| C4 accepted | `4fae1473f5dd5430f58d613ad7c90beed1128cf9` on `task/C4-integration` | Task C4 only. B-4/B-8/B-11 remain OPEN. Phase C not accepted. Do not tag `phase-c-accepted`. |
| C8 accepted | `311203830720a4d1e917785e577eaf868281bc8a` on `task/C8-integration` | Task C8 only. |
| B-selfhost-4 accepted | `84f2f7ef55f4d97e7936b5e7d775bba358f60c90` on `task/B-selfhost-4-integration` | Bounded B finding 4 only. |
| B-selfhost-3 accepted | `fd8a99c402656f7fe3aa6dc02377cc76713ab411` on `task/B-selfhost-3-integration` | Bounded B finding 3 only. |
| B-selfhost-5 accepted | `916f7f26df1b7490d35289781a4e799d7cd8e7ed` on `task/B-selfhost-5-integration` | Bounded B finding 5 only. |
| B-selfhost-6 accepted | `df49a5ef75996da5ee17c51b4f66e974d8952fc0` on `task/B-selfhost-6-integration` | Bounded B finding 6 only. |
| B-selfhost-7 accepted | `1dc1c5cfbb2f92efb2fa8f58f15e92f02a3c80b2` on `task/B-selfhost-7-integration` | Bounded B finding 7 only. |
| B-selfhost-8 accepted | `14beb802857fde8a5251404dc518301cb5b1a0a4` on `task/B-selfhost-8-integration` | Bounded B finding 8 only. |
| B-selfhost-9+19 accepted (next HOST) | `9e157e1a0a5d7369f2be905d8c36121789e09087` on `task/B-selfhost-9-19-integration` | Bounded B findings 9 and 19, plus finding 23's reviewer half. Phase B not fully closed. Phase C not accepted. |
| Production `main` | `8d23cfd75d009daf0ad19285cc850f5ec25632e0` | Merge of HOST + untrusted `archive/post-a-wip` C/D donor files. **Not** an accepted C checkpoint. |
| Development branch | `phase-c-collab` | Branched from HOST, not from `main`'s donor overlay. |
| TARGET | per-task worktrees from the frozen task-contract commit | Must not be the HOST checkout. |

Historical `docs/ledger/C1.md`–`C11.md` / `C-audit.md` on `main` / `archive/post-a-wip` are **HISTORICAL / SUPERSEDED / NOT ACCEPTANCE EVIDENCE**.

Donor C/D files that exist only on `main` (pathology, debate, audition, native CodeGraph, scouts, `sandbox-exec`, doctor/gc, heuristic `sidecars/llm_verifier/main.py`, …) may be inspected against the **current** contract and ported selectively. They are not trusted HOST capabilities.

## Remaining Phase-B findings (still OPEN)

Source of truth: `docs/ledger/B-selfhost-remaining.md`. Not deferred, not optional, not relabeled as C.

Open items: **11–15**, plus **16, 17, 21, 22, 24, 25** scheduled into the items that rework the same code, **23**'s detector half in its own slot, and **26, 27** recorded. Items **3–9** and **19** ACCEPTED.

Item 10 (`listModels()[0]` reviewer selection) was lifted into `B-bootstrap-cost-eligibility` (ACCEPTED). Full Phase-B self-host closure remains **DEFERRED_BY_USER**.

## Dependency analysis (Fable §17 Phase C vs current tree)

Fable Phase C tasks and actual dependencies on accepted A/B plus open B defects:

| Task | Fable | Depends on | Open B touch? | Notes |
|---|---|---|---|---|
| **C3** VerifierAdapter / llm-verifier sidecar | §17 C3; §0 sidecar; topology Tournament→sidecar | B3 tournament, B9 `COMPARING` driver, config `verifier.*` | **Touches B-11** (production `new PairwiseJudge()` with no provider). Does not depend on B-11 being fixed first: tournament already functions; C3 adds sidecar as primary judge. B-11 stays OPEN on the TS fallback unless a later task injects a provider. | First task. |
| **C2** Pathology / budget engine | §17 C2 | B6 convergence | Touches B-8 (budget overrides unused / hard caps). Not a C2 prerequisite: B-8 is Option A hard caps on CLI budget, not pathology. Record if C2 edits budget code. | Second. |
| **C4** Prosecutor/Defender/Judge | §17 C4 | B5 finding validator | No MISSION_CRITICAL B blocker. | Third. |
| **C8** Model observations / AuditionStrategy | §17 C8; A12.9 | A8 broker observations | No MISSION_CRITICAL B blocker. | Fourth. |
| *pause* | — | trusted C3/C2/C4/C8 HOST | Use stronger Polish to close remaining **bounded** B findings one-by-one. | User-authorized. |
| **C1** Simplification pass | §17 C1 | B6; FSM `SIMPLIFYING` already exists | No. | After pause. |
| **C5** CodeGraph native | §17 C5 | A10 intel probe | No. | |
| **C6** Cursor/MCP UX, answer flow | §17 C6 | B9 daemon/MCP; B-bootstrap UX | Touches B-13 (NEEDS_HUMAN/STOP-RESUME through daemon) if answer flow is wired. Treat as bounded B prerequisite only if C6 cannot meet contract without it. | |
| **C7** Scouts | §17 C7 | A7 discovery | No. | |
| **C9** Hardening, `polish gc`, `polish doctor` | §17 C9 | B9 CLI | Touches B-12 (crash recovery incomplete). Do not claim B-12 closed by C9 GC/doctor. | |
| **C10** `SandboxExecSandbox` | §17 C10 | A6 sandbox interface | No. | |
| **C11** Runtime expansion | §17 C11 | B12 runtime v1 | **Touches B-6, B-15** (runtime evidence path / required happy path). Those become bounded B prerequisites before C11, not silently absorbed. | Last. |

No C task depends on another C task except that later tasks may **use** an independently accepted earlier C capability as trusted HOST infrastructure. C3 must not self-verify.

## Proposed execution order

Recorded before implementation. User authorized reordering within Phase C for bootstrapping.

1. **C3** — verification multiplier; no C dependency; B3 exists.
2. **C2** — safe long-running autonomy.
3. **C4** — UNCERTAIN-finding arbitration.
4. **C8** — model observations / audition scope from the original plan.
5. **Pause** — bounded remaining B findings, one-by-one, using the stronger HOST. Order revised 2026-09-10 to **7 → 8 → 9 + 19 → 18 → 11 → 12 → 13, 15 → 14 → 20**; rationale in *Prompt-path ordering constraints* below.
6. Remaining Fable C: C1, C5, C6, C7, C9, C10, C11 in dependency order as above, with **C1 after finding 18** (the simplification pass drives workers) and **C7 after finding 19** (a `scout` role needs composed protocols; `scout` and `evidence` are declared in `ModelRole` and `roleToActorKind` but `router.select({ role: "scout" })` has no production caller).

Do not invent C scope outside Fable §17 Phase C. Do not enter Phase D. Do not tag `phase-c-accepted` while unresolved MISSION_CRITICAL B defects can invalidate C guarantees, unless the user explicitly defers them at the release boundary.

## Prompt-path ordering constraints (recorded 2026-09-10)

Findings 18–20 in `docs/ledger/B-selfhost-remaining.md` are scheduled into the pause block rather than left unscheduled, because two of them change the exact bytes of every worker LLM request and therefore collide with items already in the authorized sequence. This section records the collision, not new scope beyond those findings.

**Hard constraint — item 14 runs last.** `RecordReplayProvider.requestKey` hashes `messages` together with `model`, `tools`, `responseFormat`, `maxTokens` and `temperature` (`src/providers/recordReplay.ts:32-41`), and a replay miss raises `not_found` (`:56`). Item 14 records those cassettes with **real paid providers**. Finding 19 adds a system prompt and a composed context pack to `messages`; finding 18 replaces the appended transcript outright and changes the per-call `maxTokens`. Either landing after item 14 invalidates every recorded response and forces a second paid recording pass. Item 14 therefore runs after both, as the last implementation item of the B block.

**Soft constraints.**

- **19 before 11.** Superseded in detail, kept in order (2026-09-12): finding 19 does *not* compose the `judge` role — `compose()` requires a role and none of the eleven role protocols applies to a worker, so the worker seam attaches no role at all, and item 11 composes `judge` itself. The ordering still holds for a weaker reason: 11 should not author a judge prompt from scratch while 19 establishes how protocols are loaded and mapped.
- **19 alongside 9.** Both edit `createWorkerFactory` (`src/daemon/composition.ts:441-459`).
- **C7 is not purely additive over finding 19** (recorded 2026-09-11). The existing ordering already puts C7 after 19 because a `scout` role needs composed protocols, but there is no `scout` protocol under `protocols/` and, more to the point, `ProtocolAppliesToSchema` has no `scout` member (`src/protocols/types.ts:3-9`: `worker | reviewer | evidence | defender | supervisor`). Authoring one therefore widens the frontmatter schema and everything validating against it, which is C7's cost to carry rather than finding 19's. Finding 19 should not widen the enum speculatively.
- **18 before 13 and 15.** `ScriptedProvider` is a FIFO queue per model (`src/providers/scripted.ts:38-57`), insensitive to prompt text but sensitive to call count and order, and finding 18 changes the worker loop's turn profile.
- **18 before 20.** Auditioning models against a worker loop that is about to be replaced discards the observations.
- **8 keeps its position, but must not be calibrated to current behavior.** Item 8 wires the unused `applyRunBudgetOverrides` and Option A hard caps. The plumbing is independent of finding 18, but any cap *value* chosen against today's quadratic consumption becomes wrong once the prompt footprint is bounded. Choose caps that hold in both regimes, or defer the numbers until after 18.

Findings 18 and 19 require frozen contracts on the established pattern — Grok + Claude review of the draft, then 2 clean Grok + Claude rounds on the final commit — before implementation.

The measurement prerequisite for finding 18 is **satisfied** (2026-09-10, figures recorded in the finding): 66.9% mean resent history, 14.2 mean turns against `agent.maxTurns` = 32, 3 of 6 loops `BUDGET_EXCEEDED`. Two consequences bind its contract. First, the measured gain is conditional — a flat prompt projects to 2.3× the turns at zero state overhead but **0.9×, a regression, at a 1,500-token state block**, so the contract MUST impose an explicit token cap on the execution-state schema and pin it with a test; a schema budget is an acceptance criterion, not an implementation detail. Second, the sample is thin (N=6, one fixture, two small free models) and item 14 — which would produce better data — is now sequenced after 18. The contract must therefore assert **invariants** (prompt footprint independent of turn index; state size within its cap; a rejected patch rolls back without corrupting state) rather than absolute token or turn targets, so that acceptance does not depend on the thin sample.

Evaluated and rejected as sources of new scope: LiveBench (`github.com/livebench/livebench`) — see finding 20; `spotify/portal-ai-plugins` — a Backstage-catalog plugin marketplace for third-party coding agents, whose only transferable idea (the `shunt` plugin's delegation of I/O-heavy work to cheap worker models) is already the intent of the existing `scout` / `evidence` roles and Fable C7.

## First task

C3. Contract: `docs/ledger/C3.md`. Provenance: `docs/ledger/C3-run.md`. **Task ACCEPTED** at `0abcf62e8d277481dfb34aa8a047a9c40f4e8c50`.

C2. Contract: `docs/ledger/C2.md`. Provenance: `docs/ledger/C2-run.md`. **Task ACCEPTED** at `7139e9cc2ad8a58e35a5b1535941eddbf4c25f13`.

C4. Contract: `docs/ledger/C4.md`. Provenance: `docs/ledger/C4-run.md`. **Task ACCEPTED** at `4fae1473f5dd5430f58d613ad7c90beed1128cf9`.

C8. Contract: `docs/ledger/C8.md`. Provenance: `docs/ledger/C8-run.md`. **Task ACCEPTED** at `311203830720a4d1e917785e577eaf868281bc8a`.

**Pause (user-authorized, full remaining plan):** B-selfhost-3/4/5/6/7/8 ACCEPTED (`fd8a99c` / `84f2f7e` / `916f7f2` / `df49a5e` / `1dc1c5c` / `14beb80`). Remaining sequence, with the previously unscheduled findings attached to the items that already rewrite the same code:

| # | Item | Absorbs | Shared seam |
|---|---|---|---|
| ~~1~~ | ~~**9 + 19**~~ | ~~23's reviewer-protocol half~~ | **ACCEPTED** at `9e157e1`, run record `docs/ledger/B-selfhost-9-19-run.md` |
| 2 | **18** | — | `AgentRunner.runLoop` |
| 3 | **11** | — | `PairwiseJudge`; needs 19's composed `judge` protocol first |
| 4 | **12** | **17, 21, 22, 25** | `DaemonService.runConfig` and `withRuntimeValidationMode`: 12 restores run settings and runtime mode across a restart, 17 is the mode nobody reads, 21 is that resolution failing silently, 22 is the pin guarding it, 25 is the duplicated budget merge in the same function |
| 5 | **13, 15** | **16** | Runtime evidence: 15 drives the `required` happy path, 16 is the missing `off` early return in `corpusRuntimeEvidenceAllowsDone` |
| 6 | **23** (detector half) | — | `src/convergence/pathology/{types,sample,detectors}.ts`; needs a per-checkpoint production-versus-test classification on the sample, which no other item adds |
| 7 | **14** | — | Real paid providers; must stay last, since 18 and 19 change the bytes every cassette hashes |
| 8 | **20** | **24** | The probe path: 20 wires the audition producer, which is what issues probes, and 24 is those probes reaching the provider without passing the budget guard |

Then the remaining Fable C: C1, C5, C6, C7, C9, C10, C11 in the dependency order above.

The grouping rule is one seam, one rewrite. Five of the seven loose findings sat in code that a scheduled item already reopens; taking them separately would mean touching `DaemonService.runConfig` five times and re-freezing a contract for each. Only 23's detector half has no collision, so it keeps its own slot rather than being forced into one. Do not enter Phase D. Do not tag `phase-c-accepted`.

Reviewer isolation: from item 8 onward each code reviewer gets its own worktree at the commit under review. Reviewers mutate sources to test assertion strength and restore them with `git checkout --`, so sharing one worktree lets them overwrite each other's probes. See the process note in `docs/ledger/B-selfhost-7-run.md`.

## Stopping rule for review rounds (revised 2026-09-11, after B-selfhost-8 reached 24 rounds)

B-selfhost-8 changed production code in three commits, all within its first three rounds: `+109/−20` lines. It then ran twenty-four more rounds and twenty-four more commits, none of which touched a non-test file, and neither reviewer reported a production defect in any of them. The task did not fail to converge by accident; the rule it was run under has no fixed point.

**Why.** "A survivable mutant is blocking" is unsatisfiable for any finite suite. For any set of checks there exists an incorrect implementation conditioned on some combination of ambient state the fixtures do not vary — the configured polarity of a dimension the mutant does not touch, the runtime mode a helper defaults to, whether the provider is priced, whether the run was created or recovered. Each round closes one such combination and creates the next. The coordinator's own round instruction — *"name an axis none of these covers and sweep it; do not claim the space is closed unless you can defend that claim"* — makes a finding mandatory, since there is always another axis and a reviewer returning PASS under that instruction looks like it did not try.

**What the findings drifted into.** Rounds 1–3 found production defects. Rounds 4–8 found genuine vacuity — assertions comparing `null` to `null`, which proved nothing. Rounds 9–19 found real coverage gaps of decreasing severity. Rounds 20–23 found mutants that must read state they have no reason to read in order to be wrong: truncate a USD override *only when the token cap is finite*; skip the merge *only when the runtime mode is* `auto`; answer every recovered run with the first budget resolved. No implementer writes those while trying to do the right thing. They are tests of the tests.

**The revised rule.** Acceptance is judged against the frozen contract, which is finite and therefore terminates.

- A round is **clean** when both reviewers confirm every MC and AC holds with cited evidence, report no class-(a) production behaviour defect, and report no class-(c) contract clause that no check observes.
- A class-(b) survivable mutant is **blocking only if it is plausible**: an omission or a simplification a competent implementer could write while trying to satisfy the contract — a forgotten dimension, the shared object used instead of the per-run one, a cache keyed globally. A mutant that must branch on state unrelated to what it changes is recorded as a test-strength note and does **not** reopen the round.
- Reviewers are **not** asked to name a new axis. They are asked to verify the contract, to look for production defects, and to name clauses no check observes.
- Two clean rounds accept the item. A round yielding only implausible class-(b) mutants still counts as clean.

Test volume is a cost, not only reviewer time: B-selfhost-8's budget test file reached 955 lines against a 109-line production change, and several of its checks pin the same clause more than once. Future work on that seam has to carry all of it.

**Machine load (user decision 2026-09-11, after a stall).** Reviewers run **one at a time**, not two in parallel, and the coordinator runs **no gate of its own while a reviewer is working** — the reviewers already reproduce the gates independently, so a third concurrent suite is redundant as well as costly. `vitest.config.ts` sets `pool: "forks"`, which defaults to one fork per core, so every gate run is capped: use `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm vitest run --maxWorkers=2` instead of `pnpm check`, and pass `--maxWorkers=2` to single-file mutation probes too. Three uncapped suites at once made the machine unusable.

**Shell hygiene, same incident.** Never pipe a heredoc into a command's stdin (`git commit -F -` holds the session's stdin open and every later command queues behind it); write the message to a file and add `< /dev/null`. Never `kill -9` a PID reported by the tooling — it can be the shell session leader. Never leave `set -x` on in a persistent session.
