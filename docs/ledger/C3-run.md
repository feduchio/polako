# C3 provenance ledger

Contract: `docs/ledger/C3.md` (immutable after freeze commit).  
Do not treat this file as a second contract.

| Field | Value |
|---|---|
| Status | FIX ROUND 1 landed — awaiting independent Grok+Claude review of new integration commit |
| Contract path | `docs/ledger/C3.md` |
| Contract hash | d8618b8bf39e3db26ced211dac2d56aa1f116a8c8fe85926de7cd542e358a777 |
| Base commit | `8cf0380b0cda8519966a28b68b5a081c981eee5c` |
| HOST | `phase-b-collab-base` `0b21a6182507e9883d020ceba0c39aa4edcfff5b` worktree `/Users/fedorsvetlov/polish-host-b` POLISH_HOME `~/.polish-phase-c-host` |
| Grok candidate | `a9fbc733139c99e25fe263ee7a4f890677713432` on `task/C3-candidate-grok` (blind label P) |
| Composer candidate | `062bc7964d68ef0bfe0ab21c56c1c563112514e4` on `task/C3-candidate-composer` (blind label Q) — rejected |
| Polish candidate / run id | implement `run_01m1pg5466nsksrer6s8x3` FAIL (B-4 GATING→PLANNING duplicate). No candidate commit. |
| Deterministic results | Grok PASS 491 tests. Composer PASS 486 tests. Integration (P) `pnpm check`+`build` PASS 491 tests at `a9fbc73`. |
| Selection | **P** (`a9fbc73`). [compare A](f12bf60d-d3c0-4d4d-900b-2b5becebfba9) and [compare B](966063d4-c4c6-4b10-82e4-7f09a1b824e8) both recommend P. Q disqualified on VALID cost/secrets. Not spliced. |
| Integration commit | `9e784f6459a67c3bddfd2a5606dc72a6464fdfef` on `task/C3-integration` (`a9fbc73` + C3-1). Fix lane `20e73bb92fdd355d25171fc470e2acdaee934189` on `task/C3-fix-1`. |
| Polish verification runs | `run_01m1pkbnxz53215q9n0b3m` **FAIL** (same B-4: GATING→PLANNING duplicate ×5, 0 completed tasks). TARGET unchanged at `a9fbc73`. Not a C3 code finding; not a clean round. |
| Grok review | prior: no blocking VALID at `a9fbc73`. **New review running** on `9e784f6`. |
| Claude review | prior: **FAIL** at `a9fbc73` (C3-1). **New review running** on `9e784f6`. | |
| Composer review | historical only — **FAIL** (blocking VALID, independently reproduced). Not used again. |
| Findings | **VALID blocking C3-1:** default production sidecar never scores. Reproduced: venv health=true, no `POLISH_VERIFIER_CLIENT` → protocol error `no verifier client configured` → `selectFrontier method=pairwise fallback=true`. Claude: FAIL. Historical Composer: FAIL. Grok: not blocking (MC5 fail-closed). Coordinator: **VALID blocking** — MC5 requires injected/scripted client on default/test paths; tests inject it, production `createVerifierStrategy` does not. B-11 row: bare `PairwiseJudge` remains the only reachable production decider. **VALID non-blocking:** C3-2 two-stage only on fixture client; C3-3 inert knobs; C3-4 adapter never `close()`; C3-5 `"id": null` on exceptions; C3-6 `pnpm check` may pip-install; C3-7 synthesized PPT MatchEvidence. **UNCERTAIN C3-8:** test hooks in production sidecar. Out of fix-round-1 scope except C3-1 + a regression test that default adapter (no test-only env) gets PPT/`fallback=false`. |
| Fix rounds | 1 landed (`20e73bb` / integration `9e784f6`). Independent Grok+Claude reviews of the **new** commit; prior reviews of `a9fbc73` do not count. |
| Clean rounds | 0/2 |
| Accepted commit | |
| Trusted capabilities added | none yet (C3 must not be used to accept C3) |
