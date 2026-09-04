# C3 provenance ledger

Contract: `docs/ledger/C3.md` (immutable after freeze commit).  
Do not treat this file as a second contract.

| Field | Value |
|---|---|
| Status | **ACCEPTED** at `0abcf62` — clean 2/2. Phase C is **not** complete. B-11 remains OPEN. |
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
| Grok review | Round 1 **PASS** at `0abcf62`. Round 2 **PASS** at `0abcf62` (no new blocking VALID). Non-blocking: inherited `PRIVATE_KEY`/`DATABASE_URL` still reach the child (not cost-gate). |
| Claude review | Round 1 **PASS** at `0abcf62`. Round 2 **PASS** at `0abcf62` (no blocking VALID). Non-blocking: granularity no-op on sidecar; cost gate by unreachability; close() of injected strategies; provenance `backend/client` on deterministic short-circuit; `selectFrontier` hardcodes sidecar backend; `sidecars/**` eslint ignore. |
| Composer review | historical only — **FAIL** (blocking VALID, independently reproduced). Not used again. |
| Findings | **No blocking VALID at accepted commit.** Closed: C3-1, BLOCK-1/2, MC5, C3-R2-B1. **Remain OPEN / non-blocking (not C3 blockers):** B-11 (TS fallback still provider-less); default production never PPT (scripted-without-PREFER); B2 two-stage fixture-only; C3-6 pip; C3-7 MatchEvidence; unreaped temp cwd; ENV_PROBE; stderr unread; id:null. Polish HOST verify still FAIL (B-4); not C3 acceptance evidence. |
| Fix rounds | 4 landed (`693e319` / integration `0abcf62`). Independent Grok+Claude reviews of the **new** commit. |
| Clean rounds | 2/2 (Grok+Claude PASS, then Grok+Claude PASS, no code change after `0abcf62`) |
| Accepted commit | `0abcf62e8d277481dfb34aa8a047a9c40f4e8c50` (`task/C3-integration`) |
| Trusted capabilities added | C3 VerifierAdapter / llm-verifier sidecar at `0abcf62`. Must **not** be used as an oracle to accept later C work that this sidecar judged. B-11 not closed. |
