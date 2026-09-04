# C3 provenance ledger

Contract: `docs/ledger/C3.md` (immutable after freeze commit).  
Do not treat this file as a second contract.

| Field | Value |
|---|---|
| Status | CLEAN ROUND 1/2 at `0abcf62` — second independent Grok+Claude pair running |
| Contract path | `docs/ledger/C3.md` |
| Contract hash | d8618b8bf39e3db26ced211dac2d56aa1f116a8c8fe85926de7cd542e358a777 |
| Base commit | `8cf0380b0cda8519966a28b68b5a081c981eee5c` |
| HOST | `phase-b-collab-base` `0b21a6182507e9883d020ceba0c39aa4edcfff5b` worktree `/Users/fedorsvetlov/polish-host-b` POLISH_HOME `~/.polish-phase-c-host` |
| Grok candidate | `a9fbc733139c99e25fe263ee7a4f890677713432` on `task/C3-candidate-grok` (blind label P) |
| Composer candidate | `062bc7964d68ef0bfe0ab21c56c1c563112514e4` on `task/C3-candidate-composer` (blind label Q) — rejected |
| Polish candidate / run id | implement `run_01m1pg5466nsksrer6s8x3` FAIL (B-4 GATING→PLANNING duplicate). No candidate commit. |
| Deterministic results | Integration `0abcf62`: Claude `pnpm check` 59 files / 498 tests on Node 24.20.0. |
| Selection | **P** (`a9fbc73`). [compare A](f12bf60d-d3c0-4d4d-900b-2b5becebfba9) and [compare B](966063d4-c4c6-4b10-82e4-7f09a1b824e8) both recommend P. Q disqualified on VALID cost/secrets. Not spliced. |
| Integration commit | `0abcf62e8d277481dfb34aa8a047a9c40f4e8c50` on `task/C3-integration` (`b539613` + close-after-COMPARING). Fix lane `693e319792df88d038b7ed26818997ba5fb9b48e` on `task/C3-fix-4`. |
| Polish verification runs | `run_01m1pkbnxz53215q9n0b3m` **FAIL** (same B-4: GATING→PLANNING duplicate ×5, 0 completed tasks). TARGET unchanged at `a9fbc73`. Not a C3 code finding; not a clean round. |
| Grok review | **PASS** at `0abcf62` (C3-R2-B1 closed; no new blocking VALID). Residual zombie for one tick after `kill()` without wait — rejected as blocking. |
| Claude review | **PASS** at `0abcf62` (C3-R2-B1 closed; no blocking VALID). Control: skip `close()` → event loop hangs with ChildProcess handles. Non-blocking: test does not assert loop drain; `childPid` production getter; prototype mutation in test; `close()` throw would mask success (theoretical). |
| Composer review | historical only — **FAIL** (blocking VALID, independently reproduced). Not used again. |
| Findings | **No blocking VALID at `0abcf62`.** Round-1 Grok+Claude both PASS. C3-1, BLOCK-1/2, MC5, C3-R2-B1 closed. **VALID non-blocking:** B1/B-11 OPEN; B2; C3-6 pip; C3-7 MatchEvidence; unreaped temp cwd; ENV_PROBE; stderr unread; id:null; EPIPE on large stdin (pre-existing, UNCERTAIN). |
| Fix rounds | 4 landed (`693e319` / integration `0abcf62`). Independent Grok+Claude reviews of the **new** commit. |
| Clean rounds | 1/2 (Grok+Claude PASS on `0abcf62`, no code change since). Second pair running; do not accept C3 yet. |
| Accepted commit | |
| Trusted capabilities added | none yet (C3 must not be used to accept C3) |
