# C3 provenance ledger

Contract: `docs/ledger/C3.md` (immutable after freeze commit).  
Do not treat this file as a second contract.

| Field | Value |
|---|---|
| Status | INTEGRATION — Grok review clean of blocking; Claude review running; injection finding disputed |
| Contract path | `docs/ledger/C3.md` |
| Contract hash | d8618b8bf39e3db26ced211dac2d56aa1f116a8c8fe85926de7cd542e358a777 |
| Base commit | `8cf0380b0cda8519966a28b68b5a081c981eee5c` |
| HOST | `phase-b-collab-base` `0b21a6182507e9883d020ceba0c39aa4edcfff5b` worktree `/Users/fedorsvetlov/polish-host-b` POLISH_HOME `~/.polish-phase-c-host` |
| Grok candidate | `a9fbc733139c99e25fe263ee7a4f890677713432` on `task/C3-candidate-grok` (blind label P) |
| Composer candidate | `062bc7964d68ef0bfe0ab21c56c1c563112514e4` on `task/C3-candidate-composer` (blind label Q) — rejected |
| Polish candidate / run id | implement `run_01m1pg5466nsksrer6s8x3` FAIL (B-4 GATING→PLANNING duplicate). No candidate commit. |
| Deterministic results | Grok PASS 491 tests. Composer PASS 486 tests. Integration (P) `pnpm check`+`build` PASS 491 tests at `a9fbc73`. |
| Selection | **P** (`a9fbc73`). [compare A](f12bf60d-d3c0-4d4d-900b-2b5becebfba9) and [compare B](966063d4-c4c6-4b10-82e4-7f09a1b824e8) both recommend P. Q disqualified on VALID cost/secrets. Not spliced. |
| Integration commit | `a9fbc733139c99e25fe263ee7a4f890677713432` branch `task/C3-integration` worktree `/Users/fedorsvetlov/polish-c3-integration` |
| Polish verification runs | `run_01m1pkbnxz53215q9n0b3m` **FAIL** (same B-4: GATING→PLANNING duplicate ×5, 0 completed tasks). TARGET unchanged at `a9fbc73`. Not a C3 code finding; not a clean round. |
| Grok review | **no blocking VALID** at `a9fbc73`. Treats missing production scripted client as intentional MC5 fail-closed + TS fallback, not a PHASE_REQUIRED break. Non-blocking VALID: live `create_client()` skips `costEligibility`; `granularity` ignored by sidecar; uncaught Python errors return `id: None`. |
| Claude review | running against `a9fbc73` |
| Composer review | historical only — **FAIL** (blocking VALID, independently reproduced). Not used again. |
| Findings | **Behavior VALID (disputed blocking):** default production sidecar has no injected client; reproduced `health true` → `selectFrontier method=pairwise fallback=true`. Historical Composer review: blocking. Grok review: REJECTED as blocking (MC5 fail-closed). Wait for Claude. **VALID non-blocking:** live `ALLOW_LIVE` path does not consult `costEligibility`; `granularity` not applied in `main.py`; uncaught sidecar exceptions return `"id": None` (`main.py` ~230). **VALID (Q):** unchanged. |
| Fix rounds | 0 |
| Clean rounds | 0/2 |
| Accepted commit | |
| Trusted capabilities added | none yet (C3 must not be used to accept C3) |
