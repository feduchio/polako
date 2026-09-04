# C3 provenance ledger

Contract: `docs/ledger/C3.md` (immutable after freeze commit).  
Do not treat this file as a second contract.

| Field | Value |
|---|---|
| Status | FIX ROUND 4 — clean-round-2 Claude FAIL (sidecar process leak / daemon cannot SIGTERM); isolated fix starting |
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
| Claude review | Round 1 **PASS** at `b539613`. Round 2 **FAIL** — C3-R2-B1 production COMPARING leaks one Python child per phase; `close()` only in tests; `runDaemon` SIGTERM never `process.exit()`, child handles keep the loop alive. |
| Composer review | historical only — **FAIL** (blocking VALID, independently reproduced). Not used again. |
| Findings | **VALID blocking C3-R2-B1 (fix-4):** coordinator confirmed `createComparingDriver` never `close()`s `VerifierAdapter`; only tests call `close()`. `runDaemon` stop path sets `exitCode` and waits for the loop; spawned children are not `unref()`d. Distinct from unreaped temp cwd. PHASE_REQUIRED 2 wants a persistent child, not an accumulating one. **Not blocking this round:** stderr pipe deadlock; inert knobs; SIGTERM-only kill; id:null. B1/B-11 stay OPEN. |
| Fix rounds | 4 starting from `b539613` (`task/C3-fix-4`). Close adapter after COMPARING only. |
| Clean rounds | 0/2 (vacated by fix-4). |
| Accepted commit | |
| Trusted capabilities added | none yet (C3 must not be used to accept C3) |
