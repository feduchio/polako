# C4 provenance ledger

Contract: `docs/ledger/C4.md` (immutable after freeze commit).  
Do not treat this file as a second contract. After freeze the contract is immutable for implementation.

| Field | Value |
|---|---|
| Status | **ACCEPTED** at `4fae147` — clean 2/2. Phase C is **not** complete. B-4/B-8/B-11 remain OPEN. |
| Exact base | `7139e9cc2ad8a58e35a5b1535941eddbf4c25f13` (accepted C2; `task/C2-integration`) |
| Trusted predecessor | C2 accepted `7139e9c`; C3 accepted `0abcf62` (not a C4 oracle) |
| Fable scope | §17 C4 — Prosecutor / Defender / Judge for UNCERTAIN findings |
| Accepted dependency | B5 finding validator; B6/C2 investigation-exhausted → NEEDS_HUMAN |
| Open dependency boundary | B-4 Polish HOST GATING OPEN; B-8 / B-11 OPEN and not C4 scope |
| Untrusted references | historical `main` `docs/ledger/C4.md`, `src/findings/debate.ts` |
| Reviewed draft hash | `a0a3d2d89e7f8f7ae152f75ca21e01daa6f2d54d18c5ea5739fb9764f22502ff` |
| Frozen contract hash | `549ed35b2804b0fab5e2b103d1f0f13bde2a1034a46a0188d23f2162eac6c4c7` |
| Grok contract review | **FAIL** on reviewed draft; 6 blocking VALID |
| Claude contract review | **FAIL** on reviewed draft; 5 blocking VALID |
| Review findings | all blocking findings resolved in the frozen text; no second Claude contract review |
| Contract freeze commit | `8442203db768c4fd0b648895398d7530442ddb45` |
| Implementation | Grok `4fae1473f5dd5430f58d613ad7c90beed1128cf9`; Claude implementer unused; Polish deferred (B-4) |
| Polish run | none (B-4); not a C4 code finding |
| Paid/live calls | forbidden; none |
| Clean rounds | 2/2 on `4fae147` (Grok+Claude PASS, then Grok+Claude PASS; no code change after that SHA) |
| Accepted C4 commit | `4fae1473f5dd5430f58d613ad7c90beed1128cf9` (`task/C4-candidate-grok` / `task/C4-integration`) |
| Next bounded step | C8 contract freeze (Model Audition / observations). Do not enter Phase D. Do not tag `phase-c-accepted`. |

## Execution plan (completed for C4)

1. Draft + Grok/Claude contract reviews of hash `a0a3d2d8…02ff` → FAIL/FAIL.
2. Incorporate blocking findings; freeze `8442203` / contract hash `549ed35b…c6c4c7`.
3. Grok implementer on exact base → `4fae147`.
4. Coordinator gates: Node 24.20.0 typecheck + 557 tests.
5. Clean rounds 2/2 PASS/PASS. Accept C4. Polish deferred (B-4).

## Independent contract reviews

Both lanes reviewed the exact same `C4.md` hash `a0a3d2d8…02ff` and exact base `7139e9c`. Neither received the other lane's reasoning.

### Grok

Result: **FAIL**. Incorporated: CR-01…CR-06 (distinct models, pre-debate evidence, driver wiring, events/resume, `finding_debate` method, honest corpus).

### Claude

Result: **FAIL**. Incorporated: B1…B5 (DONE visibility during debate, mid-debate crash, persist ordering, pre-debate evidence, corpus honesty).

## Accepted candidate `4fae147`

Worktree: `/Users/fedorsvetlov/polish-worktrees/phase-c/C4/grok`. Integration: `/Users/fedorsvetlov/polish-worktrees/phase-c/C4/integration`. Frozen `C4.md` unchanged. B-4/B-8/B-11 OPEN.

| Round | Grok | Claude |
|---|---|---|
| 1 | PASS | PASS |
| 2 | PASS | PASS |

No blocking VALID at accepted commit. Recorded non-blocking (not C4 blockers): skip-path `UNCERTAIN→UNCERTAIN` status_changed for round bump; `deriveDebateCorpusKind` fallback arm; broker `judge` actor remap vs council; unused protocol SKILLs; production exhaustion→NEEDS_HUMAN rarely reachable until investigation re-entry exists (B-class coherence, not C4 inventing VALID).

Polish HOST verify still deferred (B-4). C3 sidecar was not used as an oracle.
