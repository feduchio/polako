# B-selfhost-5 — Review and evidence must use an isolated checkpoint checkout

**Status:** FROZEN CONTRACT — not implemented, not accepted  
**Class:** PHASE_REQUIRED with MISSION_CRITICAL invariants below  
**Exact base:** `fd8a99c402656f7fe3aa6dc02377cc76713ab411` (accepted B-selfhost-3; `task/B-selfhost-3-integration`)  
**Source finding:** `docs/ledger/B-selfhost-remaining.md` item **5**  
**Plan:** Phase-C pause; stronger HOST = accepted B-selfhost-3

Not Fable §17 B5 (finding validator — already ACCEPTED). After freeze, do not rewrite this file to make a candidate pass.

## Authority and trusted inputs

1. `docs/ledger/B-selfhost-remaining.md` §5: Review/evidence use `projectPath` (user checkout), not isolated checkout of `checkpointHash`.
2. Accepted B4 review swarm + B5 residue: `ProjectFindingEvidenceWorker` runs in `projectPath`.
3. Exact base: REVIEWING uses `projectPath` for artifact + `repositoryRoot`; VALIDATING default worker uses `projectPath`; GATING already uses `sandbox.create({ baseCommit })`.
4. Items 6–9, 11–15 out of scope except the item-6 **boundary** below. Full B closure **DEFERRED_BY_USER**.

## Defect (normative)

REVIEWING/VALIDATING bind evidence to the user checkout, which is often a **clean** tree at baseline while `currentCheckpointHash` / `finding.checkpointHash` is the integrated commit.

## Definitions (normative)

- **Checkpoint checkout:** disposable `SandboxHandle` from `sandbox.create({ id, baseCommit: targetHash, policy })` whose working tree path is used as cwd/`repositoryRoot`. `HEAD` must equal `targetHash`. Path realpath must not equal `run.projectPath`.
- **User checkout:** `ctx.run.projectPath` — forbidden as reproduction cwd or REVIEWING `repositoryRoot` on production paths.
- **Target hash (REVIEWING):** `ctx.run.currentCheckpointHash`.
- **Target hash (VALIDATING):** `finding.checkpointHash`.

## Item-6 boundary (normative)

- **In scope:** `ProjectFindingEvidenceWorker.tryRuntime` / `tryFailingTest` / `bindNodeScenario` / `runProcess` cwd and discovery rooted at the checkpoint checkout of `finding.checkpointHash`.
- **Out of scope:** `resolveRuntimeEvidence`, `validateRuntimeIfNeeded` evidence-drop, templates from `project.discovered`, fake `"0".repeat(40)` hash (item 6 itself).

## MISSION_CRITICAL invariants

