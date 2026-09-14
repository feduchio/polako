# F54 run record

| Field | Value |
|---|---|
| Contract | revision 10; frozen at `fde4530`, amended at `cf7c804` (rev 2), `6c539f8` (rev 3), and in rounds 7 through 13 |
| Base | HOST `ef11a00` (accepted P2 block) |
| Finding | 54, from P2.3 |
| Implementation | `cf7c804`, then thirteen fix rounds beginning at `6634348` |
| Change against base | 30 files, +3,103 / −87 |
| Gate | Node 24.20.0; **95 files, 1,076 tests**, exit 0 (was 93 / 1,022) |

This record is written after the thirteenth round. Earlier versions of it described revision 2 —
1,046 tests, "five production files", and a story that ended at `BASELINING → NEEDS_HUMAN` — while
what had actually shipped spanned the predicate, the check runner, two drivers, the integration
path, the allowlist, the config, the status projection and the report. A run record that
misdescribes what shipped has been treated as a class (a) defect on this project before, so it is
rewritten rather than patched.

## What the item became

**One sentence.** Nothing produces a `CheckResult` from a sandbox nobody prepared, and no result
that fails to say something about the project is returned to anyone.

Two halves, as revision 3 framed them, and the order matters: the second is what makes the first
safe to have.

1. **A trusted baseline is obtainable.** A sandbox installs the project's dependencies before its
   checks run.
2. **Nothing untrustworthy is recorded.** When install is disabled, fails, or does not help, the
   results are refused rather than stored as the project's own status.

## Where it lives

| Piece | Where |
|---|---|
| the predicate — "this command's result is not evidence about the project" | `untrustedForMissingDependencies` in `src/shared/projectDependencies.ts` |
| the install command, one definition shared with the policy that admits it | `installCommandFor`, same file |
| exact-match allowlist rule, for the discovered package manager only | `CommandPolicy.forProject` |
| `sandbox.installDependencies` (default on) and `sandbox.installTimeoutMs`, with the same two defaults the runner applies | `src/domain/config.ts` |
| install, re-check, forensics that are not a check result | `ensureProjectDependencies` in `src/project/checkRunner.ts` |
| **preparation and refusal, inside the function that runs the checks** | `runChecks`, same file |
| the refusal type, thrown where it is decided | `EnvironmentNotReadyError`, same file, re-exported by `src/engine/candidates.ts` |
| `BASELINING` turns the refusal into `NEEDS_HUMAN` | `src/daemon/composition.ts` |
| `GATING` turns it into a `DISCARDED` candidate, and a terminal `FAILED` when no candidate survived | `src/engine/candidateDrivers.ts` |
| `INTEGRATING` lets it escape rather than folding it into an integration outcome | `src/engine/integration.ts` |
| `environment_not_ready`, a terminal reason code that names the condition honestly | `src/domain/run.ts` |

## The design correction, round 7

The second lane blocked the item on a mutant rather than on a detail. `prepareDependencies` was an
optional field, and `runGates` skipped preparation when it was unset; deleting the four-line
assignment in `resolveGates` left **93 tests green** while candidate gating silently stopped
preparing — and under that mutant the whole path this item had spent four rounds building
(`EnvironmentNotReadyError`, `DISCARDED`, terminal `FAILED`) never executed at all, because every
candidate simply failed its gates instead.

The diagnosis is about the object, not the wiring. MC9 named **two places that must remember**. Six
rounds of fixes were six consumers of one idea forgetting it in turn. What must actually hold is
that nothing produces a check result from an unprepared sandbox, and the only formulation of that
which cannot be forgotten is the one inside the function that runs the commands. So:

- `runChecks` prepares, and **omitting the option means prepare with defaults**. A call site can be
  deleted without turning preparation off; what it carries now is the operator's *setting*.
- `enabled: false` is a refusal, not a skip: the checks still do not get to speak.
- The refusal is thrown from `project/`, where it is decided, and re-exported from `engine/`. All
  three consumers get the same refusal without three layers agreeing to it separately.

## Why the refusal is decided after the checks run, not before

The obvious form — refuse as soon as preparation fails — is simpler and wrong. It re-breaks MC11,
the correction review round 1 had already forced: a project that declares dependencies it does not
need, whose check **passes**, would be refused, and that check is evidence whatever the environment
looked like. The suite says so directly; two tests fail on the early-refusal version, and one of
them is a candidate being discarded for an environment its passing checks did not need.

So `runChecks` prepares, runs, and then asks whether any **non-passing** result was produced where
the environment could not support it. If so it throws, carrying both the preparation outcome and
the results — which are still `error` without a `failureFingerprint`, so that even the forensic copy
is not a statement about the project.

## Why the missing fingerprint is load-bearing

`compareToBaseline` (`src/domain/checks.ts:104-130`) treats a check failing in both baseline and
candidate as **unchanged** when the two `failureFingerprint` values are equal, and records a
`diagnosticChange` when one is missing. That equality is what made an all-fail baseline let a
candidate reproducing the same failures look regression-free. With no fingerprint the comparison
fails closed on its own terms, without touching `compareToBaseline`, `hasRegression` or the `passed`
fold — which MC6 forbids.

