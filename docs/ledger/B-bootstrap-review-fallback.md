# B-bootstrap-review-fallback — Review must not tight-loop on 429/400 or fail clean-round proof

**Status:** ACCEPTED (Composer verifier, `blocking_findings: 0`)  
**Class default:** PHASE_REQUIRED (bounded Phase-B production reliability; not Phase C)  
**Prompt:** Live smoke `run_01m1my3pdwwqxr1pe45z91` (`fixtures/resume-dup-fetch` copied into a git repo). Coding and first review round succeeded; VALIDATING then stalled, then REVIEWING hammered unusable free models.  
**Do not:** Phase C; remaining `B-selfhost-remaining`; `polish apply`; pinning paid reviewers; adding a lockfile to the fixture.

## Per-task BVP

- Implementer: Grok 4.6 (this chat)
- Deterministic gates (orchestrator): `pnpm check` PASS — 59 files / 473 tests
- Verifier: Composer 2.5 ([Adversarial review-fallback review](4a4aba91-5481-45bf-9863-404b17774f32)) — PASS, `blocking_findings: 0`
- Live: `run_01m1my3pdwwqxr1pe45z91` → `DONE`, checkpoint `c011b6e80485…` ≠ baseline `bd6ee53…`, 3 clean rounds, fixture tests 3/3. Target `main` not applied.

Non-blocking residue: 429 unit test covers same-tick skip, not production `selectReviewProviders` sticky exclude; some parse/`invalid_value` error strings are not sticky on a later tick; final report lists every failed `rvex_*` in round-1 proof.

## Root-cause class (captured smoke)

1. Reviews called the adapter directly, bypassing `ModelBroker` (no backoff, almost no `model.call` events). On 429 the driver waited and the ~50ms daemon tick retried the same model.
2. After daemon restart the catalog was empty until `DISCOVERING_MODELS`; router selected nothing and REVIEWING idled.
3. `buildCleanRoundFromReview` required every execution in the round (including thousands of incomplete 429s) to be `completed`. VALIDATING threw; the daemon swallowed it; the run stayed `VALIDATING` / stale.
4. Router `requireJson` still selected audio/preview models that 400 on JSON mode, and schema-invalid free models. A single non-429 failure returned `waiting` instead of trying the next reviewer. Sticky exclude used the latest execution, so an in-flight (killed) attempt hid a prior 400, and a later schema fail on a model that had already completed an axis excluded the only working reviewers.

The target copy must be a git repo (`git init` + commit). `cp -R fixtures/resume-dup-fetch /tmp/polish-smoke` alone fails `git rev-parse HEAD`.

## Required behavior

1. Review completions go through the broker. Hydrate the catalog if empty before selecting reviewers.
2. On reviewer failure, skip that model for the rest of the tick and try the next reviewer. Empty list after sticky skips → `waiting`, not `CONFIG_ERROR`.
3. Sticky-exclude (this checkpoint) models whose latest *finished* attempt is 429 / 400 / JSON-mode / schema-invalid, except models that already have a completed review on the checkpoint. Ignore in-flight attempts with no error when computing sticky exclude.
4. Clean-round proof uses completed executions only. Incomplete siblings in the same round must not throw.
5. Do not treat a leftover `mission_requirement` coding task as pending finding work.

## Deterministic evidence

- 429 on first reviewer, second model completes; first model called once.
- 400 JSON-incapable first reviewer, second model completes the round in one tick.
- Clean round records when three completed reviews share a round with incomplete rate-limit executions.
- `pnpm check`.
- Live: `run_01m1my3pdwwqxr1pe45z91` → `DONE`, checkpoint `c011b6e80485…` ≠ baseline `bd6ee53…`, three clean rounds, fixture tests 3/3 pass on the run branch. Target `main` unchanged (no auto-apply).

## Out of scope

Phase C; catalog modality filtering for Lyria; shrinking the final report's round-1 proof list of failed `rvex_*` ids; executing leftover decompose task R2.
