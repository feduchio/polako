# B-bootstrap-2 — Production daemon/RPC coding E2E on fixture (Stage-1)

**Status:** ACCEPTED (verifier round 1 — zero VALID blocking)

## Per-task BVP

- Implementer: [Daemon fixture coding E2E](55183af7-850a-48b4-be22-d7dbc0f5d976) (Composer)
- Production fix required for DONE: default `runBranch` `polish/${runId}/run` so git can also create `polish/${runId}/candidates/…`
- Deterministic gates: orchestrator `pnpm check` PASS — 48 files / 400 tests
- Verifier: [Verify daemon coding E2E](4b159cfb-b683-4fe8-9c24-0289c070068c) — PASS, `blocking_findings: 0`
- Non-blocking: test assertions thinner than engine B10; `SecretStore` still ingests host `process.env` keys (scripted-only toml did not instantiate live providers)

`blocking_findings: 0`
**Class default:** PHASE_REQUIRED
**Plan:** Fable §15 vertical slice; §17 B9 Daemon+CLI; §17 B10 fixture E2E (DONE path through production composition).
**Prompt:** CLI/RPC → DaemonService → production drivers → ScriptedProvider fixture coding loop. No test-body `catalog.discover()`. No swapped phase drivers.

## Source-plan references

- Fable §15: fixture `fixtures/resume-dup-fetch`, ScriptedProvider, 2 candidates allowed but 1 is fine for bootstrap speed, gates, tournament, integration, reviewers, clean rounds.
- Fable §17 B9: one production composition.
- Fable §17 B10: DONE through production entrypoint (engine-level B10 already exists; this task adds the daemon/RPC path).
- User contract §5 Stage-1 bootstrap criterion.
- User contract §8 production daemon/RPC E2E.

## Phase-B requirement

Production entrypoint must complete this loop on a small fixture:

```
User mission
→ real daemon/RPC (DaemonService.handle / unix socket)
→ project discovery
→ baseline
→ mission interpretation (pinned council from polish.toml)
→ planner decomposition
→ coding task
→ real worker
→ candidate modification
→ gates
→ integration
→ review
→ finding validation
→ convergence decision
```

Existing `src/e2e/b10.test.ts` is engine-level and calls `catalog.discover()` in the test helper. Keep it. This task adds a **daemon-level** path that does not.

## Global invariants

- Config/secrets stay outside the repo; tests use temp HOME + fake credentials.
- Do not read the developer's `~/.polish/secrets.env`.
- Isolate the test from host `process.env` `*_API_KEY` / `*_TOKEN` so a developer key cannot instantiate a live provider (do not redesign SecretStore globally unless required; prefer test-local env isolation and a toml that only enables `scripted`).
- Do not implement Phase C.
- Do not replace production phase drivers.
- Do not call `catalog.discover()` from the test body (production DISCOVERING_MODELS may discover internally).
- FSM order stays INTERPRETING_MISSION → DISCOVERING_MODELS → PLANNING.

## Required behavior

1. New (or extended) daemon-level test using `fixtures/resume-dup-fetch` copied into a temp git repo.
2. Temp polish home with `polish.toml`:
   - scripted provider only (models for pinned council + worker);
   - pinned `supervisors` for planner / scope_guardian / judge;
   - cheap convergence (1 clean round / 1 reviewer / 1 candidate) via toml or daemon `requiredCleanRounds` — must still go through production convergence driver, not a stub.
3. `DaemonService` constructed with that home (production `loadPolishConfig` + `installProductionDrivers`). Script worker replies by mutating the ScriptedProvider loaded from config, not by injecting `options.providers` that bypass config (config-loaded scripted is required).
4. Start via `service.handle("run", …)` (RPC handler). Driving additional ticks via `engine.tickRun` is allowed after start; do not construct a second RunEngine.
5. Prove with store/events (not by trusting DONE alone):
   - `project.discovered`
   - `baseline.snapshotted`
   - `mission.interpreted`
   - at least one coding `task.created`
   - at least one real worker/candidate path (`candidate.created` / implemented commit)
   - source on the candidate/run branch actually changed vs baseline
   - gates ran
   - integration advanced checkpoint ≠ baseline
   - review execution(s) exist for that checkpoint
   - run reaches a convergence decision: `DONE`, or `NEEDS_HUMAN`/`FAILED` only if anti-fake-DONE legitimately fired — for this happy-path fixture the expected terminal is **DONE** (same bugfix as B10 positive path).
6. If ScriptedProvider worker cannot apply the real fixture fix in this task without a huge script, a **minimal deterministic worker script that edits the known buggy file the same way B10 does** is allowed. Copy proven B10 worker scripting; do not invent a second orchestration engine.

## Forbidden shortcuts

- `new RunEngine()` as the only E2E (engine B10 already exists).
- `catalog.discover()` in the test body.
- Replacing production drivers / inserting fake clean rounds.
- Injecting `options.providers` so toml-loaded providers are skipped (this would un-test config wiring).
- Claiming Stage-1 done if the run never leaves PLANNING/EXECUTING.
- Implementing remaining Stage-2 items (checkpoint checkout, multi-task DONE, budgets, real-provider, self-host).

## Deterministic evidence

- Targeted vitest for the new daemon fixture E2E.
- `pnpm check` green.
- No secrets in git or assertions.

## Cross-module invariants

- Reuse production composition from B-bootstrap-1.
- Host/target split is NOT this task; this is still a fixture in temp dir.
- B10 engine tests must remain green.
