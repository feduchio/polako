# Council round 3 — the test suite, dead code, and the six failures it did not catch

**Date:** 2026-09-15 (GPT, Grok), 2026-09-25 (Claude, after two restarts lost to a usage limit).
**Base:** GPT and Grok read HOST `6b90bb4`; Claude read `765523d` (one test added, +42 test lines).
**Lanes:** GPT-5.6-sol, Grok-4.6, Claude Opus 5.5. Identical prompt, independent, read-only; mutants
only in `/tmp` copies. Reports in `/Users/fedorsvetlov/polish-worktrees/analysis/`
(`gpt-round3.md`, `grok-round3.md`, `claude-round3.md`). Host after all three: `765523d`, clean.

The question, from the owner: the suite is bigger than the product and does not protect the real
business cases, spinning idle included; cut it, and cut dead code after establishing why it was
added. The goal is unchanged: a real project and a real mission driven to a verified result.

## Verdict — all three lanes agree

**The ratio is not the problem; what the suite observes is.** Of the six operating failures, four
are properties of a running system (report livelock, tracker silently absent, worker never
finishing, review producing nothing) and no test of that class exists. The other two (worker
worktree without `node_modules`, deletable guards) are ordinary coverage holes inside existing
classes. Every lane computed that deleting lines without changing the class barely moves 1.14.

The missing asset is **fixtures with dependencies and run-level scenarios**, not more unit tests.
The only mission fixture, `fixtures/resume-dup-fetch`, declares no dependencies; failure 2 was
invisible on it for eleven days and cannot be reproduced there.

## Numbers, reconciled

| | Value | Source |
|---|---|---|
| Production lines | 33,386 | all three |
| Test lines | 37,953 at `6b90bb4`, 37,995 at `765523d` | all three |
| Gate | 96 files, 1,165 tests (`6b90bb4`), 1,166 (`765523d`) | all three |
| Spend | $0.140690903, a floor: 142 calls unpriced | GPT, Grok |
| Runs | 25; DONE 2, both `/tmp/polish-smoke`; 0 DONE outside `/tmp` | GPT, Grok |
| `findings` / `finding_validations` | 0 / 0 | all three |
| `KNOWN_EVENT_TYPES` | 70; 38 emitted, 32 never | all three |
| Never-emitted **and** no production emitter | 3: `checkpoint.rolled_back`, `shell.command`, `budget.updated` | GPT; coordinator re-grepped. Claude's "1" is an undercount |
| Emitted but not registered | `review.axis_exhausted` (`reviewDrivers.ts:1151-1157`) | GPT |
| Repeated worker turns in `run_01m2hfb2…` | 66/153 by `(tool,args)`; 47–48 by content+tools; 76–85 by other conventions | GPT, Claude — same conclusion |

The other 29 never-emitted types have production emitters whose conditions never occurred.
**Never-emitted is not dead.**

## New evidence this round, verified by the coordinator

1. **Fix 2 opened a new route to failure 4 (Claude).** In `run_01m2jc020mfwk8qfp2gkdy`, three of
   17 worker calls carried 34,650 / 34,688 / 34,717 input tokens; the other fourteen carried
   1,355–1,834. The three account for **104,055 of 128,508 tokens (81%)**. Each followed
   `list {"recursive":true}` over a checkout that now has `node_modules`. `listEntries`
   (`src/agents/tools.ts:184-196`) caps entries at 2,000, not tokens, and skips neither
   `node_modules` nor `.git`. Only a run could have shown this interaction.
2. **The terminal label is false and pinned (Claude).** `candidateDrivers.ts:709` sets
   `providers_unavailable` whenever `judged.length === 0`. jc02's own summary says
   `0 were refused … 1 ended otherwise (BUDGET_EXCEEDED)`. Seven tests hold the wrong label.