## The contract changed nine times, and why none of it is tuning

**Revision 1 → 2.** The trigger was "argv[0] is a Node package manager". The suite falsified it
immediately — 13 failures — and the counter-example is in the tree: `fixtures/resume-dup-fetch`
declares **no** dependencies and its check is `pnpm run test` → `node --test`, which needs no
`node_modules`. Revision 2 keys on declared dependencies, which separates the cases exactly: the
fixture declares none, `unjs/defu` declares eleven and has none installed.

**Revision 2 → 3.** Review round 1 showed the refusal alone was unclearable: every baseline attempt
creates a fresh worktree, so an operator told to install dependencies could never make the
instruction take effect. The reviewer demonstrated it — `NEEDS_HUMAN`, install into `projectPath`,
resume, `NEEDS_HUMAN` again. **User decision 2026-09-14: do the install half now.**

**Revision 3 → 4.** The design correction above, forced by a surviving mutant rather than by taste.

**Revision 4 → 5.** The install had moved to a point after acceptance artifacts were verified, so
the gate could certify bytes the install then replaced. Four clauses were also stated and
unobserved. Both found by the first lane, both reproduced before being believed.

**Revision 5 → 6.** Revision 5's own AC17 was false: it said an install that replaces an artifact
fails the gate, which held only against a test double. Against the production materializer the
artifact is *restored*, and what matters is that the restoration happens before the commands run.
The lane that found it had to replace the double with production-equivalent behaviour to show it —
which is the difference between a clause that is observed and one that is merely asserted.

**Revision 6 → 7.** Reading the candidate before the install answered attribution and silently
stopped answering integrity. Two reads, two questions.

**Revision 7 → 8.** Two reads have to stay two. Concatenating them into one text before parsing
re-merged the states the split existed to separate.

**Revision 8 → 9.** The reviewing lane stopped reporting the edge and named the shape: four loose
variables invite evidence from one moment to be judged against metadata from another, and every
ordering defect in rounds 8 to 12 was an instance. A capture is now a value, judged whole.

**Revision 9 → 10.** Judging a capture whole raised the question the loose variables had hidden:
what can a capture answer *at all*? The settled one cannot answer a hash comparison, because the
baseline's hashes are from the source moment and an install that stamps `package.json` does it in
every checkout, the baseline's included. So it carries none, and answers with its diff.

Each amendment is recorded with its counter-example rather than applied quietly, because the
difference between an amendment and a tuned criterion is exactly whether the counter-example exists.

## The rounds, and what each one was

| Round | What was wrong |
|---|---|
| 1 | candidate gating did not prepare at all — the wall moved from `BASELINING` to `GATING` |
| 2 | availability accepted *any* declared package rather than every one, so a partial install passed |
| 3 | availability accepted a directory rather than an installed manifest |
| 4 | the refusal threw where production never caught it, so every tick reinstalled forever |
| 5 | `FAILED` hid the reason, and the report said "DONE: Mission complete" for a failed run |
| 6 | `INTERRUPTED` was non-terminal, so a retry deadlocked |
| 7 | the design: preparation was optional, and a deleted call site kept 93 tests green |
| 8 | preparation ran *after* acceptance artifacts were verified, and four clauses nothing observed |
| 9 | the install's own `node_modules` was read as the candidate's work, and AC17 was false as written |
| 10 | reading the candidate early made the install's and the checks' own edits invisible |
| 11 | the two reads were concatenated before parsing, and a failed read fell back silently |
| 12 | both diffs were judged against the *final* manifest hashes, losing what a check had undone |
| 13 | the settled capture compared hashes with a baseline taken at a different moment |

## Round 8: what the ordering change cost, and four clauses nothing observed

The refactor moved preparation into `runChecks`, which runs **after** `runIndependentGates` has
inspected protected paths, materialized acceptance artifacts and hashed their bytes. The first lane
reproduced the consequence: an install runs the project's own lifecycle scripts, so it can replace
an acceptance artifact that was verified a moment earlier, and the gate passed on a file it had
certified in a form that no longer existed.

The fix is not a second call site. `prepareSandbox` memoizes the preparation *promise* per sandbox
handle, so `runIndependentGates` can settle the filesystem before it verifies anything and
`runChecks` still prepares unconditionally — the second ask returns the first answer rather than a
second `npm ci`. Both callers are now guaranteed; neither is the only one.

## Round 9: the install is a third party in the checkout, and it is neither the candidate nor us

Round 8 put the install first. That was too far. The gate reads three things from a checkout and
they do not want the same moment:

| Read | When | Why |
|---|---|---|
| what the candidate changed — files, diff, manifest hashes | **before** the install | an install writes an untracked `node_modules`, and a repository is entitled not to ignore it; git would otherwise report installed dependencies as the candidate's work, and one `it.skip` inside a dependency accuses the candidate of muting a test |
| acceptance artifacts materialized and verified | **after** the install | an install runs lifecycle scripts, so canonical bytes written before it are bytes the install may replace |
| the checks | after both | they must see the canonical files and a usable environment |

