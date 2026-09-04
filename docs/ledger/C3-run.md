# C3 provenance ledger

Contract: `docs/ledger/C3.md` (immutable after freeze commit).  
Do not treat this file as a second contract.

| Field | Value |
|---|---|
| Status | FIX ROUND 3 — replacement Claude FAIL on MC5 (ALLOW_LIVE + load_dotenv); isolated fix starting |
| Contract path | `docs/ledger/C3.md` |
| Contract hash | d8618b8bf39e3db26ced211dac2d56aa1f116a8c8fe85926de7cd542e358a777 |
| Base commit | `8cf0380b0cda8519966a28b68b5a081c981eee5c` |
| HOST | `phase-b-collab-base` `0b21a6182507e9883d020ceba0c39aa4edcfff5b` worktree `/Users/fedorsvetlov/polish-host-b` POLISH_HOME `~/.polish-phase-c-host` |
| Grok candidate | `a9fbc733139c99e25fe263ee7a4f890677713432` on `task/C3-candidate-grok` (blind label P) |
| Composer candidate | `062bc7964d68ef0bfe0ab21c56c1c563112514e4` on `task/C3-candidate-composer` (blind label Q) — rejected |
| Polish candidate / run id | implement `run_01m1pg5466nsksrer6s8x3` FAIL (B-4 GATING→PLANNING duplicate). No candidate commit. |
| Deterministic results | Grok PASS 491 tests at `a9fbc73`. Composer PASS 486 (rejected). Fix-2 integration `c05642b`: Claude re-ran typecheck/lint/depcruise/vitest **494/494** + `pnpm build` PASS on Node 24.20.0. |
| Selection | **P** (`a9fbc73`). [compare A](f12bf60d-d3c0-4d4d-900b-2b5becebfba9) and [compare B](966063d4-c4c6-4b10-82e4-7f09a1b824e8) both recommend P. Q disqualified on VALID cost/secrets. Not spliced. |
| Integration commit | `c05642baf16126b6cf8a2dbdd50b85696013c83a` on `task/C3-integration` (`9e784f6` + BLOCK-1/2). Fix lane `96190c8ec7be3b7efda52e8bd24675d168d3e092` on `task/C3-fix-2`. |
| Polish verification runs | `run_01m1pkbnxz53215q9n0b3m` **FAIL** (same B-4: GATING→PLANNING duplicate ×5, 0 completed tasks). TARGET unchanged at `a9fbc73`. Not a C3 code finding; not a clean round. |
| Grok review | Round 1 **PASS** at `c05642b`. Round 2 **PASS** at `c05642b` (no new blocking; default-never-ppt stays non-blocking / B-11 OPEN). |
| Claude review | Round 1 PASS. Round 2 FAIL (B1/B2 blocking REJECTED). Replacement **FAIL** at `c05642b`: BLOCK-C3-1 MC5 (VALID blocking); BLOCK-C3-2 pip and BLOCK-C3-3 MatchEvidence VALID, kept non-blocking. |
| Composer review | historical only — **FAIL** (blocking VALID, independently reproduced). Not used again. |
| Findings | **VALID blocking MC5 (fix-3):** `POLISH_VERIFIER_ALLOW_LIVE` is not in `SIDECAR_TEST_HOOKS`, so ambient env skips scripted inject and calls `create_client()` with no `costEligibility`. Separately, scripted clients set `_llm_verifier_deepseek = True`, so `llm_verifier` `call_deepseek` → `deepseek_reasoning_params()` → `load_dotenv()` on the **default** scoring path; child has no `cwd`, so daemon-cwd `.env` re-enters `os.environ` after `scrubSidecarEnv`. Coordinator reproduced the library hook in PyPI `fine_grained_reward.py`. **Not blocking:** pip-in-`beforeAll` (C3-6; `pnpm` already needs a network install); synthesized MatchEvidence (C3-7; `fallback:true` still honest). B1/B2 stay non-blocking. |
| Fix rounds | 3 starting from `c05642b` (`task/C3-fix-3`). MC5 only. |
| Clean rounds | 0/2 (code change incoming; round 1 at `c05642b` vacated). |
| Accepted commit | |
| Trusted capabilities added | none yet (C3 must not be used to accept C3) |
