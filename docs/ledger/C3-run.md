# C3 provenance ledger

Contract: `docs/ledger/C3.md` (immutable after freeze commit).  
Do not treat this file as a second contract.

| Field | Value |
|---|---|
| Status | GATES_DONE — blind comparison of two passing candidates |
| Contract path | `docs/ledger/C3.md` |
| Contract hash | d8618b8bf39e3db26ced211dac2d56aa1f116a8c8fe85926de7cd542e358a777 |
| Base commit | `8cf0380b0cda8519966a28b68b5a081c981eee5c` |
| HOST | `phase-b-collab-base` `0b21a6182507e9883d020ceba0c39aa4edcfff5b` worktree `/Users/fedorsvetlov/polish-host-b` POLISH_HOME `~/.polish-phase-c-host` |
| Grok candidate | `a9fbc733139c99e25fe263ee7a4f890677713432` on `task/C3-candidate-grok` (blind label P) |
| Composer candidate | `062bc7964d68ef0bfe0ab21c56c1c563112514e4` on `task/C3-candidate-composer` (blind label Q) |
| Polish candidate / run id | `run_01m1pg5466nsksrer6s8x3` **FAIL**. Workers ran; GATING sent the sidecar task back to PLANNING five times, duplicating the task DAG each time (open B-4). After max attempts the original task is BLOCKED and the run is FAILED. No Polish candidate commit. TARGET still `8cf0380`. |
| Deterministic results | Grok independent `pnpm check`+`build` PASS (59 files / 491 tests). Composer independent `pnpm check`+`build` PASS (60 files / 486 tests; `pretest` pip-installs `llm-verifier` into `.vendor`). Polish: no gated artifact. |
| Selection | pending second blind compare. First compare ([compare B](966063d4-c4c6-4b10-82e4-7f09a1b824e8)) recommends **P**. |
| Integration commit | |
| Polish verification runs | |
| Grok review | |
| Composer review | |
| Findings | **VALID (Q):** default `resolve_client()` uses `LazyClient().get()` when no fixture env is set (`sidecars/llm_verifier/main.py`); production `VerifierAdapter` passes unsanitized `process.env` to the child. Violates C3 MISSION_CRITICAL cost/secrets and scripted-client default. Confirmed against Q source, not only the LLM claim. **VALID (P):** none from this compare. **UNCERTAIN (P):** PPT ignores `pivotTournamentFrom`; default production sidecar has no injected scripted client so COMPARING falls back to TS unless env is set. **REJECTED:** none. |
| Fix rounds | 0 |
| Clean rounds | 0/2 |
| Accepted commit | |
| Trusted capabilities added | none yet (C3 must not be used to accept C3) |
