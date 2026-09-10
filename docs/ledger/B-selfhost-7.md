# B-selfhost-7 — Per-run runtime mode must not mutate shared daemon config

**Status:** FROZEN CONTRACT — not implemented, not accepted
**Class:** PHASE_REQUIRED with MISSION_CRITICAL invariants
**Exact base:** `df49a5ef75996da5ee17c51b4f66e974d8952fc0` (accepted B-selfhost-6)
**Source finding:** `docs/ledger/B-selfhost-remaining.md` item **7**

Not item 8 (`--budget-tokens` / `--budget-usd`, unused `applyRunBudgetOverrides`). Not item 12 (crash recovery of run settings). Not item 15 (daemon/RPC `src/e2e` fixture mission). Not item 16 (`off` early return in `corpusRuntimeEvidenceAllowsDone`). After freeze, do not rewrite.

## Authority

1. Finding 7: `createRun` mutates shared `config.runtimeValidation.mode`, a concurrent-run leak.
2. Exact base behavior as in `src/daemon/service.ts` and the single `PolishConfig` instance threaded from the `DaemonService` constructor into the engine, production deps, and every `PhaseContext`.
3. B-selfhost-6 accepted. Items 8, 9, 11–16 out of scope. Full B **DEFERRED_BY_USER**.

## Defect

`DaemonService.createRun` performs `this.config.runtimeValidation.mode = runtime` (`src/daemon/service.ts:173`). `this.config` is loaded once (`service.ts:68`) and fans out three ways:

- `service.ts:80` → `buildProductionDeps` → `ProductionDeps.config` (`composition.ts:154`)
- `service.ts:88` → `RunEngine` (`engine.ts:54`) → **every** `PhaseContext` (`engine.ts:202`)
- `service.ts:307` → report context

Starting a second run with a different `--runtime` therefore rewrites the runtime mode of every in-flight run and permanently alters the daemon's loaded configuration. The leak is deterministically reachable at base without any artificial interleaving: `createRun` assigns the mode at `:173` and then `await this.tick()` at `:227`, and `RunEngine.tick` drives all active runs in one `Promise.all` (`engine.ts:160-163`). Creating run B therefore re-drives run A under B's mode.

## Definitions (normative)

- **Base config object:** the exact `PolishConfig` **instance** returned by `loadPolishConfig(home)` in the `DaemonService` constructor (`service.ts:68`). Identity matters, not just value.
- **Resolved run config:** the `PolishConfig` visible as `PhaseContext.config` (`src/engine/types.ts:13`) while driving that run.
- **Per-run runtime mode:** `parseRuntimeMode` applied to the `runtime` parameter of the `run` RPC.
- **Production reader sites:** the complete set of non-test readers of `runtimeValidation` while a run is driven — `src/engine/candidateDrivers.ts:667` (mode, INTEGRATING), `src/engine/candidateDrivers.ts:702` (level, same call), `src/engine/convergenceDrivers.ts:440` (mode, CONVERGENCE_CHECK). `ProductionDeps.config` does not read `runtimeValidation`; fixing it alone fixes nothing.
- **Item-12 boundary:** the per-run mode is *already* persisted at base — `createRun` writes `runtime` into `facade.json` (`service.ts:221`, `FacadeRunMetadata.runtime`), read back for reporting at `composition.ts:773`. Resolving from that existing field is permitted and does not constitute item-12 work. Restoring catalog state, per-run budget, or scheduler run settings after a crash remains item 12.

## MISSION_CRITICAL

1. **No mutation of the base config object.** After any number of `createRun` calls with any `runtime` values, the base config object's `runtimeValidation.mode` MUST still equal the value produced by `loadPolishConfig`. Static pin: a grep of non-test `src/**` MUST find no assignment to `.runtimeValidation` or `.runtimeValidation.mode`. Scope is `runtimeValidation` only — the constructor's existing `this.config.convergence.requiredCleanRounds` override (`service.ts:69-70`) is a legitimate test hook and stays. `PolishConfig` is a `z.infer` type with mutable properties; freezing or `readonly` enforcement is not required.
2. **Identity preserved.** `getConfig()` MUST keep returning the same object instance that was handed to `RunEngine` and to `buildProductionDeps`. Splitting them — keeping a pristine object for `getConfig()` and mutating a clone handed to the engine — is an explicit contract violation, not a fix.
3. **Per-run resolution at the context boundary.** While driving run R, `PhaseContext.config.runtimeValidation.mode` MUST equal the mode requested for R, at every production reader site. Resolving the mode inside one phase or one driver while another reader still consults the shared object does not satisfy this.
4. **Concurrency isolation under the real concurrent path.** Two active runs created with different modes and driven within a **single** `RunEngine.tick()` (the `Promise.all` fan-out at `engine.ts:160-163`) MUST each observe only their own mode, including across an `await` boundary inside a driver. A save-set-restore around the `await driver({...})` call at `engine.ts:197-203` does NOT satisfy this: it survives sequential `tickRun` alternation and still leaks under concurrent driving. Creating a later run MUST NOT change an earlier active run's resolved mode.
5. **Resolved config is complete.** The resolved run config MUST be deep-equal to the base config except `runtimeValidation.mode`. `runtimeValidation.level` in particular MUST survive, since it is read two lines from the mode (`candidateDrivers.ts:702`). A shallow `{...config}` that reassigns or rebuilds nested groups is a violation; note that a shallow spread alone still aliases the nested `runtimeValidation` object and would keep the leak.
6. **Default preserved exactly as base.** Base behavior when `runtime` is omitted is `"auto"`, not the loaded `polish.toml` value: both the RPC handler (`service.ts:129`) and the CLI (`src/cli/index.ts:18`) default to `"auto"`. Preserve that. This task MUST NOT change which mode an omitted argument yields. That `polish.toml`'s `runtimeValidation.mode` is therefore shadowed for daemon-created runs is a separate recorded finding, not this task's business.
7. **Validation preserved.** `parseRuntimeMode` still rejects values outside `auto|required|off` before any run is created; an invalid value creates no run and changes nothing. The CLI's independent literal check (`cli/index.ts:18-20`) stays as-is; unifying the two is not in scope.
8. **Post-restart floor.** Whichever resolution source is chosen, a run recovered after a daemon restart MUST resolve to a deterministic mode that is no worse than base: either its own persisted mode or the loaded base mode, and never another run's requested mode. The chosen behavior MUST be pinned by a test.
9. **No scope creep.** No item 8/9/11–16, no C-tasks, no FSM widening, no Composer, no live-paid providers.

