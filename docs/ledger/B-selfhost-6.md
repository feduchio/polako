# B-selfhost-6 — Production runtime validation must persist checkpoint-bound evidence

**Status:** FROZEN CONTRACT — not implemented, not accepted  
**Class:** PHASE_REQUIRED with MISSION_CRITICAL invariants  
**Exact base:** `916f7f26df1b7490d35289781a4e799d7cd8e7ed` (accepted B-selfhost-5)  
**Source finding:** `docs/ledger/B-selfhost-remaining.md` item **6**

Not item 7 (shared `config.runtimeValidation.mode` mutation). Not item 15 (daemon/RPC/`src/e2e` required happy-path fixture mission). After freeze, do not rewrite.

## Authority

1. Finding 6: templates on `project.discovered`; `validateRuntimeIfNeeded` drops evidence; `resolveRuntimeEvidence` uses fake hash and is unused on INTEGRATING.
2. Exact base behavior as in candidateDrivers `validateRuntimeIfNeeded` + composition `resolveRuntimeEvidence` / discovering project.
3. B-selfhost-5 accepted. Items 7–9, 11–15 out of scope. Full B **DEFERRED_BY_USER**.

## Defect

Integrate-time runtime validation does not persist honest checkpoint-bound evidence; template source ignores discovery; fake-hash helper remains exported.

## Definitions (normative)

- **Production runtime path:** INTEGRATING `afterGates` → `validateRuntimeIfNeeded` (or renamed successor) when `mode ∈ {auto, required}`.
- **Item-15 boundary:** this task’s tests are unit/driver-level with in-memory Store; must not add `src/e2e/**` mission fixtures or daemon/RPC runs. Item 15 owns those.
- **Honest hash:** the integrated commit string passed into validation (never `"0".repeat(40)`).

## MISSION_CRITICAL

1. **Template precedence.** On the production path: (a) `discoverProjectRuntime(checkoutDir)` if it yields templates — authoritative; else (b) `project.discovered.runtimeTemplates` for the run; never corpus-only when (a) or (b) has templates. Corpus templates may supplement but must not be the sole source when discovery recorded templates.
2. **Persist on the hook.** When a validator runs any scenario on the production path, `validateRuntimeIfNeeded` (same call stack as INTEGRATING) MUST call `recordRuntimeEvidence` (or equivalent) with `expectedCheckpointHash === integratedCommit` for each executed scenario’s evidence before returning. Side helpers alone do not satisfy this.
3. **Fake-hash elimination.** Delete `resolveRuntimeEvidence` and its public export, **or** give it a required `checkpointHash: string` with no zero default. Grep of non-test `src/**` must find no `checkpointHash: "0".repeat(40)` (or 40-zero literal used as checkpointHash).
4. **Mode polarity (preserve base integrate blocking).**  
   - `off` → skip, return allow.  
   - `auto` → run when templates+validator exist; **persist**; failed evidence still fails integrate (`afterGates` false) as today — do not “soft-pass” integrate on failed auto evidence.  
   - `required` → fail closed if no templates/validator; persist on executed scenarios; failed evidence fails integrate.
5. **Checkout cwd.** Scenario fixtureRoot/projectPath = integration checkout dir.
6. **Convergence.** Persisted entries must be visible to corpus/`runtimeEvidenceAllowsDone` for that hash (via CONVERGENCE_CHECK or exported helper).
7. **No scope creep.** No item 7/15/C-tasks/FSM widening/Composer/live-paid.

## PHASE_REQUIRED

1. Implement MC1–6 on INTEGRATING path; fix/delete fake-hash helper.  
2. Tests in `src/engine/candidate-drivers.test.ts` and/or new `src/engine/runtime-validation*.test.ts` plus `src/runtime/runtime.test.ts` / convergence-driver coverage as needed.  
3. `pnpm check` + `pnpm build` Node 24.20.0.

## Acceptance checks

1. **auto + discovered templates:** INTEGRATING validation persists `RuntimeEvidence` with honest `checkpointHash`; assert record happened on the integrate hook path.  
2. **required + pass:** same persist with honest hash.  
3. **Empty corpus + non-empty `project.discovered.runtimeTemplates`:** still runs (fallback).  
4. **Checkout overrides stale discovery:** winner checkout has different `runtime/` set than run-start discovery → production uses checkout discovery.  
5. **required + no templates:** integrate fails closed.  
6. **auto + failed evidence:** integrate does not advance (failed_runtime / afterGates false); evidence still persisted.  
7. **Fake hash gone:** `resolveRuntimeEvidence` deleted or requires hash; no zero-hash bind in non-test src.  
8. **Convergence sees evidence:** CONVERGENCE_CHECK / corpus read for that hash reflects the entry.  
9. Suites: candidate-drivers, runtime, convergence-drivers (as touched) green; `pnpm check` + `pnpm build`.

## Non-goals

Item 7, 8, 9, 11–15; C1–C11; Phase D; `phase-c-accepted`.

## Workspace

`/Users/fedorsvetlov/polish-worktrees/phase-c/B-selfhost-6/`.

## Freeze protocol

Draft `d098000ff96ef6ed1b0cb63a20d6c215abef415b8b961b2f1ccbf22c18cc4151`: Grok FAIL / Claude FAIL — all blocking incorporated. **No second Claude contract review.** Impl: 2 clean Grok+Claude code rounds.
