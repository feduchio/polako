# C3 provenance ledger

Contract: `docs/ledger/C3.md` (immutable after freeze commit).  
Do not treat this file as a second contract.

| Field | Value |
|---|---|
| Status | FIX ROUND 4 — Grok PASS on `0abcf62`; Claude review still running |
| Contract path | `docs/ledger/C3.md` |
| Contract hash | d8618b8bf39e3db26ced211dac2d56aa1f116a8c8fe85926de7cd542e358a777 |
| Base commit | `8cf0380b0cda8519966a28b68b5a081c981eee5c` |
| HOST | `phase-b-collab-base` `0b21a6182507e9883d020ceba0c39aa4edcfff5b` worktree `/Users/fedorsvetlov/polish-host-b` POLISH_HOME `~/.polish-phase-c-host` |
| Grok candidate | `a9fbc733139c99e25fe263ee7a4f890677713432` on `task/C3-candidate-grok` (blind label P) |
| Composer candidate | `062bc7964d68ef0bfe0ab21c56c1c563112514e4` on `task/C3-candidate-composer` (blind label Q) — rejected |
| Polish candidate / run id | implement `run_01m1pg5466nsksrer6s8x3` FAIL (B-4 GATING→PLANNING duplicate). No candidate commit. |
| Deterministic results | Integration `b539613`: Claude `pnpm check` 496/496 + typecheck/lint/depcruise on Node 24. Fix-2 `c05642b` was 494 tests. |
| Selection | **P** (`a9fbc73`). [compare A](f12bf60d-d3c0-4d4d-900b-2b5becebfba9) and [compare B](966063d4-c4c6-4b10-82e4-7f09a1b824e8) both recommend P. Q disqualified on VALID cost/secrets. Not spliced. |
| Integration commit | `0abcf62e8d277481dfb34aa8a047a9c40f4e8c50` on `task/C3-integration` (`b539613` + close-after-COMPARING). Fix lane `693e319792df88d038b7ed26818997ba5fb9b48e` on `task/C3-fix-4`. |
| Polish verification runs | `run_01m1pkbnxz53215q9n0b3m` **FAIL** (same B-4: GATING→PLANNING duplicate ×5, 0 completed tasks). TARGET unchanged at `a9fbc73`. Not a C3 code finding; not a clean round. |
| Grok review | **PASS** at `0abcf62` (C3-R2-B1 closed; no new blocking VALID). Residual zombie for one tick after `kill()` without wait — rejected as blocking. |
| Claude review | prior FAIL at `b539613` (C3-R2-B1). **New review running** on `0abcf62`. |
| Composer review | historical only — **FAIL** (blocking VALID, independently reproduced). Not used again. |
| Findings | **C3-R2-B1 treated closed on `0abcf62` pending Claude.** Grok PASS: `try/finally` covers all post-create paths; real child dies; two COMPARING do not leak; double-close idempotent. **Still VALID non-blocking:** B1/B-11 OPEN; B2; C3-6; C3-7; unreaped temp cwd; ENV_PROBE; stderr unread; id:null. |
| Fix rounds | 4 landed (`693e319` / integration `0abcf62`). Independent Grok+Claude reviews of the **new** commit. |
| Clean rounds | 0/2 (vacated by fix-4). |
| Accepted commit | |
| Trusted capabilities added | none yet (C3 must not be used to accept C3) |
