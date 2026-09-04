# C3 provenance ledger

Contract: `docs/ledger/C3.md` (immutable after freeze commit).  
Do not treat this file as a second contract.

| Field | Value |
|---|---|
| Status | CLEAN ROUND 1/2 at `b539613` — second independent Grok+Claude pair running |
| Contract path | `docs/ledger/C3.md` |
| Contract hash | d8618b8bf39e3db26ced211dac2d56aa1f116a8c8fe85926de7cd542e358a777 |
| Base commit | `8cf0380b0cda8519966a28b68b5a081c981eee5c` |
| HOST | `phase-b-collab-base` `0b21a6182507e9883d020ceba0c39aa4edcfff5b` worktree `/Users/fedorsvetlov/polish-host-b` POLISH_HOME `~/.polish-phase-c-host` |
| Grok candidate | `a9fbc733139c99e25fe263ee7a4f890677713432` on `task/C3-candidate-grok` (blind label P) |
| Composer candidate | `062bc7964d68ef0bfe0ab21c56c1c563112514e4` on `task/C3-candidate-composer` (blind label Q) — rejected |
| Polish candidate / run id | implement `run_01m1pg5466nsksrer6s8x3` FAIL (B-4 GATING→PLANNING duplicate). No candidate commit. |
| Deterministic results | Integration `b539613`: Claude `pnpm check` 496/496 + typecheck/lint/depcruise on Node 24. Fix-2 `c05642b` was 494 tests. |
| Selection | **P** (`a9fbc73`). [compare A](f12bf60d-d3c0-4d4d-900b-2b5becebfba9) and [compare B](966063d4-c4c6-4b10-82e4-7f09a1b824e8) both recommend P. Q disqualified on VALID cost/secrets. Not spliced. |
| Integration commit | `b539613490f30e8c198e0842364a55ed1d80d06b` on `task/C3-integration` (`c05642b` + MC5). Fix lane `3cb2d2f62a487308318dd41f46d0c7bc8600101d` on `task/C3-fix-3`. |
| Polish verification runs | `run_01m1pkbnxz53215q9n0b3m` **FAIL** (same B-4: GATING→PLANNING duplicate ×5, 0 completed tasks). TARGET unchanged at `a9fbc73`. Not a C3 code finding; not a clean round. |
| Grok review | **PASS** at `b539613` (MC5 closed; no new blocking VALID). Non-blocking: unreaped temp cwd; ENV_PROBE in production sidecar; explicit `options.env` ALLOW_LIVE still possible (production does not pass it). |
| Claude review | **PASS** at `b539613` (MC5 closed; no blocking VALID). Non-blocking: ENV_PROBE in production sidecar; unreaped temp cwd; mkdtemp can throw if TMPDIR missing (UNCERTAIN); README live opt-in now unreachable; provenance `client:live` on fallback; ambient PYTHONPATH (pre-existing, ADR-0003). |
| Composer review | historical only — **FAIL** (blocking VALID, independently reproduced). Not used again. |
| Findings | **No blocking VALID at `b539613`.** Round-1 Grok+Claude both PASS. C3-1, BLOCK-1/2, MC5 closed. **VALID non-blocking:** B1 default-never-ppt / B-11 OPEN; B2 two-stage fixture-only; C3-6 pip; C3-7 MatchEvidence; adapter leak; id:null; unreaped temp cwd; ENV_PROBE; README stale live path. |
| Fix rounds | 3 landed (`3cb2d2f` / integration `b539613`). Independent Grok+Claude reviews of the **new** commit. |
| Clean rounds | 1/2 (Grok+Claude PASS on `b539613`, no code change since). Second pair running; do not accept C3 yet. |
| Accepted commit | |
| Trusted capabilities added | none yet (C3 must not be used to accept C3) |
