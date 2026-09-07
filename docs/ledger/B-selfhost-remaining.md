# Remaining Phase-B findings for self-host (not deferred, not optional)

These are VALID composition defects reproduced in the Phase-B re-anchor chat. They stay Phase B. They are **not** implemented as C1–C11.

Use as Mission Acceptance Corpus / explicit contracts for the self-host mission. Do not treat a previous PASS ledger as proof.

## Launch blockers (must not skip)

1. **User-pinned Supervisor Council** — ACCEPTED with host pins in `~/.polish/polish.toml`.
2. **Bounded discovery + probe INCONCLUSIVE + agent.maxTurns** — ACCEPTED, `docs/ledger/B-bootstrap-discovery.md`.
2b. **Cost eligibility + production reviewer routing** — ACCEPTED, `docs/ledger/B-bootstrap-cost-eligibility.md`. Finding 10 (`listModels()[0]`) lifted here.

## Remaining composition defects (self-host dogfood)

Full Phase-B self-host closure is **DEFERRED_BY_USER** until operator observability/resilience is mature enough for multi-hour unattended work. These items remain OPEN. They are not optional and are not fixed.

3. Multi-task DONE: `assertCodeChangeMissionMayComplete` does not require every required task terminal; after first integration FSM goes to REVIEWING.
4. ~~Planning re-entry duplicates original tasks (`createPlanningDriver` always full decompose).~~ — **ACCEPTED** as `docs/ledger/B-selfhost-4.md` at `84f2f7ef55f4d97e7936b5e7d775bba358f60c90`.
5. Review/evidence use `projectPath` (user checkout), not isolated checkout of `checkpointHash`.
6. Runtime templates live in `project.discovered`; `validateRuntimeIfNeeded` drops evidence; `resolveRuntimeEvidence` uses a fake checkpoint hash and is not the production path.
7. `createRun` mutates shared `config.runtimeValidation.mode` (concurrent-run leak).
8. `--budget-tokens` / `--budget-usd` stored in facade metadata; `applyRunBudgetOverrides` unused; Option A hard caps required (not C2).
9. Candidate provenance is `worker/candidate-N`.
10. ~~Reviewer selection is `provider.listModels()[0]`~~ — lifted to bootstrap cost eligibility (Router + explicit `ReviewProvider`).
11. Production tournament `new PairwiseJudge()` with no provider → heuristic-only on a non-dominated frontier.
12. Crash recovery restores scheduler jobs only (not run settings, catalog rediscover, per-run budget, runtime mode).
13. B10 NEEDS_HUMAN / STOP-RESUME / crash through DaemonService/RPC coding composition (engine/RPC round-trips exist; daemon coding E2E is DONE-only).
14. Controlled **real-provider coding** E2E + RecordReplay (B11 recorded probes only).
15. Runtime=required happy path on a safe fixture with persisted corpus identity.

## Out of scope (Phase C — do not implement)

C1 simplification pass, C2 pathology/adaptive budget, C3 Python llm-verifier sidecar, C4 Prosecutor/Defender, C5 CodeGraph native, C6 interactive NEEDS_HUMAN answer, C7 scouts, C8 Model Audition, C9 GC/doctor beyond a B fix, C10 sandbox-exec, C11 browser/RN runtime.
