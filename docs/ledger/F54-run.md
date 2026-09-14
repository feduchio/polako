# F54 run record

| Field | Value |
|---|---|
| Contract | revision 4; rev 1 frozen at `fde4530`, rev 2 at `cf7c804`, rev 3 at `6634348` |
| Base | HOST `ef11a00` (accepted P2 block) |
| Finding | 54, from P2.3 |
| Implementation | `cf7c804`, `6634348`, then seven fix rounds |
| Change against base | 28 files |
| Gate | Node 24.20.0; **94 files, 1,065 tests**, exit 0 (was 93 / 1,022) |

This record is written after the seventh round. Earlier versions of it described revision 2 —
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

## The contract changed three times, and why none of it is tuning

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

## Observation

New and changed checks, and the mutants they kill:

| Planted defect | Tests that fail |
|---|---|
| `runChecks` does not prepare unless asked | 2 |
| the `resolveGates` assignment is deleted | 1 |
| the refusal happens before the checks run | 2 |
| the runner never marks a result untrusted | 1 |
| an untrusted result keeps its fingerprint | 1 |
| the predicate ignores declared dependencies | 4 |
| the driver records the baseline anyway | 1 |
| a discarded candidate carries no reason | 1 |

The new cases are: preparation happens when the caller says nothing (`project.test.ts`,
`candidates.integration.test.ts`); a refusal names only the checks that ran, under `only`; a
candidate whose checks pass in an unpreparable checkout is gated rather than discarded; the
operator's `installDependencies` setting reaches candidate gating, observed through the branch of
the refusal message that is reachable only when the setting arrived.

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

Result: 94 test files, 1,065 tests, exit 0.
