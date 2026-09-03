# B-bootstrap-4 — Phase-B cost eligibility (self-host launch blocker)

**Status:** ACCEPTED (verifier — zero VALID blocking)

## Per-task BVP

- Implementer: orchestrating agent (Grok) — Router `free_only` gate, then production REVIEWING via `selectReviewProviders` + explicit `ReviewProvider`
- Verifier round 1: Claude — FAIL (Other Models quota; switched, discarded)
- Verifier round 2: GPT — FAIL (Other Models quota; switched, discarded)
- Verifier round 3: [Composer cost-eligibility verify](587af942-6d77-491e-a1af-03c25ca74fba) — PASS, `blocking_findings: 0`
- Deterministic gates: orchestrator `pnpm check` PASS — 50 files / 417 tests

`blocking_findings: 0`

## Contract

Dynamic worker/reviewer/verifier routing must not spend paid provider balance without explicit permission. Not C8 audition. Not C2 budget engine.

1. Configurable `routing.costEligibility`: `free_only` (default) | `ceiling` | `unrestricted`.
2. `free_only` (and `ceiling` at 0/0): both advertised `inputCostPerM` and `outputCostPerM` must be **explicitly 0**.
3. `null`/unknown pricing is **not** free.
4. Discovery still catalogs paid models. Non-pinned probe shortlist and Router eligibility exclude them under `free_only`.
5. Cost exemption applies only to **explicit user-pinned council** models (`config.supervisors` → `complete()` by model ref). Dynamic Router selection of **any** role obeys the cost policy. Pins are not worker/reviewer exemptions.
6. Production REVIEWING selects via `ModelRouter` (`role=reviewer`, `requireJson=true`, ensemble count) and passes explicit `ReviewProvider` (adapter + `ModelRef`). Production path must not call `listModels()[0]`.
7. Regression: paid higher-tier cannot beat a free lower-tier model while free-only is active; paid/unknown reviewers are never invoked.

## Forbidden

- C8 Model Audition
- C2 pathology/adaptive budget
- Remaining Phase-B defects in `docs/ledger/B-selfhost-remaining.md` except this #10 lift

## Non-blocking (not remaining-B requirements)

- `createWorkerFactory` still falls back to `{ provider: providers[0], model: "default" }` if Router returns no workers (REVIEWING fails closed instead).
- Production COMPARER / `PairwiseJudge` is remaining B #11.