The first lane demonstrated the first row on a real worktree: a passing candidate failed its gate
with `skip_only` at `node_modules/dependency/index.test.js`.

It also showed that round 8's own acceptance clause was **false**. In the corrected order the
materializer *restores* what an install overwrote, so the honest invariant is not "an overwrite
fails the gate" but "the commands see canonical bytes". The round-8 test only produced `modified`
because its materializer was a no-op; with production-equivalent materialization the gate passes,
and passing is correct. Both statements are now tested: one asserts the bytes the check command
actually read, the other keeps the no-op case and asserts the gate fails it.

The memo was also unobserved as a *promise* memo: storing the settled result instead let two
concurrent askers each start an install in the same checkout, with the whole suite green. A
concurrency case now holds the first install open and asserts the second run issues none.

## Round 10: reading early answered "who", and stopped answering "what"

Moving the read before the install fixed attribution and opened a gap in time. Between that read
and the verdict, two parties write to the checkout that are not the candidate: the install's
lifecycle scripts, and the check commands. The first lane planted a `vitest.config.ts` exclusion
from each in turn, and the gate passed both times.

So the tree is now read **twice**, and the two reads ask different questions:

| Capture | Includes untracked | Answers |
|---|---|---|
| before the install | yes | what the candidate did, including files it added but never committed |
| after the checks | no | what the checkout the verdict is about actually contains |

The second is tracked-only precisely because the biggest untracked thing by then is the
`node_modules` we installed ourselves. The silencing detector sees both; an edit present in both is
reported once.

The same round closed the second half of the acceptance ordering. When materialization cannot
restore an artifact the install replaced, the gate had recorded `modified` and then run the checks
anyway — against bytes it had just declared were not the artifact. It now returns first, with the
problem and an empty check set.

The same round closed four clauses that were stated and unobserved, each demonstrated by a mutant
that kept the whole suite green: the reproduction path's use of the shared predicate (MC1/AC1),
`tsx` in the runner-shape pattern (MC13), Bun's install command in the runner and in the policy
that admits it (MC8), and the reason carried by a candidate discarded for its environment
(MC18/AC16) — which the previous version of this record claimed a test would catch, and none did.

## Observation

New and changed checks, and the mutants they kill. Every row below was run as a planted defect
against the full suite, not asserted from reading:

| Planted defect | Tests that fail |
|---|---|
| `runChecks` does not prepare unless asked | 2 |
| the `resolveGates` assignment is deleted | 1 |
| the refusal happens before the checks run | 2 |
| `runIndependentGates` verifies acceptance before preparing | 2 |
| `runIndependentGates` prepares before reading the candidate's diff | 1 |
| silencing reads only the pre-install capture | 1 |
| the two captures are concatenated before parsing | 1 |
| a failing settled read falls back instead of refusing | 1 |
| both captures are judged against the settled manifest hashes | 1 |
| the settled capture carries hashes and compares them to the baseline | 1 |
| the checks run despite an unverifiable acceptance artifact | 1 |
| the memo holds the settled result instead of the in-flight promise | 1 |
| the runner never marks a result untrusted | 1 |
| an untrusted result keeps its fingerprint | 1 |
| the predicate ignores declared dependencies | 4 |
| the reproduction path keeps its own predicate | 1 |
| `tsx` leaves the runner-shape pattern | 1 |
| Bun loses its install command | 2 |
| the driver records the baseline anyway | 1 |
| a discarded candidate carries no reason | 1 |

The new cases are: preparation happens when the caller says nothing (`project.test.ts`,
`candidates.integration.test.ts`); a refusal names only the checks that ran, under `only`; a
candidate whose checks pass in an unpreparable checkout is gated rather than discarded; the
operator's `installDependencies` setting reaches candidate gating, observed through the branch of
the refusal message that is reachable only when the setting arrived; an install that rewrites a
protected artifact does not reach the check command, and is failed as `modified` when nothing
restores it; a reproduction in a project with a partial `node_modules` returns `UNCERTAIN`
(`src/findings/reproduce.test.ts`, new file); an installed `node_modules` in a repository that does
not ignore it produces no silencing finding, on a real git worktree; two concurrent check runs on
one sandbox issue one install.

## Known cost, stated rather than discovered later

**MC2's residual false positive.** A project that declares dependencies, does not need them for a
given check, and fails legitimately is classified as untrusted. That is the fail-closed direction.

**An install that cannot succeed still ends the run.** No network, a stale lockfile, a package
manager we do not drive: `NEEDS_HUMAN` from baselining, terminal `FAILED` from gating or
integration. That is the correct outcome rather than a dead end, because the operator can fix the
install itself and the terminal reason says which of the three cases it is.

**Worker worktrees are not prepared.** This item covers sandboxes that run *project checks*. A
candidate worker's own worktree is a fourth sandbox, and it gets no `node_modules`; a worker that
wants to run the suite while it works will have to install for itself. Recorded here rather than
widened into this item.

## Gate

`pnpm typecheck && pnpm lint && pnpm deps:check && pnpm vitest run --maxWorkers=2`

Result: 95 test files, 1,076 tests, exit 0.
