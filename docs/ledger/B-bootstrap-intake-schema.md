# B-bootstrap-intake-schema — Planner structured-output must not become NEEDS_HUMAN

**Status:** ACCEPTED (Composer verifier, `blocking_findings: 0`)  
**Class default:** PHASE_REQUIRED (bounded Phase-B production reliability; not Phase C)  
**Prompt:** Tiny production smoke `run_01m1mnxga8r84x5xerpdvp` / planner call `call_01m1mnxq9g16t4rt13t31e`.  
**Do not:** remaining Phase-B defects; Phase C retry/pathology machinery; schema weakening to accept malformed output.

## Per-task BVP

- Implementer: Grok 4.6 (this chat)
- Deterministic gates (orchestrator): `pnpm check` PASS — 58 files / 451 tests
- Verifier: Composer 2.5 ([Adversarial intake-schema review](6597b37c-52aa-4892-af6a-a6ddde66692d)) — PASS, `blocking_findings: 0`
- Non-blocking residue: Test D is observer + council/driver split rather than one E2E render; `responseArtifact` is production-wired but not asserted in unit mocks; sibling operational failure can wrap as `PROVIDERS_UNAVAILABLE` while still PAUSE (not NEEDS_HUMAN)

`blocking_findings: 0`

## Root-cause class (captured smoke)

Captured Gemini planner `model_response` is semantically an approve of a bounded bugfix, but `proposal.requirements` is `string[]` plus a sibling `acceptanceCriteria` array. `RequirementSchema` (`ref: R\d+`, `statement`, `acceptance[]`) is the original Fable/B7 contract and is not wrong. Classification: **model violated a correct schema**. Not a provider adapter transform, not a parser bug, not a schema/contract mismatch.

## Required behavior

1. `NEEDS_HUMAN` is reserved for semantic/user ambiguity (contradictory requirements, missing decision that cannot be inferred, genuine scope ambiguity, blocking `ambiguities`, `needs_human` votes).
2. Invalid planner structured output is not a human question.
3. Planner intake validation flow:
   - model response → validate expected schema
   - if invalid: persist structured diagnostics → one bounded structured-output repair/retry → validate again
   - if still invalid: authorised planner fallback model (existing council chain) → validate
   - if every authorised planner model fails the contract: explicit output-contract failure using existing resumable semantics (`PAUSED` + waiting, same family as exhausted providers). Not `NEEDS_HUMAN`.
4. Persist `model.output_invalid` (and a terse repair event) with: role, purpose, schema name/version, issue paths/messages, source model/provider, response artifact reference when known, repair/fallback attempt.
5. Human log is terse (`! planner output invalid · $.requirements[0] …`, `↻ repair 1/1`, `⇢ fallback · …`). Full model body stays in artifacts / `--json`.
6. `polish status` / `watch` for a genuine `NEEDS_HUMAN` shows the actual question/reason, never only `Phase NEEDS_HUMAN`. A machine/schema/provider failure must say so and must not masquerade as a human question (including the captured historical run).
7. Do not invent `R1` from malformed strings. Do not change `RequirementSchema` to accept strings.

## Deterministic evidence

- A. Semantically valid / schema-invalid planner output → one repair succeeds → `MissionInterpretation` created → run leaves `INTERPRETING_MISSION` → not `NEEDS_HUMAN`.
- B. Primary planner repeatedly schema-invalid → configured fallback planner valid → run proceeds.
- C. All planner models schema-invalid → output-contract waiting/`PAUSED` → not semantic `NEEDS_HUMAN`.
- D. Schema-valid planner with blocking ambiguity → `NEEDS_HUMAN` remains valid and status shows the question.
- E. Captured smoke JSON is a fixture that fails `RequirementSchema` on `$.requirements[0]` (string vs object).
- `pnpm check`.

## Out of scope

Phase C pathology; decompose-task schema repair; remaining `B-selfhost-remaining` items; changing council vote aggregation.
