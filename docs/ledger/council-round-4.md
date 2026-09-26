# Council round 4 — honest verdicts and an autonomous run on a real project

**Date:** 2026-09-26. **Base:** `phase-c-collab` at `1aa1cc1`, clean.
**Lanes:** Claude Opus 5.5, GPT-5.6-sol, Muse Spark 1.3. Identical prompt
(`polish-worktrees/analysis/round4-prompt.md`), independent, read-only; experiments only in `/tmp`
copies; DB read with `?mode=ro`; no live runs, no paid calls. Reports in
`/Users/fedorsvetlov/polish-worktrees/analysis/` (`claude-round4.md`, `gpt-round4.md`,
`muse-round4.md`).

The owner's question: what stands between Polish and deciding on its own, honestly — every verdict
backed by what actually executed, and saying so when nothing did.

## Verdict — all three lanes agree

**Polish records verdicts it did not earn, in both directions.** The investigation's skeleton is
right (fresh checkout at the finding's hash, only added files, the engine runs the command, a full
event log), but `classifyReproduction` decides from the exit code alone. A non-zero exit is taken as
"defect demonstrated" and a zero exit as "defect refuted", whether or not the reproduction ran and
whether or not its failure has anything to do with the claim. Debate adds a third route: a judge's
VALID plus any one earlier artifact creates a fix task with nothing executed. Clean rounds and DONE
consume all of these as if they were examined.

The ledger's reassurance in `R12-I1.md` ("the engine can only reject this way, never confirm, so it
cannot create a false blocking finding") is **wrong**. It held only because the fixtures' test script
names one fixed file, so added reproductions never ran. With a glob runner — SAT's shape — a broken
reproduction confirms.

**SAT's failure to finish is mostly product defects**, not owner decisions: discovery says
`framework=unknown`, one test file cannot be run, passing-test output is re-carried every turn, and
"unset the cap" silently means 32k.

## Evidence, verified by the coordinator

The coordinator re-ran Claude's probes in `/tmp/polish-r4-claude` (18/18 reproduce) and checked the
code and DB directly.

| # | Shape (correct code unless noted) | Today | Lanes |
|---|---|---|---|
| 1 | reproduction killed (SIGKILL, SIGABRT, `exitCode null`) | VALID "failed with exit code null" | all three |
| 2 | Jest-style reproduction under `node:test` (`ReferenceError: test/describe is not defined`) | VALID; on a SAT copy too | all three |
| 3 | an unrelated test fails next to a passing reproduction | VALID | Claude, Muse |
| 4 | added reproduction never executed, suite passes | REJECTED "the defect is not there" | all three |
| 5 | planted defect, script `node --test tests/add.test.mjs` | **DONE converged with the defect** (S1b) | Claude |
| 6 | judge VALID over an environment-failure artifact | fix task on correct code | all three |
| 7 | reviewer's reproduction text `npm exec --yes -- node -e …` | **executed** (marker file written), VALID, fix task; the worker policy refuses the same argv | Claude (P2), Muse (policy-free evidence worker) |
| 8 | mission "add `tests/neg.test.mjs`", worker finishes `noChange` | **DONE no_change_required, file absent** (S8) | Claude |
| 9 | real assertion failure whose text contains "ENOENT" | UNCERTAIN "command not found" (true defect hidden) | Claude |
| 10 | SAT's `node --import tsx --test "src/**/*.test.ts"` | `framework: "unknown"` in `project.discovered` of `run_01m3dwz31fzbv547k3v0vh` | Claude, Muse |
| 11 | `maxTaskTokens` unset, three 12k worker turns | `BUDGET_EXCEEDED` (hidden 32k, cumulative) | all three |
| 12 | `apply_patch` with `oldText === newText` | `ok`, counts as loop evidence | Claude |

Row 7 is also a threat-model breach: `ProjectFindingEvidenceWorker.tryFailingTest`
(`src/findings/reproduce.ts:116-178`) runs `testCommand(finding)` — argv split from model-written
text — through `runProcess` with no `CommandPolicy`, against THREAT_MODEL guarantee 2.

**Live DB** (read-only): 151 findings, 0 VALID. 29 execution-backed refutations; none executed
anything that tested the claim — 21 investigations re-ran `npm run test` (4 with no added file at
all), 8 validator runs re-ran the project test script the gate had just passed. 66 `runtime_evidence`
validations ran nothing ("no runtime/ directory"). Judges answered VALID 19 times on false claims;
each was stopped only because the finding had no artifact yet. In the two final DONE runs, zero of
the 17 findings were refuted by an execution of their reproduction.

