# C3 provenance ledger

Contract: `docs/ledger/C3.md` (immutable after freeze commit).  
Do not treat this file as a second contract.

| Field | Value |
|---|---|
| Status | FIX ROUND 2 — Grok PASS on `c05642b`; Claude review still running |
| Contract path | `docs/ledger/C3.md` |
| Contract hash | d8618b8bf39e3db26ced211dac2d56aa1f116a8c8fe85926de7cd542e358a777 |
| Base commit | `8cf0380b0cda8519966a28b68b5a081c981eee5c` |
| HOST | `phase-b-collab-base` `0b21a6182507e9883d020ceba0c39aa4edcfff5b` worktree `/Users/fedorsvetlov/polish-host-b` POLISH_HOME `~/.polish-phase-c-host` |
| Grok candidate | `a9fbc733139c99e25fe263ee7a4f890677713432` on `task/C3-candidate-grok` (blind label P) |
| Composer candidate | `062bc7964d68ef0bfe0ab21c56c1c563112514e4` on `task/C3-candidate-composer` (blind label Q) — rejected |
| Polish candidate / run id | implement `run_01m1pg5466nsksrer6s8x3` FAIL (B-4 GATING→PLANNING duplicate). No candidate commit. |
| Deterministic results | Grok PASS 491 tests. Composer PASS 486 tests. Integration (P) `pnpm check`+`build` PASS 491 tests at `a9fbc73`. |
| Selection | **P** (`a9fbc73`). [compare A](f12bf60d-d3c0-4d4d-900b-2b5becebfba9) and [compare B](966063d4-c4c6-4b10-82e4-7f09a1b824e8) both recommend P. Q disqualified on VALID cost/secrets. Not spliced. |
| Integration commit | `c05642baf16126b6cf8a2dbdd50b85696013c83a` on `task/C3-integration` (`9e784f6` + BLOCK-1/2). Fix lane `96190c8ec7be3b7efda52e8bd24675d168d3e092` on `task/C3-fix-2`. |
| Polish verification runs | `run_01m1pkbnxz53215q9n0b3m` **FAIL** (same B-4: GATING→PLANNING duplicate ×5, 0 completed tasks). TARGET unchanged at `a9fbc73`. Not a C3 code finding; not a clean round. |
| Grok review | **PASS** at `c05642b` (BLOCK-1/2 closed; no new blocking VALID). Non-blocking: provenance `client` is configured intent not actual judge; `isDiscriminatingSelection` spoofable with non-scripted CLIENT; ambient `ALLOW_LIVE`/`CLIENT` not stripped; `options.env` bypasses SECRET_ENV. |
| Claude review | **FAIL** at `9e784f6` (BLOCK-1/2). **New review running** on `c05642b`. |
| Composer review | historical only — **FAIL** (blocking VALID, independently reproduced). Not used again. |
| Findings | **BLOCK-1/2 treated closed on `c05642b` pending Claude.** Grok PASS. Coordinator already reproduced metric-informed pairwise fallback + ambient PREFER stripped. **Still open non-blocking:** C3-2..C3-7; Grok extras: client field is intent; spoofable unique-max on non-scripted CLIENT; ambient ALLOW_LIVE/CLIENT not stripped. |
| Fix rounds | 2 landed (`96190c8` / integration `c05642b`). Independent Grok+Claude reviews of the **new** commit; reviews of `9e784f6` do not count as a clean round. |
| Clean rounds | 0/2 |
| Accepted commit | |
| Trusted capabilities added | none yet (C3 must not be used to accept C3) |
