# C3 provenance ledger

Contract: `docs/ledger/C3.md` (immutable after freeze commit).  
Do not treat this file as a second contract.

| Field | Value |
|---|---|
| Status | CLEAN ROUND 2 disputed — Claude FAIL (B1/B2); coordinator does **not** open fix-3 (unsatisfiable triangle). Grok round-2 still running. |
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
| Grok review | **PASS** at `c05642b` (BLOCK-1/2 closed; no new blocking VALID). Non-blocking: provenance `client` is configured intent not actual judge; `isDiscriminatingSelection` spoofable with non-scripted CLIENT; ambient `ALLOW_LIVE`/`CLIENT` not stripped; `options.env` bypasses SECRET_ENV. |
| Claude review | Round 1 **PASS** at `c05642b`. Round 2 **FAIL** (B1 sidecar never decides in production; B2 two-stage only on stub). Coordinator: facts VALID, **blocking REJECTED** — see Findings. |
| Composer review | historical only — **FAIL** (blocking VALID, independently reproduced). Not used again. |
| Findings | Round-2 Claude B1/B2 **facts VALID, blocking REJECTED** (no fix-3). **B1:** default `backend=sidecar` + injected scripted + empty PREFER ⇒ `scriptedWithoutPreference` always true ⇒ TS `PairwiseJudge` is the only free production decider. That is the honest BLOCK-1 fix, not a new hole. Treating it as blocking reopens an unsatisfiable triangle: MC5 (no paid default) + MC6 (stub must not rank by metrics) + BLOCK-1 (must not claim PPT on uniform 0.5). Acceptance 1 and PHASE_REQUIRED 6 require VerifierAdapter **with** TS fallback so offline/scripted runs still compare. Acceptance 5 requires PPT proven on the **scripted fixture** (PREFER in `options.env`), which tests do. B-11 row: TS fallback may stay provider-less and **B-11 remains OPEN**. Forbidden shortcut targets claiming C3 complete while `createComparingDriver()` still constructs `new PairwiseJudge()` as the strategy — production constructs `VerifierAdapter`; PairwiseJudge is fallback. Round-1 Claude already classified “default path never ppt” as non-blocking. **B2:** two-stage only on fixture. PHASE_REQUIRED 5 and acceptance 6 require fixture-tested two-stage, not a live-wrapped `TwoStageClient`. Keep as C3-2 non-blocking. **Still VALID non-blocking:** dotenv restore; client field; adapter leak; id:null; pip; MatchEvidence; discarded PPT work. |
| Fix rounds | 2 landed (`96190c8` / integration `c05642b`). Independent Grok+Claude reviews of the **new** commit; reviews of `9e784f6` do not count as a clean round. |
| Clean rounds | 1/2. Round 2 Claude FAIL does not increment; coordinator did not reset to 0/2 (no code change, no new blocking). |
| Accepted commit | |
| Trusted capabilities added | none yet (C3 must not be used to accept C3) |
