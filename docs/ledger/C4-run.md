# C4 provenance ledger

Contract: `docs/ledger/C4.md` (immutable after freeze commit).  
Do not treat this file as a second contract. After freeze the contract is immutable for implementation.

| Field | Value |
|---|---|
| Status | CONTRACT FROZEN — no implementation |
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
| Implementation | NOT STARTED |
| Polish run | none for contract freeze |
| Paid/live calls | forbidden; none |
| Clean rounds | not applicable to contract freeze |
| Accepted C4 commit | none |
| Next bounded step | after freeze only: create centralized C4 implementation worktrees with OWNERSHIP.json, then launch Grok implementer from exact base |

## Execution plan (this round)

1. Draft bounded `docs/ledger/C4.md` + this provenance stub on `phase-c-collab`.
2. Hash the draft; one Grok and one Claude contract review of the **same** hash.
3. Incorporate all blocking findings into the draft; freeze with a docs-only commit (no second Claude on the contract).
4. After freeze: `/Users/fedorsvetlov/polish-worktrees/phase-c/C4/` + Grok implementer.
5. Do not start C8 or Phase D. Do not tag `phase-c-accepted`.

## Independent contract reviews

Both lanes reviewed the exact same `C4.md` hash `a0a3d2d8…02ff` and exact base `7139e9c`. Neither received the other lane's reasoning.

### Grok

Result: **FAIL**.

Validated and incorporated:

- `C4-CR-01` BLOCKING — three distinct models required; skip must not invent REJECTED/VALID; same-model Judge forbidden.
- `C4-CR-02` BLOCKING — debate VALID requires pre-debate evidence refs; debate text alone insufficient.
- `C4-CR-03` BLOCKING — wire inside `createValidatingDriver` before investigation `task.created`; reconcile `investigationRounds` with B6 predicate; residual UNCERTAIN may investigate if not exhausted.
- `C4-CR-04` BLOCKING — named debate events; legal `UNCERTAIN→VALIDATING→verdict` only at terminal apply; crash/resume cut points.
- `C4-CR-05` BLOCKING — `ValidationMethod` must be `finding_debate` only.
- `C4-CR-06` BLOCKING — corpus kind derived from pre-debate evidence; no fabricated runtime_scenario from transcripts.

### Claude

Result: **FAIL**.

Validated and incorporated:

- `C4-B1` BLOCKING — in-debate finding must remain DONE-visible as `UNCERTAIN` (no stranded `VALIDATING` that hides investigationExhausted).
- `C4-B2` BLOCKING — mid-debate crash recovery while status stays `UNCERTAIN`.
- `C4-B3` BLOCKING — persist-before-terminal-effect vs entry transition ordering reconciled (status stays UNCERTAIN until terminal batch).
- `C4-B4` BLOCKING — same as CR-02 (pre-debate evidence for VALID).
- `C4-B5` BLOCKING — honest corpus registration; no fabricated runtime_scenario for debate-only text.

Non-blocking incorporated where cheap: config `maxDebateRounds` additive; Actor role provenance; FindingValidator stays RAW-only; exhaustion predicate named exactly.

## Centralized worktree proposal

Proposal only during freeze:

`/Users/fedorsvetlov/polish-worktrees/phase-c/C4/`

Planned children: `grok/`, `claude/`, `polish/`, `integration/`. Existing worktrees remain in place. Any move/delete requires explicit user approval.
