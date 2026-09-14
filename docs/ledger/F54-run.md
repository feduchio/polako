# F54 run record

| Field | Value |
|---|---|
| Contract | revision 3 at `6634348`; rev 1 frozen at `fde4530`, rev 2 at `cf7c804` |
| Base | HOST `ef11a00` (accepted P2 block) |
| Finding | 54, from P2.3 |
| Implementation | `cf7c804`, then `6634348` |
| Gate | Node 24.20.0; **94 files, 1,046 tests**, exit 0 (was 93 / 1,022) |

## What changed

Five production files and one new module, across revisions 2 and 3.

**`src/shared/projectDependencies.ts` — the predicate, defined once.**
`untrustedForMissingDependencies(cwd, argv, scriptText?)` returns a reason or `null`. The condition
is: no `node_modules`, a `package.json` present, and **either** the manifest declares at least one
dependency in any of the four dependency fields **or** the command or resolved script names
something that needs installed packages. `src/findings/reproduce.ts` now calls it instead of
carrying its own copy.

**`src/project/checkRunner.ts` — the result stops lying.** A non-passing check whose command was
untrusted is recorded as `status: "error"` rather than `"fail"`, and **with no
`failureFingerprint`**. `untrustedChecks(sandbox, profile)` is exported so a caller can ask about a
whole profile before deciding to record anything.

**`src/daemon/composition.ts` — `BASELINING` refuses.** When any check of the run is untrusted, no
`baseline.snapshotted` event is appended and the driver returns `NEEDS_HUMAN` with a
`terminalReason` naming the checks and telling the operator to install dependencies and resume.
The checks still run first, so their real output is in the CAS where the operator can read it.

**`src/domain/run.ts` — one new terminal reason code, `environment_not_ready`.** None of the
existing codes fits and bending one would have repeated the defect this item exists to fix. No
consumer switches exhaustively over that enum.

## Why the missing fingerprint is the load-bearing part

Marking the status `error` is the honest label. Withholding the fingerprint is what closes the
hole. `compareToBaseline` (`src/domain/checks.ts:104-130`) treats a check failing in both baseline
and candidate as **unchanged** when the two `failureFingerprint` values are equal, and records a
`diagnosticChange` when one is missing. That is the mechanism by which an all-fail baseline made a
candidate reproducing the same failures look regression-free. With no fingerprint the comparison
fails closed on its own terms, without touching `compareToBaseline`, `hasRegression` or the
`passed` fold — which MC6 forbids.

## The contract changed before anything shipped, and why that is not tuning

Revision 1 defined the trigger as "argv[0] is a Node package manager". **The test suite falsified
it immediately: 13 failures**, and the counter-example is in the repository.
`fixtures/resume-dup-fetch` declares **no** dependencies and its check is `pnpm run test` →
`node --test tests/retryFetch.test.mjs`, which needs no `node_modules`. Under revision 1 every
fixture run would have refused to baseline.

Revision 2 keys on **declared dependencies** instead, which separates the two cases exactly: the
fixture declares none, `unjs/defu` declares eleven devDependencies and has none installed. The
command-shape test is kept as a second disjunct so the reproduction path's behaviour is preserved.

This is an amendment forced by a counter-example, not a criterion tuned to make a number come out
right, and the distinction is the reason it is recorded here in full rather than applied quietly.
The residual false positive is stated in MC2 and in the code: a project that declares dependencies,
does not need them for a given check, and fails legitimately is still called untrusted. That is
the fail-closed direction.

## Observation — ten new checks, and the four mutants that prove they are not vacuous

`src/shared/projectDependencies.test.ts` (7 cases): a manifest declaring dependencies with none
installed is flagged; all four dependency fields count; a project declaring none that needs none is
**not** flagged, and the case is labelled as the fixture's shape; a command that needs packages is
flagged even when the manifest declares none; an installed project is not flagged; a directory with
no manifest is not flagged; an unreadable manifest is treated as declaring nothing rather than
throwing.

`src/project/project.test.ts` (2 cases): an uninstalled project's failure is `error` with no
fingerprint; an installed project's genuine failure is still `fail` **with** one.

`src/daemon/composition.test.ts` (1 case): a repository declaring dependencies with none installed
produces no `baseline.snapshotted` and no baseline row, reaches `NEEDS_HUMAN` with
`environment_not_ready`, names the check in the summary, and still records the
`shell.command_started` events proving the checks ran.