## Disagreements, resolved

| Point | Lanes | Resolution |
|---|---|---|
| Does discovery detect SAT as `node-test`? | GPT yes; Claude, Muse no | **No.** `/\bnode\s+--test\b/` (`discovery.ts:106`) cannot match `node --import tsx --test`; the live event says `unknown`. GPT is wrong here. Claude adds: `pkg.includes("jest")` profiles `"majestic-app"` as jest |
| Is `DONE no_change_required` sound? | GPT, Muse: the strongest path; Claude: over-claims | **Claude.** S8 reproduces: base gates pass, nothing evaluates the task's acceptance. `antiFakeDone.ts:167` says acceptance "was shown to hold on its base"; nothing shows it |
| Order of work | Claude: acceptance suite first; GPT: contract first, acceptance last; Muse: classifier first | Acceptance cases first, as red tests — they are the "fails before" of every later item, and Claude's probes already are most of them |
| Single-test-file grant: owner decision? | Claude, GPT: product defect (grants less than `npm run test` already runs); Muse: product defect, owner signs off the posture | Product work; recorded so the owner can veto |
| Canary timing | Muse: fix now; Claude: cost, not honesty; GPT: after measuring cost | Not on the honesty path. Deferred |
| Blocking finding still not examined at the end | Claude: DONE with disclosure (`converged_with_unexamined`); GPT: NEEDS_HUMAN; Muse: not clean, so no DONE | **Owner decides** (below). 2:1 against a plain DONE; all three against today's silent REJECTED |

## The evidence contract (merged)

Every finding outcome is one of three, produced by one pure judge and consumed everywhere:

- **demonstrated** — an added test was observed running on the finding's checkpoint and failed with
  an assertion (not a load error, `ReferenceError`/`SyntaxError` with its top frame in the added
  file, signal, timeout, or environment failure), and the same command without the added files does
  not fail (control run).
- **refuted** — the added tests were observed running and all passed.
- **not examined, with a reason** — `reproduction_not_executed`, `reproduction_broken`, `killed`,
  `timeout`, `aborted`, `environment`, `command_refused`, `control_failed`,
  `failure_outside_reproduction`, `unrecognised_runner`, `worker_failed`, `checkout_failed`,
  `no_executable_reproduction`, `citation_unverifiable`, `debate_dismissed`.

"Observed running" means per-test identities from the runner's report (node:test, vitest, jest). The
node:test file identity already exists for the silencing gate (`d2b5a8d`) and moves to a shared
parser. `verdict` becomes derived (demonstrated → VALID, refuted → REJECTED, not examined →
UNCERTAIN) so the FSM and reports keep working; the outcome and reason are first-class on
`FindingValidation`, `investigation.completed` and the finding.

Consumption:

- **Fix task:** only from `demonstrated` by a system actor, enforced in `createTaskFromValidFinding`
  (`domain/task.ts`) — the single function all three callers (`validator.ts`, `investigation.ts`,
  `reviewDrivers.ts`) already use. No model verdict can create a fix task anywhere.
- **Debate:** decides relevance, scope, duplication and routing, never existence. Judge VALID means
  "investigate first, with the prosecution's argument as the brief". Judge REJECTED on relevance is
  `not_examined: debate_dismissed` with the families and requirement refs. Debate transcripts are
  never evidence refs (today `evidenceRefs = [...preDebateRefs, ...debateArtifacts]`,
  `reviewDrivers.ts:653`).
- **Clean round:** records a disposition tally (demonstrated / refuted / not examined by reason /
  duplicate / noted), so a round whose findings were never examined is visibly different from a round
  with none.
- **Retry:** `reproduction_not_executed`, `reproduction_broken`, `unrecognised_runner`,
  `command_refused` retry the investigation once with the reason and the first failure fed back.
  `killed`, `timeout`, `environment` do not retry the model and do not consume an investigation round.
