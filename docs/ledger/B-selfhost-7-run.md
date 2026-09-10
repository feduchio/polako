# B-selfhost-7 provenance

| Status | **TASK ACCEPTED** |
| Exact base | `df49a5ef75996da5ee17c51b4f66e974d8952fc0` |
| Draft reviewed | FAIL/FAIL — both reviews changed the contract |
| Frozen hash | `bba8198de33abf746be2b7cc58f8bfcc9ba54bba63d285abe4003748862d797d` |
| Freeze commit | `f759a719caf1a36ceed274299059a7b0368fd90d` |
| Impl | `1dc1c5cfbb2f92efb2fa8f58f15e92f02a3c80b2` on `task/B-selfhost-7-candidate-grok` |
| Accepted at | `1dc1c5cfbb2f92efb2fa8f58f15e92f02a3c80b2` on `task/B-selfhost-7-integration` |
| Clean | 2/2 on the accepted commit |

## Contract review changed the task

Both draft reviews returned FAIL, and both were right about something the
coordinator had got wrong.

Claude showed the draft's "drive the runs alternately" requirement was
unsatisfiable as written: sequential `tickRun` calls are passed by an
implementation that saves the mode, sets it around `await driver(...)`, and
restores it — which still leaks on the real concurrent path. The frozen contract
names the mechanism instead: both runs inside one `RunEngine.tick()`, probe
drivers yielding to each other at an `await`, reading the mode on both sides.
That precision was load-bearing. Every code round confirmed the save-set-restore
cheap pass fails the concurrency check while passing others.

Grok showed the draft's MC4 contradicted the base: both the RPC handler and the
CLI default an omitted `runtime` to `"auto"`, so `polish.toml`'s
`runtimeValidation.mode` never reaches a daemon-created run. The contract now
preserves that behavior, and the dead setting is recorded as finding 17 rather
than silently repaired inside an unrelated contract.

## Implementation

The coordinator implemented this directly. The two Grok implementers assigned to
B-selfhost-6 had both stopped without producing a candidate, so no implementer
subagent was dispatched for this item.

- `d657e50` — the assignment to shared config deleted from `createRun`;
  `EngineOptions.resolveRunConfig` added and consulted at the single
  `PhaseContext` construction site; `withRuntimeValidationMode` derives a run
  view that differs only in the mode; the daemon resolves each run's mode from
  the `runtime` field already persisted in its `facade.json`.
- `7dbc744` — the run's mode is registered before the run becomes tickable.
- `1dc1c5c` — engine-level coverage of the `resolveRunConfig` seam; the
  `createBranch` probe no longer restores itself from inside its own success
  path; the static pin matches `=(?!=)` so a wrapped assignment cannot slip past.

## Review rounds

| Round | Commit | Grok | Claude |
| --- | --- | --- | --- |
| 1 | `d657e50` | PASS | PASS (non-blocking: mode registered after an await) |
| 2 | `7dbc744` | PASS | PASS (non-blocking: no engine-level test; spy can leak) |
| 3 | `1dc1c5c` | PASS | PASS |
| 4 | `1dc1c5c` | PASS | PASS |

Rounds 1 and 2 were clean, and the coordinator still changed code both times,
which reset the clean-round count each time. Rounds 3 and 4 are the two clean
rounds on the accepted commit.

The round-1 change was not cosmetic. At base the mode was assigned before the
run existed; the round-1 implementation registered it after `engine.createRun`
and an `await git.createBranch(...)`, so a timer tick landing in that window
resolved the run against the loaded config. Narrower than base, inside the very
function this contract is about. Both reviewers judged it unreachable today —
`driveRun` advances one phase per call and `CREATED` cannot reach a reader — but
that safety rests on distance between phases, an incidental fact. Registering
immediately after creation closes the window structurally: no `await` separates
the two statements, so nothing can interleave.

The round-2 change closed the one place where a reviewer had to rule a
PHASE_REQUIRED clause satisfied *substantively* rather than read a check.

## Anti-fake evidence

Reviewers killed the tests by mutation independently of the coordinator, 13
mutations in the last round alone. Both cheap passes the contract names by name
were implemented and caught: save-set-restore around the driver await fails the
concurrency check, and a constructor-time clone behind a pristine `getConfig()`
fails the identity check. Claude additionally replaced the engine's `Promise.all`
fan-out with a sequential loop; the concurrency test then deadlocks, so it cannot
pass unless both runs really are in flight inside one tick.

Coordinator mutations before review: restoring the base defect fails 7 of 10;
save-set-restore fails 7; ignoring the injected resolver fails 2 of the 3 engine
tests; moving registration back after the await fails the mid-create test with
`Set{off, required}`; a wrapped assignment is caught by the tightened pin.

## Gates

`pnpm check` + `pnpm build` on Node 24.20.0: typecheck, eslint,
dependency-cruiser (258 modules, 0 violations), 71 files / 634 tests green.

## Test-strength notes for whoever next touches these files

None of these makes the product wrong or any test vacuous today; each was
verified by a reviewer and left deliberately rather than chased after a clean
round.

1. The "creation does not disturb an active run" check uses `off` as both the
   configured mode and the first run's mode, so an incomplete fix that returns
   the shared config still passes it. Three other checks catch that fix. Giving
   the first run `required` would make this one discriminating on its own.
2. The mid-create probe does not assert the run branch exists. Three reviewers
   independently confirmed the spy does call through and the branch is created.
   The assertion would make the probe self-checking against a future change in
   Vitest's spy fallback semantics.
3. The post-restart check recovers one run, not two with different modes,
   although the implementation resolves each run's `facade.json` separately.
4. The identity check pins `getConfig()` against production composition but not
   against what was handed to `RunEngine`; handing the engine a spread copy
   passes the whole daemon and engine suite.

## Process note

Review rounds 1–3 ran both reviewers concurrently in the same worktree. Reviewers
mutate sources to test assertion strength and restore them with
`git checkout -- <file>`, so they can overwrite each other's probes. No
inconsistency appeared in the reports, and the failure direction is a spurious
*failure* rather than a spurious pass, so no accepted item is in doubt. Round 4
gave each reviewer its own worktree at the same commit. Later items do this from
the start.

## Findings recorded, not fixed here

Recorded as open findings 21 and 22. Both concern the guard rather than the fix:
a corrupt `facade.json` silently degrades a `required` run to the loaded mode,
and the static pin that protects MC1 does not see bracket access or
`Object.assign`.