## PHASE_REQUIRED

1. Implement MC1–MC8. Every production reader site resolves per-run.
2. At least one acceptance check MUST be driven through the real entry point `service.handle("run", {...})` against a real temporary git repository, following the established pattern in `src/daemon/rpc.test.ts:63-72`, `src/daemon/bootstrap-daemon.test.ts:129`, or `src/e2e/b10-daemon.test.ts:301-311`. Hand-constructing `PolishConfig` or `PhaseContext` objects does NOT satisfy the daemon-level requirement. Note `createBranch` is `git branch` and does not move HEAD, so two runs may share one temporary repository.
3. Tests live in daemon and engine suites — `src/daemon/composition.test.ts`, `src/daemon/rpc.test.ts`, or a new `src/daemon/service.*.test.ts`, plus engine-level coverage. No `src/e2e/**` mission fixtures; item 15 owns those.
4. `pnpm check` + `pnpm build` on Node 24.20.0.

## Acceptance checks

1. **Base object untouched:** create runs through `handle("run", ...)` with `off` and then `required`; the base config object's `runtimeValidation.mode` still equals the loaded value afterwards.
2. **Identity:** `getConfig()` returns the same instance as `productionComposition().config`, before and after run creation.
3. **Static pin:** no assignment to `.runtimeValidation` / `.runtimeValidation.mode` in non-test `src/**`.
4. **Per-run visible mode:** driving each run yields that run's mode at `PhaseContext.config`, asserted at the context boundary rather than inside one driver.
5. **Concurrent isolation:** two active runs with different modes driven by one `RunEngine.tick()`, using probe drivers registered via `engine.registerPhase` that read `ctx.config.runtimeValidation.mode`, yield at an `await` boundary, then read again — each observes only its own mode on both sides of the yield.
6. **Creation does not disturb an active run:** create A, drive it, create B with a different mode (which itself triggers a tick), drive A again — A's mode is unchanged throughout.
7. **Completeness:** the resolved run config is deep-equal to the base config except `runtimeValidation.mode`, with `runtimeValidation.level` explicitly asserted.
8. **Default path:** a run created without `runtime` resolves to `"auto"` even when `polish.toml` sets a different mode.
9. **Invalid mode:** rejected before run creation; no run row, no config change.
10. **Post-restart:** a run recovered after restart resolves per MC8, pinned explicitly.
11. **Regression:** item-6 INTEGRATING evidence behavior unchanged; existing runtime, candidate-driver, convergence and daemon suites green.
12. Gates: `pnpm check` + `pnpm build` on Node 24.20.0.

## Anti-fake notes for reviewers

Cheap passes to reject: mutating a constructor-time clone while `getConfig()` returns a pristine object; asserting `facade.json`'s `metadata.runtime`, which is already per-run at base and proves nothing; resolving the mode in INTEGRATING only while `convergenceDrivers.ts:440` still reads the shared object; save-set-restore around the driver await; engine-only tests that never exercise `createRun`.

## Non-goals

Items 8, 9, 11–16; C1–C11; Phase D; `phase-c-accepted`.

## Workspace

`/Users/fedorsvetlov/polish-worktrees/phase-c/B-selfhost-7/`.

## Freeze protocol

Draft `6157eb428ad98f351a84a7345e9a0f0f83a7a04013bb79ccf3dc7b19ab384c76`: Grok FAIL / Claude FAIL — all blocking findings from both incorporated above. **No second contract review round.** Implementation requires 2 clean Grok + Claude code rounds on the final commit.
