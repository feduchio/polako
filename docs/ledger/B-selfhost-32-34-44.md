# B-selfhost-32 + 34 + 44 (+11) — strict review output and empirical verifier

**Status:** DRAFT, revision 1. Not frozen. Base `ecfd45d`.

## Facts that constrain the design

- OpenRouter free models advertise logprobs but return `logprobs: null`.
- Gemini's OpenAI-compatible endpoint rejects `logprobs`/`top_logprobs`; its current native free
  model reports “Logprobs is not enabled for this model”.
- Therefore neither `direct` nor `two_stage` logprob expectation is available on the permitted
  providers. Claiming either would repeat finding 34.
- Both live benchmark families advertise `structured_outputs`.
- Production COMPARING currently builds `PairwiseJudge()` without a provider and silently ranks by
  deterministic metrics.
- The Python sidecar is a real `llm-verifier` wrapper, but its production default client is scripted;
  live secrets are deliberately scrubbed. It is not a live production verifier today.

## Deliverables

1. Strict JSON Schema for reviewer findings.
2. Provider-backed empirical score-token verifier in TypeScript.
3. Probabilistic pivot tournament through `selectFrontier`.
4. Production COMPARING wiring, absorbing item 11.
5. Truthful score provenance.
6. Repeat item-42 benchmark after strict schema.

## MISSION_CRITICAL

**MC1 — strict reviewer schema.** `CompletionRequest` supports a strict JSON Schema response.
OpenAI-compatible providers send `response_format.type = "json_schema"` with `strict: true`.
`runAxisReview` requests an object `{findings:[...]}` whose nested fields match
`RawFindingSchema`; arrays remain arrays. The parser/normaliser stays as defensive replay
compatibility, not the live shape contract.

**MC2 — capability truth.** Model capabilities distinguish JSON object mode from strict JSON Schema.
OpenRouter derives strict support only from `structured_outputs`; unknown is false. Production
review selection requires strict support. Missing strict-capable reviewers is visible and bounded,
never silently downgraded to `json_object`.

**MC3 — empirical reward, honestly named.** With logprobs unavailable, a pair is scored by repeated
categorical evaluations. One evaluation emits strict JSON
`{scoreA: integer 0..4, scoreB: integer 0..4}` for one criterion. Repetitions alternate A/B prompt
slots and alternate the two free model families. Candidate reward is the arithmetic mean divided by
4. Provenance is `scoreScheme: "empirical_repeats"`; `logprobScheme` is absent/null.

**MC4 — criteria and bounded cost.** Criteria are the existing deterministic `decomposeCriteria`
output, maximum 8. Calls per pair equal `criteria × repeats`; repeats default 2, one family per
repeat, not both. Every call uses broker routing/enforcement and is recorded as
`role: verifier`, `purpose: empirical_pair_score`. A provider/schema failure for one evaluation is
recorded; if fewer than half the requested evaluations complete, the pair falls back visibly to the
deterministic judge.

**MC5 — empirical PPT.** `selectFrontier` implements:

1. deterministic Hamiltonian ring over candidate ids; every candidate appears once in A and B;
2. rank by ring win mass/count;
3. top `k` candidates are pivots (`k = min(configured pivots, N)`);
4. compare every non-pivot with every pivot and every pivot pair, reusing ring comparisons;
5. aggregate normalized win mass/count; stable id tie-break.

Comparison count is bounded by the explicit unique-pair set and is less than full round-robin when
`N >= 5, k = 2`. The same pair is never paid twice.

**MC6 — production wiring.** Verifier backend becomes `ts | sidecar | empirical`, default
`empirical`. `installProductionDrivers` injects an empirical strategy built from catalog-selected
free strict-JSON models and broker-backed adapters. `sidecar` remains explicit opt-in for a real
configured client; `ts` remains explicit deterministic fallback. Production default may not create
a providerless `PairwiseJudge` as its primary strategy.