| Planted defect | Tests that fail |
|---|---|
| the runner never marks a result untrusted | 1 |
| the driver records the baseline anyway | 1 |
| the predicate ignores declared dependencies | 4 |
| an untrusted result keeps its fingerprint | 1 |

The existing baselining test — a `package.json` with no dependencies — still passes unchanged,
which is AC4: the normal path is untouched.

## Round 1 changed the item: both halves, because one of them was unclearable alone

The entry gate returned six findings and the first reframed the work. The refusal sent the run to
`NEEDS_HUMAN` telling the operator to install dependencies — but every baseline attempt creates a
**fresh** git worktree, which never carries `node_modules`, so the instruction could not be acted
on. The reviewer demonstrated it: it reached `NEEDS_HUMAN`, created `projectPath/node_modules`,
resumed, and returned to `NEEDS_HUMAN`. A refusal nobody can clear trades a false baseline for a
stuck run, which for a self-hosting system is not obviously better.

**User decision 2026-09-14: do the install half now.** Contract revision 3. The sandbox installs
the project's dependencies before its checks run, and the refusal stays as the backstop — which is
what makes the install safe to have, since install can be disabled, fail, or change nothing.

| Piece | Where |
|---|---|
| install command, one definition shared with the policy that admits it | `installCommandFor` in `src/shared/projectDependencies.ts` |
| exact-match allowlist rule, for the discovered package manager only | `CommandPolicy.forProject` |
| `sandbox.installDependencies` (default `true`) and `sandbox.installTimeoutMs` | `src/domain/config.ts` |
| install, re-check, and a forensic record that is not a check result | `ensureProjectDependencies` in `src/project/checkRunner.ts` |

The default is `true` because the refusal is otherwise unclearable, and nothing is attempted when
dependencies are already reachable — every in-tree fixture declares none, so no existing path
changes.

## The other five findings

**Only a non-passing result can be untrusted.** Revision 2 evaluated the predicate independently of
the results, so a project declaring dependencies whose checks **passed** was refused. A check that
passed is evidence whatever the environment looked like.

**The spawn-error path withholds its fingerprint too.** The untrusted branch sat only in the
successful-`run` path, so a sandbox throwing `ENOENT` still produced one.

**The resolved script text reaches the predicate.** A profile check is `<pm> run <script>`, and the
script is what says whether packages are needed. Without it the command-shape test could never fire
for a profile check, which left the original defect survivable for a project that declares no
dependencies but whose script needs them.

**Availability is not a local directory.** Node resolution walks ancestors, so a workspace package
legitimately has no `node_modules` of its own, and Yarn PnP has none anywhere. The test now walks
upward for the declared package and treats a PnP marker as available. It also no longer accepts an
empty `node_modules`, which the previous rule did.

**AC1 is amended rather than quietly broken.** The reproduction path's decision boundary does
change: a runnable reproduction in a project that declares unavailable dependencies now returns
`UNCERTAIN` where it previously executed. Same fail-closed direction, and it is the point of one
shared definition — but revision 2's AC1 claimed the behaviour was unchanged, and that was false.

## Two things the round taught about the tests themselves

**Two test environments were untrustworthy and are now installed.** `allows an unchanged baseline
failure but rejects a new failure` captured its baseline through a sandbox at one path and gated
through another that declared `vitest run` with no vitest present. Under the new rule the gate
result is correctly untrusted, which broke a test about comparison for reasons that had nothing to
do with comparison. It now creates `node_modules/vitest`.

**The driver tests script every package-manager command, because pnpm v10 installs before `run`.**
The first version of the install test let the real `pnpm` run and it reached the network: with a
lockfile present and `node_modules` missing, pnpm installs before running a script. The tests were
measuring the registry. They now script `pnpm` entirely and assert the driver's decisions.

## What is still not fixed

An install that genuinely cannot succeed — no network, a stale lockfile, a package manager we do
not drive — still ends at `NEEDS_HUMAN`. That is now the correct outcome rather than a dead end,
because the operator can fix the install itself, and the terminal reason says which case it is.

## Gate

`pnpm typecheck && pnpm lint && pnpm deps:check && pnpm vitest run --maxWorkers=2`

Result: 94 test files, 1,046 tests, exit 0.