3. **"Finish without evidence" is not protected (Claude, M04).** `agents.test.ts:71` uses
   `codingTask`, so the first `finish` is rejected by the empty-diff guard; `toContain("finish
   rejected")` matches both messages. Disabling `hasLoopEvidence` at `runner.ts:258` leaves the
   suite green. For a task that does not touch product code the worker can finish having done
   nothing — the founding principle's exact failure.

## Mutants

| Lane | Sample | Killed | Weakest |
|---|---|---|---|
| GPT | 10 targeted | 2 (20%) | `councilDrivers` R4 re-read, `reviewDrivers:786-791` canary, `selectProgressModels` routing, pathology strategy/sample |
| Grok | 9 targeted | 4 | R4 re-read, canary `:789`, R0a latch/identity individually, `prepareWorkerCheckout` body reporting "disabled" |
| Claude | 38 on failure paths | 27 (75% excl. 2 equivalent) | worker loop 2/5; pid write order (M02), digest dedup (M07), `list` cap (M08), R4 re-read (M09), skip-count silencing (M28), `comparePair` quorum (M31), `FINDING_TABLE` (M25) |

Survivors found by more than one lane: **R4 post-await re-read** (all three), **R2 canary branch**
(GPT, Grok). Pure contracts (broker, domain, pathology fold) kill at ~100%. `project.test.ts`
largely earns its size, but misses M28 — the detector for a failing test turned green by skipping.

## Dead code — archaeology

Unanimous:

| Target | Prod | Verdict |
|---|---|---|
| `FactsService` (`context/facts.ts`, A11 `93cf01e`) | 187 | Delete; ADR-0001 note. Born unreachable; `workerInstruction.ts:60` hard-codes `facts: []` |
| `buildSupervisorView` (A11) | 72 | Delete |
| `CleanRoundTracker` (B6 `7898c2a`) | ~60 | Delete the class; keep `preferRotatedEnsemble` |
| `executionEvidenceIsSufficient` (`5e5e412`) | 9 | Delete |
| `protocols/typescript`, `react-native` SKILLs (A9) | 34 md | Delete content; keep the composer's domain slot |
| Unread config (`rotateEnsembles`, `freshWorkerAttempts`, `escalateTierFromAttempt`, `workerPackFraction`, `supervisorViewFraction`, `empiricalPivots`, `sandbox.backend`) | ~20–40 | Delete |
| `RepositoryIntelligence` + `BasicIntel` | — | **Keep: ADR-0001 seam, live** |
| `convergence/pathology/` (C2) | 1,538 | **Keep.** Wired (`convergenceDrivers.ts`), never reached. "Half dead" refuted: two unused symbols |
| Debate under `findings/` (C4) | 285 | **Keep.** Live at `reviewDrivers.ts:291-296`; unexercised because no finding ever existed |

Split:

| Target | GPT | Grok | Claude | Resolution |
|---|---|---|---|---|
| `codegraphCli.ts` + `composite.ts` | delete backends | keep as seam | delete backends | 2:1 delete; interface stays |
| `intel/probe.ts` (393) | not counted | keep | delete with backends | Goes with the backends if they go |
| `verify/sidecar.ts` (~600 + Python) | keep (C3 accepted) | keep | decide, leaning delete: every `candidate.compared` is `empirical` | **Owner decides** |
| `ProtocolRegistry.readResource` | decide | decide | delete | Owner decides; default delete |
| `mcp/index.ts` (72, no tests, not in `bin`) | — | — | decide: `bin` + smoke test, or delete | Owner decides |
| `sandbox/outputCompressor.ts` (A6 `36bf7b3`) | — | — | **wire it**: built for the failure jc02 shows | Wire as the tool-output bound |
| `buildFacadeReportInput` (67, 0 callers, 0 tests), `EventLog.causalChain`, ~290 lines of test-only exports | — | — | delete | Delete; test doubles in `src/` move to test helpers |