- **DONE:** the summary is built from the tallies ("8 findings: 0 demonstrated, 1 refuted, 2
  dismissed, 5 not examined: …"). `no_change_required` additionally requires the task's acceptance
  to be checked on the base.
- **FAILED / NEEDS_HUMAN:** name the originating finding and its outcome; a FAILED fix task that came
  from a false VALID must not read as a worker stall.

## SAT: product defects vs owner decisions

Product defects (all three lanes, except where noted):

1. `detectFramework` misses `node` with flags before `--test`; substring `jest` match (Claude, Muse).
2. No example of the project's test style in a test-writing task: include the head of one existing
   test file (Claude, GPT).
3. No way to run one test file. `node --import tsx --test <file>`, `npm run test -- <file>` and
   `npx tsx --test <file>` are refused, while `npm run test` (which runs any `src/**/*.test.ts`) and
   `npm run prepack` (`rm -rf dist && …`) are allowed. A path-confined, runner-derived single-file
   command grants strictly less.
4. Test output: `run_command` pages head-first; node's failure summary is at the end and 373 of 385
   lines are `✔`. Fold passes into a count, keep failures and the summary verbatim, keep the full
   output pageable. `outputCompressor.ts` is still unwired (round 3 said wire it).
5. Hidden 32k: `composition.ts:872` `maxTaskTokens ?? 32_000`, a cumulative per-attempt sum.
   Review calls carry `taskId` without `taskAttempt` (`swarm.ts:117`) and accrue on the bare key.
6. No-op `apply_patch` reports success (Claude; glm sent three in the last SAT run).

Owner decisions: the numeric budget values, and what the cap is named and means (per attempt, per
task, per review round). Claude estimates glm's SAT attempt at about six turns and 15–20k tokens once
items 1–4 land; unverified without a live run.

## Plan (merged, ranked)

| # | Change | Test that must fail before | Needs | Lanes |
|---|---|---|---|---|
| 1 | **Acceptance suite** `src/e2e/acceptance.test.ts` on paired fixtures (correct vs planted defect; named vs glob runner), whole-run through `DaemonService` with scripted models. Cases below | cases 3, 5–8, 11, 12, 15 red today | — | all |
| 2 | **Delete the validator's reviewer-command path** (`tryFailingTest`, `testCommand`, the policy-free `CheckpointCheckoutEvidenceWorker` default); a triaged finding goes to investigation or is `no_executable_reproduction` | P2/S6: no process spawned from `finding.reproduction` | — | Claude, Muse |
| 3 | **Evidence contract + judge** (`src/domain/evidence.ts`, `judgeReproduction`), control and treatment runs in `investigation.ts`, shared per-test parser; replace `classifyReproduction` | rows 1–4, 9 of the evidence table | 1 | all |
| 4 | **Fix task only from demonstrated**, in `createTaskFromValidFinding`; debate advisory; delete `legalDebateValid`; rewrite `debate-drivers.test.ts` cases 2/2b and `investigation.test.ts:184,191` (they pin the over-claim) | row 6 → no fix task | 3 | all |
| 5 | **Single-test-file capability** from the discovered runner (`ProjectProfile.testRunner`, a path-confined `test_file` allowlist rule); fix `detectFramework`; the investigation's default argv runs the added file | SAT script → `node-test`; policy admits `node --import tsx --test src/__tests__/x.test.ts`, refuses `../x`, two operands; row 5 → demonstrated | — | all |
| 6 | **Clean rounds, DONE and terminals consume the contract**: disposition tally on `CleanRound`, DONE summary from it, FAILED/NEEDS_HUMAN name the originating finding | row 5 without item 5 ends not plain `converged` | 3, owner decision A | all |
| 7 | **`no_change_required` checks acceptance**: structured acceptance checks from the council (`file_exists`, `command`, `test_file`), or refuse noChange when an acceptance line names a path absent on the base | S8 → noChange refused → file written → DONE converged | 1, owner decision D | Claude |
| 8 | **Test output shaping** in `run_command`: passes folded, failures and summary verbatim, full `outputRef` | SAT's 385-line output → ≤ ~40 lines, contains the `ReferenceError` and `ℹ fail 1` | — | all |
| 9 | **Budgets**: `null` means no cap; separate review key; name the scope (`maxAttemptTokens`) and say it in the terminal summary | S7 → no `BUDGET_EXCEEDED` | — | all |
| 10 | **Worker workflow**: `apply_patch` rejects a no-op; test tasks include the head of an existing test file and the framework | P4; SAT replay instruction contains `from 'node:test'` | 5 | Claude, GPT |
| 11 | **Triage and labels**: split NOTED into `citation_unverifiable` vs `no_evidence`; match quotes against the diff's removed side; one bad ref marks that ref, not the finding; DUPLICATE requires the same checkpoint and inherits the outcome; drop the `.mjs` runtime hint and the `runtime_evidence`/`investigation` labels on paths that ran nothing | a finding quoting `-  return pad(a - b);` is validated, not NOTED | 3 | all |
| 12 | **SAT offline replay** after 5, 8, 9, 10: writes a node:test file, runs only that file while iterating, the whole gate once, DONE under an explicit budget | the replay itself | 5, 8, 9, 10 | GPT |

Deferred: canary before a reviewer's first production round (cost, not honesty); the validator's
dropped investigation task at `reviewDrivers.ts:313` and dead verdict vocabulary (`RESOLVED`, unused
methods) — delete or wire, after item 3. Muse notes that several "equivalent" mutants in R12-I1 are
equivalent only because the path is dead; ask whether the path should live before certifying it.

### Acceptance cases (union)

Shared task "make `add` return the sum"; "named" = `node --test tests/add.test.mjs`, "glob" = bare
`node --test`. Each case asserts the final run verdict, the finding's outcome and reason, the code on
the run branch, and the DONE tally.

1. correct code, silent reviewers → DONE, 0 findings
2. planted defect, glob, good reproduction → demonstrated → fix → DONE, code correct
3. planted defect, named, good reproduction → not executed → retry on the single-file runner →
   demonstrated → fix → DONE (without item 5: never plain `converged`)
4. correct code, false finding, reproduction runs and passes → refuted → DONE
5. Jest-style reproduction → `reproduction_broken`, no fix task
6. reproduction killed by a signal → `killed`, no fix task
7. unrelated test fails when a file is added → `failure_outside_reproduction`
8. pre-existing red test on the checkpoint → `control_failed`
9. missing module or script → `environment`, naming what is missing
10. reproduction past its timeout → `timeout`
11. reviewer reproduction text is executable → never executed (marker absent)
12. judge VALID over an environment artifact → no fix task; investigation decides
13. judge dismisses an affirmation ("add returns the sum") → `debate_dismissed`, disclosed
14. no-change mission that holds → DONE `no_change_required`
15. "add `tests/neg.test.mjs`" with a noChange finish → refused → file written → DONE
16. SAT shape (glob runner, worker writes Jest first) → broken file caught by its own single-file
    run → node:test file → DONE under the budget
17. gate check killed mid-run → `environment`/`killed`, never a regression

### What number lets the owner trust a DONE

- **Scripted tier:** 17 of 17 on every commit, plus a mutant sweep over the verdict lines
  (`investigation.ts`, debate application, clean-round recording, `triage.ts`, `antiFakeDone.ts`)
  with no non-equivalent survivor. Any miss is a bug, not a rate.
- **Live tier**, free models, paired runs of the same fixtures: **false-demonstrated rate** (correct
  code with any demonstrated blocking finding) and **silent-miss rate** (planted defect ending plain
  `DONE converged`) both 0. With 0 of n, the 95% upper bound is about 3/n: 30 + 30 runs bound each at
  10%, 60 + 60 at 5% (Claude). GPT asks for 20 distinct correct/defect pairs, since repetitions of one
  oracle shape are not independent.
- **Examination rate** on every DONE: demonstrated or refuted ÷ all validated findings. Today it is 0.

## Owner decides

- **A. A blocking finding the engine could not examine, after its retry.** DONE with the reason on
  the summary and a distinct code (Claude), or `NEEDS_HUMAN` naming what was missing (GPT; Muse by
  refusing the clean round). The trade is autonomy against a silent miss.
  **Owner, 2026-09-26: DONE with a distinct code and the reason on the summary.**
- **B. May a three-family debate dismissal close a blocking finding without execution?** All three
  lanes let debate decide scope and relevance; Claude recommends yes, since the alternative spends an
  investigation on "add returns the sum".
  **Owner, 2026-09-26: no. A blocking finding closes only through an investigation that executed.**
  Debate still routes and prioritises; its REJECTED no longer closes a blocking finding.
- **C. The single-test-file grant** (item 5). Two lanes call it product work; recorded for a veto.
- **D. How structured the council's acceptance output must be** (item 7).
- **E. The token cap's value and scope names** (item 9), and the live-tier n.

## What is good, and stays

Fresh checkpoint checkouts with only added files and a shadowing guard; the engine, not the worker,
runs the command; an event log complete enough that every verdict above was traced from the DB to its
argv, exit code and output; the single fix-task factory, so the owner's rule becomes a domain
invariant in one place; family diversity with the `run.mechanisms` manifest; the canary's design;
baseline-relative gates with silencing detection; paging instead of truncation; finish guards that
require a fresh passing command; and a scripted scenario harness cheap enough (about a second a run)
to make the acceptance suite routine.
