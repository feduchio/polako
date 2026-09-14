# F54 run record

| Field | Value |
|---|---|
| Contract | revision 2 at `cf7c804`; revision 1 frozen at `fde4530` |
| Base | HOST `ef11a00` (accepted P2 block) |
| Finding | 54, from P2.3 |
| Implementation | `cf7c804` |
| Gate | Node 24.20.0; **94 files, 1,032 tests**, exit 0 (was 93 / 1,022) |

## What changed

Three production files and one new module.

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

## What is still not fixed

**Nothing installs dependencies.** An external project still cannot produce a *trusted* baseline;
it now refuses to produce an untrustworthy one. Finding 54 is updated to say which half is done.
The remaining half needs an allowlist entry for `pnpm install`, a network policy and a timeout
budget, and it is a separate decision rather than an oversight.

## Gate

`pnpm typecheck && pnpm lint && pnpm deps:check && pnpm vitest run --maxWorkers=2`

Result: 94 test files, 1,032 tests, exit 0.
