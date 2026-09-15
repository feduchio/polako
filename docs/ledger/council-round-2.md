# Council round 2 — audit of the recovery pass, and what it changed

**Date:** 2026-09-15. **Base:** HOST `b08511f`. **Lanes:** GPT-5.6-sol, Grok-4.6, Claude Opus 5,
identical prompt, independent, read-only. Reports in `/Users/fedorsvetlov/polish-worktrees/analysis/`
(`gpt-round2.md`, `grok-round2.md`, `claude-round2.md`).

## What the pass got right, on evidence

Transport on the worker lane is clean: **153 of 153 calls succeeded**, against 2,465 of 2,600 review
executions that previously never reached a model. A stopped run names its reason (R3, verified live).
Five of six landed items are observable — Claude killed 38 of 44 mutants it tried.

## What it got wrong, and every lane found it independently

**§1.2 is not "confirmed gone".** The historical failure lived in `review_executions`; the review
lane did not execute once during the pass. Decisive number: reviewer tokens are **834,635 — byte for
byte the pre-pass figure**, and reviewer calls after the pass began are **0**. The pass verified a
path that never failed and called it confirmation of the path that did. That is its own §4 rule 2.

**§1.3's ruling rests on a denominator it declares invalid.** `R6-run.md:53-57` says every reviewer
call ever made was free and the reading must be redone on paid reviewers — then rules on it anyway.
`costUsd` is null for **494 of 1,563** calls, concentrated in the roles reported as "0% of dollars".
The ruling (keep the programme suspended) is right; the reasoning is not.

**Its own numbers are understated.** Not 12 candidates / 148 calls / 492,632 tokens but **14 / 153 /
497,934**; 23 commits, not 22. The ledger was taken while two workers were still running.

**The ceiling was breached by five of six code items, not four**, worst by 448 lines, and the
overflow was renamed into new items R1a, R1b, R1c rather than stopping anything.

## Why the worker did not finish — answered from the store, not reasoned about

`finish` was called **0 times across all 14 candidates**; 152 of 153 responses ended in `tool_calls`.
Sixty-seven of 153 turns were byte-identical to an earlier turn. Claude read four separate
generations from the CAS differing only in id, carrying the identical tool call
`search {"query":"commit duration","path":"src/campaign/"}`, each returning `matches: []`.

`buildWireWindow` (`loopWindow.ts:280`) hands the model the last turn plus a 400-token digest that
**deduplicates tool calls and carries no tool results**, so eleven turns collapse to
`Tools: search "commit duration"; list .` — the model is told it searched once and is never told the
search returned nothing. The bounded pack is therefore the cause of the repetition, not a defence
against it. Context growth is a consequence, not the driver: `r(turn, inputTokens) = −0.08`,
`r(previous tool-result size, inputTokens) = +0.98`.

**Two candidates were converging and died of something else.** `0231c1283203` patched at turn 4,
wrote a test at turn 5, ran `npm run test` at turn 8 and got
`ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'` — **its worktree has no `node_modules`**. The
failing output came back verbatim: 49,163 characters, 92.3% of the next prompt, 19,492 input tokens,
$0.0056 for one turn. R7 as contracted would have lost both: a repetition detector does not fire on
a candidate that is not repeating.

**The cause was written down a day earlier and filed as non-blocking.** `F54-run.md:293`: *"Worker
worktrees are not prepared. A candidate worker's own worktree is a fourth sandbox, and it gets no
`node_modules`"*, with `tsx` named separately at `:215`. F54 ran 14 rounds and 11 contract revisions.

## The loop-breaker exists and was switched off

`EmpiricalProgressTracker` is wired and on by default, and produced **zero** `worker.progress_*`
events against 14 `worker.started`. `selectProgressModels` (`composition.ts:909-915`) requires
`supportsStrictProgressSchema` **and `inputCostPerM === 0`**; `createProgressTracker` (`:864-870`)
returns `null` unless exactly two models of different families are selected, and `score` refuses
again on `hasTwoFamilies` (`progressTracker.ts:41`).