Archaeology changed four verdicts: pathology and debate from dead to live-but-unexercised; the
CodeGraph classes are orphans behind a live seam; `outputCompressor` from orphan to wire-it; the
progress tracker from "switched itself off" to "off by design" — `B-selfhost-35-23.md` AC3
required free models and a test pinned that precondition, which R0 then violated.

Production deletion: Grok ~350 (seams kept) to ~800; GPT ~830; Claude ~1,500 (adds `probe.ts`,
test-only exports, `buildFacadeReportInput`, `causalChain`); up to ~2,300 if every decide row goes.

## Net plan — where the lanes differ

| | GPT | Grok | Claude |
|---|---|---|---|
| Tests removed | −6,200 | −3,000 … −8,000 | −2,960, only behind a mutant sweep |
| Tests added | +900 | +400 … +800 | +1,150 |
| Resulting ratio | 1.00 | 0.6–0.8 | 1.13 |
| Scenarios × fixtures | 10–12 × 3 | 8–12 × 3 | 6 × 3 |

Claude's caution is the binding constraint: no lane computed a per-test kill matrix, so every
consolidation figure is an estimate. Thin a module only when a mutant sweep of it still kills the
same mutants afterwards.

Target scenarios (union, deduplicated), each running the real daemon loop to termination and
asserting termination within N ticks, tokens under the cap, a truthful terminal code, and a record
of which safety mechanisms are active:

1. happy path on a dependency-bearing fixture (worker runs `npm test` in its own worktree);
2. worker repeats itself and never finishes (replay `run_01m2hfb2…`);
3. tool-output flood (replay `run_01m2jc02…`);
4. reviewer 429 forever;
5. reviewer returns only shape-invalid output, then a normalizable finding reaches `findings`;
6. catalogue with no free strict models — tracker absence must be recorded.

Claude's addition, adopted: drive scenarios from **replayed real transcripts**. The store holds
1,606 recorded calls; replay costs $0.

Fixtures: (a) `resume-dup-fetch` as is; (b) small TS + vitest with a committed lockfile, installable
offline; (c) a mission whose correct outcome is "nothing to change", to test that DONE without a
diff is judged truthfully.

## First action — three answers, one order

GPT: the dependency-bearing vertical E2E (highest leverage) and a deterministic repetition breaker
(highest safety per line). Grok: digest carries tool results, tracker never silently null, stop
identical turns. Claude: bound tool output in tokens and skip `node_modules`/`.git` — jc02 burned
81% of its tokens on three listings.

They are not in conflict; they are one worker-loop change. Order adopted:

1. **Worker loop bounds** (product, ~150 lines): tool results capped in tokens (wire
   `outputCompressor` or replace it); `list`/`search` skip `node_modules` and `.git`; digest carries
   a bounded result summary; deterministic breaker on repeated `(tool, args, resultHash)` with an
   unchanged diff; fix the label at `candidateDrivers.ts:709` and the tests pinning it.
2. **Fixture (b) and the scenario harness with transcript replay**; first scenarios replay jc02
   and hfb2.
3. **Negative tests for the survivors**: M04, M28, M31, R4 re-read, R2 canary, M25, M02, M08
   (~150 lines).
4. **Mechanism manifest at run start** (progress tracker first: routing-aware selection or a
   recorded `unavailable`), tick-duration watchdog event, pid/socket liveness (R9).
5. **Delete the unanimous orphans** in one commit with an ADR-0001 note; register
   `review.axis_exhausted`; drop the three emitter-less event types; merge the duplicate `RunHead`.
6. **Owner decisions**: sidecar, MCP facade, `readResource`, FSM tables.
7. **Consolidate tests module by module**, each behind a mutant sweep. A mutation routine on the
   `if (` lines a commit touches replaces the manual per-commit mutant.

## What no lane checked

A per-test kill matrix; a live review round after the transport fixes; a multi-hour daemon soak;
external user configs before removing config fields; type-checking of mutants.