1. **REVIEWING `repositoryRoot`.** Production `createReviewingDriver` MUST pass `runAxisReview.repositoryRoot` = checkpoint-checkout path for the target hash. Evidence path checks use that tree (realpath files under that root), **not** `git show`/blob reads from the user repo as a substitute for isolation, and **not** `run.projectPath`.
2. **REVIEWING artifact git reads.** Prefer running `buildCheckpointReviewArtifact` git operations with cwd/repo = the same checkpoint checkout. Diff must remain commit-to-commit (parent/baseline → checkpoint) and must not treat uncommitted user dirt as checkpoint content. Do not leave a carve-out that lets today’s `projectPath`-based artifact builder count as “done” without also satisfying invariant 1.
3. **VALIDATING reproduction.** Production default evidence worker (wired when `resolveWorker` is omitted) MUST use checkpoint checkout of `finding.checkpointHash` for `runProcess` cwd, runtime discovery, and scenario `projectPath`/`fixtureRoot`. Still must not edit product code.
4. **No silent `projectPath` default.** `installProductionDrivers` / composition MUST inject the same Sandbox (or checkout factory) into REVIEWING and VALIDATING that GATING uses. Zero-option / missing sandbox MUST fail closed (recorded error / UNCERTAIN / failExecution) and MUST NOT construct `ProjectFindingEvidenceWorker({ projectPath: run.projectPath })` or pass `repositoryRoot: run.projectPath`. Existing tests that default-constructed drivers may be amended to inject fakes.
5. **Environment ≠ reproduction.** In a checkpoint checkout, command-not-found, missing installed dependencies, or failure before the test runner starts ⇒ `UNCERTAIN` with recorded reason, **never** `VALID`. Non-zero exit after a real test runner started may still be VALID per B5. Acceptance must include: checkout without deps → UNCERTAIN, not VALID.
6. **Lifecycle.** Unique checkout `id` per attempt; destroy in `finally`. Reuse-or-prune stale dirs so `CONFLICT` cannot brick the phase forever. Create failure: fail closed observably (failExecution + bounded wait or phase error / NEEDS_HUMAN) — **not** indefinite `{status:"waiting"}` with no recorded failure, and **not** silent fallback to `projectPath`.
7. **No user-tree mutation.** No reset/stash/checkout of `run.projectPath`. CODE_CHANGING_PHASES = INTEGRATING only.
8. **No scope creep.** No item 6–9/11–15 fixes beyond the boundary; no C-tasks; no FSM widening; Composer unused; no live/paid acceptance.
9. **Deterministic acceptance only.**

## PHASE_REQUIRED surface

1. Wire sandbox into production REVIEWING + VALIDATING; implement invariants 1–6.
2. Tests below; `pnpm check` + `pnpm build` Node 24.20.0.

## Deterministic acceptance checks

1. **Clean wrong-HEAD (REVIEWING):** `projectPath` clean at commit ≠ H; file exists only at user HEAD; evidence path for that file must not validate as present on checkpoint H. File present only at H must be visible via `repositoryRoot` checkout. Assert `repositoryRoot` realpath ≠ `projectPath` and `HEAD==H`.
2. **Clean wrong-HEAD (VALIDATING failing-test):** same polarity — dirty-only is insufficient; clean wrong HEAD must not make reproduce VALID from user-only content.
3. **Runtime bind on checkout:** `tryRuntime` scenario path/discovery uses checkout of H (wrong-HEAD user tree must not supply the only fixture). Do not change item-6 functions.
4. **Missing deps → UNCERTAIN:** evidence attempt on checkout without installed deps → UNCERTAIN, not VALID.
5. **No projectPath default:** with production composition wiring (or driver constructed as composition does) missing sandbox ⇒ never runs process/evidence rooted at `projectPath`. With sandbox present, default worker (no `resolveWorker`) uses checkout.
6. **Destroy:** checkout handle used as `repositoryRoot`/cwd is destroyed in `finally` (spy).
7. **Create failure observable:** repeated create failure does not silent-fallback and does not hang forever without a recorded failure.
8. Named suites green after any needed inject amendments; GATING unchanged in spirit.
9. `pnpm check` + `pnpm build` Node 24.20.0; no live/paid calls.

## Explicit non-goals

- Item 6 proper, 7–9, 11–15; C1–C11; Phase D; `phase-c-accepted`.
- Full monorepo install strategy beyond “UNCERTAIN if deps missing” (unless a tiny checkout prepare is needed for a green happy-path test with a fixture that vendors deps).
- Live Polish dogfood as required acceptance.

## Implementation workspace

`/Users/fedorsvetlov/polish-worktrees/phase-c/B-selfhost-5/` + `OWNERSHIP.json`.

## Contract-review and acceptance authority

- Reviewed draft hash `46fdbab1c80300d35bc8b0ab4dba2322c2bba63d6a799d27fa69aca3e6584e0f`: Grok **FAIL** (4), Claude **FAIL** (4). All blocking incorporated. **No second Claude contract review.**
- Implementation: 2 clean Grok+Claude code rounds. Composer unused.