Exactly two models in this store ever reported `supported: true` —
`nex-agi/nex-n2.5-mini:free` and `openrouter/auto-beta`. R0 moved routing to a paid ceiling; the
hardcoded zero-cost filter then rejected `auto-beta`, one model remained, and the tracker turned
itself off silently. **Third instance of one archetype**, after `QuotaTracker.rpm` passed `null` and
`ModelBroker.restore` with no caller. This one was created by the recovery pass itself.

Relaxing the filter is not the repair: `auto-beta` is a variable-price route R0 blocked for billing
$0.003825 on 745 probe tokens, and progress scoring runs every turn. Weakening `hasTwoFamilies` is
worse — it makes a single model's judgement terminal, which is the founding principle inverted.

## Concurrency is a run-level defect; R4 fixed one symptom

R4's guard fired as designed (`planning.decompose_claimed` seq 125, `released` 167,
`discarded` 168) and one task set exists. The council still ran twice. And the same concurrency
produced two consequences nobody contracted for, both read from the event log of
`run_01m2hfb2mnmvd10384k320`: attempts **regressed** — `RUNNING attempts: 2` at seq 269, then
`GATED attempts: 1` at seq 369, so attempt 2 ran twice — and a stale writer appended
`GATED attempts: 2` at seq **691**, after the task reached `BLOCKED` at 662 and the run had
terminated. GPT and Claude independently produced a green-suite mutant on R4's own guard
(`councilDrivers.ts:257` removed, 96 files and 1,163 tests still pass).

## `REVIEWING` is unreachable without an integrated candidate

`reviewDrivers.ts:116-117` returns `waiting` when the current hash has no `checkpoints` row, and
checkpoints are minted only on the integration path. Store: `baselines` 24, `checkpoints` 5, and
**0 for R5**. So "just run until review happens" cannot work; a candidate has to survive gates first.

## The daemon was not dead — it was in livelock, for 28 hours

`polish.pid` named 99337, a corpse. Live process **75227**: 1 day 4 hours elapsed, **1,327 minutes of
CPU at 102.8%**, still writing. `service.tick` offered every terminal run to `writeReport`
unconditionally on every tick, and rendering one reads its whole history — one run in this store
holds 2,432 review executions. Report mtimes matched the wall clock to the second. Killed with
SIGTERM 2026-09-15 12:50; the WAL checkpointed cleanly into `polish.db`.

## Changes made in this session

| Change | Where | Observed by |
|---|---|---|
| A terminal run's report is rebuilt only when the run or its report artifact moves | `service.ts` `writeReport` | `b10-daemon.test.ts` "report once, not on every tick"; mutant killed |
| A worker's checkout is prepared, and the result reported, before the worker is handed it | `candidates.ts` `prepareWorkerCheckout` | `candidates.integration.test.ts` "prepared, and reported, before the worker starts"; mutant killed |
| The pid file is claimed only after the process owns the socket | `main.ts` | **not observed** — see R9 |
| `maxTaskTokens` 96,000; `candidates.normal` 1; `retry.maxAttempts` 2 | `~/.polish/polish.toml` | config |
| Ceiling rule withdrawn as failed; two rules added | `docs/RECOVERY.md` §4 | — |

Gate: 96 files, **1,165 tests**, exit 0.

## New items, each from an observed failure

- **R8 — a worker that repeats itself is stopped without asking a model.** 67 of 153 turns were
  byte-identical. A deterministic stop on a repeated `(tool, arguments)` pair costs no tokens and
  needs no second family, so it is not subject to the two-family rule that silenced the tracker.
  Must also truncate a tool result and carry results, not just call names, into the digest —
  `loopWindow.ts:159-162` is what hid the empty searches. Supersedes R7 as contracted.
- **R9 — one daemon at a time, and the pid file must not name a corpse.** `RpcServer.listen`
  unlinks the socket before binding (`rpc.ts:18`), so a second daemon steals it from a live one and
  the first becomes unreachable while still ticking. This is how 75227 survived unreachable for 28
  hours. The pid ordering fixed in this session is necessary and not sufficient.
- **R10 — task ownership is not atomic.** Attempts regressed and a writer appended after terminal.
  Needs a fencing token, not a second read at one call site.

R7 is withdrawn in its contracted form: its premise, that the worker has no detector, is false.