**MC7 — truthful provenance.** Tournament selection, `candidate.compared`, rationale artifact and
candidate state all carry `scoreScheme`, model refs, criteria, requested/completed evaluations,
comparison count and fallback reason. `logprobScheme` is populated only by a response that actually
contains and uses token logprobs.

**MC8 — no prose judge output.** Empirical verifier output is two bounded integers under strict
schema. No rationale is requested from the model. The stored rationale is mechanical: criterion
count, completed evaluations, aggregate scores and fallback status.

**MC9 — benchmark feedback.** The exact accepted item-42 corpus is rerun after MC1. Report the same
completion, primary/strict recall, false positives, discrimination and token metrics. No threshold
is declared success; results decide whether a later finding-verifier filter is justified. This task
does not claim strict schema fixes semantic false positives.

## PHASE_REQUIRED

**PR1.** Paid APIs remain forbidden. Empirical production selection uses only models with both
prices exactly zero and strict JSON support.

**PR2.** Existing `llm-verifier` sidecar tests and direct/two-stage scripted provenance stay valid.
No claim is made that the sidecar is live.

**PR3.** Existing suite passes. At least one acceptance check fails on the unmodified tree.

## Acceptance checks

**AC1.** Provider payload tests assert exact strict JSON Schema bytes, `strict: true`, nested
required fields and `additionalProperties: false`. `json_object` mode cannot satisfy the check.

**AC2.** Catalog fixtures separate `response_format` from `structured_outputs`; only the latter sets
strict support. Router/reviewer selection rejects a JSON-only model and accepts a strict model.

**AC3.** Reviewer scripted responses exercise the exact strict shape. Single-object evidence,
string reproduction and title-case severity remain accepted only through replay normalisation tests,
not as the strict live fixture.

**AC4.** Empirical pair fixture has two criteria and two repetitions with asymmetric score matrices.
Assert four calls, family alternation, A/B reversal, exact normalized rewards and winner. Swapping
slots without remapping scores fails.

**AC5.** Failure fixtures assert: one failed evaluation does not erase completed usage; fewer than
half completed triggers deterministic fallback; fallback reason/provenance is persisted.

**AC6.** PPT fixtures for N=3,5,8 assert exact unique compared pairs, no duplicate payment, each
candidate's A/B ring positions, pivot membership, deterministic ranking and N=8 comparison count
below 28.

**AC7.** Production COMPARING with two non-dominated candidates invokes broker-backed empirical
calls, records their real model refs and `scoreScheme: empirical_repeats`, and never calls
providerless `PairwiseJudge` first. Missing eligible verifier models produces visible fallback.

**AC8.** Provenance mutant matrix: empirical incorrectly labelled direct/two-stage; logprob field
set without distributions; requested count used as completed; model refs omitted; fallback false
after fallback. Each dies on an independent literal assertion.

**AC9.** Model output larger than the two-score object or containing prose is rejected by strict
schema/parse. Scores outside 0..4 are rejected.

**AC10.** Re-run item 42 with scripted strict providers through all 96 cells, then execute the
bounded live free run. Persist packet/oracle/raw/corrected report artifacts and compare to the
accepted item-42 baseline.

## Named fakes

| Fake | Killer |
|---|---|
| `json_object` renamed “strict” | AC1 |
| JSON-only model treated as schema-capable | AC2 |
| Singular evidence remains the live expected shape | AC3 |
| Same family evaluates every repetition | AC4 |
| A/B reversal without score remap | AC4 |
| Failed evaluations counted as zeros | AC5 |
| Ring pair paid again in pivot phase | AC6 |
| Full round-robin labelled PPT | AC6 |
| Production still constructs providerless judge | AC7 |
| Empirical votes labelled `direct` | AC8 |
| Model prose stored as verifier rationale | AC9 |
| Benchmark report omitted after wiring | AC10 |

## Out of scope

- Native Gemini transport solely to obtain logprobs.
- Passing API keys into the Python sidecar.
- A finding-level verifier filter before benchmark evidence justifies one.
- Progress/no-progress stopping (35 + 23).
- Worker execution state (31).
