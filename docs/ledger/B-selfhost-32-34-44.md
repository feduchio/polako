# B-selfhost-32 + 34 + 44 (+11) — strict review output and empirical verifier

**Status:** **FROZEN**, revision 5. Base `ecfd45d`.
Frozen after independent Grok and Claude reviews on `f895f52`; reviewed-file sha256
`6f87c12b978b7ed861d3f95a6c4ad6edc775c7602551be9a9ac046c5ddba4e13`.
Revisions 1–4 were reviewed independently by Grok and Claude; all rejections were correct.

## Facts that constrain the design

- OpenRouter free models advertise logprobs but return `logprobs: null`.
- Gemini's OpenAI-compatible endpoint rejects `logprobs`/`top_logprobs`; its current native free
  model reports “Logprobs is not enabled for this model”.
- Therefore neither `direct` nor `two_stage` logprob expectation is available on the permitted
  providers. Claiming either would repeat finding 34.
- Strict-schema probes with the exact findings schema:
  - `nex-agi/nex-n2.5-mini:free`, `nex-n2.5-pro:free`,
    `dots-studio/dots-3-note-preview:free` and `liquid/lfm-2.5-2.6b:free` returned valid
    `{findings:[]}`;
  - `nvidia/nemotron-3-super-120b-a12b:free` advertised `structured_outputs` but ignored the schema
    and emitted 128 reasoning tokens under default reasoning. With
    `reasoning:{effort:"none",exclude:true}` it returned valid strict findings in 6 output tokens.
  - the same reasoning-disabled option produced valid strict score objects on Nex, NVIDIA and Dots
    in 19–81 output tokens. Liquid rejects disabled reasoning.
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
6. Repeat item-42 benchmark after strict schema, with transport effects separated from quality.

## MISSION_CRITICAL

**MC1 — frozen strict reviewer schema.** `CompletionRequest` gains a distinct strict-schema option.
OpenAI-compatible payload is
`{type:"json_schema",json_schema:{name:"review_findings",strict:true,schema:...}}`.
The schema is frozen:

- root object: required `findings`, no additional properties;
- finding: all seven keys required, no additional properties;
- `criterion`, `claim`: string; `severity`: the five lower-case enum values; `blocking`: boolean;
- `evidence`: array of objects requiring `path`, `line`, `endLine`; line fields are
  `integer|null` with integer minimum 1; no additional properties;
- `reproduction`: string array; `suggestedCheck`: `string|null`.

Before `RawFindingSchema`, null optional fields are removed. The defensive normaliser remains on the
same production/replay parser; strict live output is arrays/lower-case/null optionals.

**MC2 — probed capability truth.** `supportsStrictReviewSchema` and
`supportsStrictScoreSchema` default false. Advertisement is only a shortlist hint. Broker-backed,
retry-1 probes send each frozen schema plus disabled reasoning and persist separate results. Only
validated success is true; reject, timeout, malformed, inconclusive or probe failure are false
regardless of advertisement. Reviewer selection requires the review flag; empirical selection
requires the score flag. Neither downgrades to `json_object`. Strict probes use the existing
per-provider discovery shortlist cap during DISCOVERING_MODELS and persist a strict-probe
observation keyed by model ref + schema hash. A probe epoch is complete when every model in that
bounded shortlist has a success/failure record; catalog models outside the shortlist are irrelevant.
Re-probe only when model identity/schema hash changes. Other capability probes remain finding 24.

**MC3 — empirical reward, honestly named.** One evaluation emits strict
`{scoreA: integer 0..4, scoreB: integer 0..4}` and no prose. Empirical criteria are padded with the
literal `"overall correctness"` to at least two and capped at eight. `empiricalRepeats` is separate
from sidecar `repeats`; it is a positive multiple of 4, default/minimum 4. Per
criterion: r0 family0 normal, r1 family0 swapped, r2 family1 normal, r3 family1 swapped; later blocks
of four repeat that schedule. Each family sees both slots for the same criterion. Reward is the
arithmetic mean of completed scores divided by 4. Failures are excluded, never zeros. Provenance is
`scoreScheme:"empirical_repeats"`; empirical `logprobScheme` is absent.

Empirical and reviewer calls set `reasoning:{effort:"none",exclude:true}` on providers that support
it. Capability probing covers the schema+reasoning combination; a model that requires reasoning and
cannot produce the bounded object resolves unsupported.

**MC4 — hard phase bound and broker accounting.** Eligible entries sort by family then
`provider:model`; select the first model in the first two distinct free, probed-strict families.
One or zero families falls back before any empirical call. All evaluations use
`ModelBroker.complete` with retry policy `maxAttempts:1`, `role:"verifier"` and
`purpose:"empirical_pair_score"`. Per-COMPARING ceiling is 48 logical/provider attempts and
192,000 estimated input tokens, counted across re-entry and candidate attempts for the task from
persisted `model.call` events. Before each call, exact serialized messages are measured with
`estimateTokens`; a call that would exceed the estimate cap is not issued. Criteria
are truncated deterministically to fit while keeping at least two; if two cannot fit, fallback occurs
before calls. If any pair completes fewer than half its requested evaluations, the **whole empirical
selection** is abandoned and deterministic fallback ranks the frontier; empirical and deterministic
mass are never mixed. Completed usage remains recorded.

Each candidate payload includes exact verified CAS diff text, gate report and metrics. GATING stores
`git diff(baseCheckpointHash, headCommit)` as artifact kind `candidate_diff` and persists `diffRef`
on `candidate.gated`. Missing or over-2,000-token (`estimateTokens`) diff causes whole-selection
fallback before empirical calls. Candidate text is fenced as untrusted data.

**MC5 — defined empirical pair mass.** Completed normalized rewards `Ra,Rb` produce
`pA = 1/(1+exp(-(Ra-Rb)))`, `pB=1-pA`. Each unique unordered pair contributes that win mass and one
comparison count to each candidate. Ranking is descending `winMass/count`, then id.

Independent fixture: `Ra=5/6`, `Rb=1/6`, `pA=0.6607563687658172`,
`pB=0.3392436312341828`. Expected literals may not call the mass function.

**MC6 — defined PPT pair set.** Empirical pivots are fixed at 2. Candidate ids sort by code-unit
order. N=2 evaluates its single unordered pair. N=3 ring equals all three pairs. For N>=4:

1. ring pairs are `(id[i],id[(i+1)%N])`;
2. rank ring mass/count, id tie-break; first `k=min(2,N-2)` are pivots;
3. unique pair set is ring ∪ nonpivot×pivot ∪ pivot-pairs;
4. each unordered pair is evaluated once; MC3 handles slot reversal internally.

Empirical uses these degenerate rules below N=4 regardless of sidecar/TS `pivotTournamentFrom`.
Pinned fixture with pivots `a,c`: N=3 → `ab,bc,ac`; N=4 with adjacent pivots → 6 pairs; N=5 →
`ab,bc,cd,de,ae,ad,ce,ac` (8); N=8 →
`ab,bc,cd,de,ef,fg,gh,ah,ad,ae,ce,af,cf,ag,cg,ch,ac` (17).
Full round-robin is not PPT.

**MC7 — production wiring, absorbing item 11.** Backend is `ts|sidecar|empirical`, default empirical.
`installProductionDrivers` injects an empirical strategy built from broker-backed adapters. Missing
the two-family eligibility gate produces visible deterministic fallback in COMPARING. In REVIEWING,
zero review-capable models after a completed bounded probe epoch terminates as
`FAILED/providers_unavailable` before an axis call. A missing probe record for an in-shortlist model
is `FAILED/internal_error`, not an unbounded wait. Catalog models outside the shortlist do not block
completion. Probed-strict models temporarily sticky-excluded retain the accepted wait/exhaustion
behavior. There is no schema downgrade. `sidecar` and `ts` remain explicit.

`VerifierStrategySchema` keeps sidecar `repeats` (default 2, min 1) and adds
`empiricalRepeats` (default/min 4, multiple of 4). Production passes the latter to the empirical
strategy; `FrontierSelectOptions.repeats` remains the sidecar channel.

The empirical prompt composes `base + task(kind) + judge`; `PairwiseContext` carries task kind and
`ProtocolRegistry` is injected. `protocols/judge` explicitly says a supplied score schema requires
scores only; its body and frozen score contract are asserted on the wire.

**MC8 — truthful provenance.** `VerifierBackend` and every selection/provenance type include
`empirical`. `FrontierSelection`, `TournamentSelection`, `candidate.compared` and
rationale artifact carry actual backend, `scoreScheme`, model refs, criteria, requested/completed
evaluations, unique comparison count and fallback reason. Sidecar claims move to
`claimedLogprobScheme`; persisted `logprobScheme` remains null unless TypeScript receives and uses
distributions. Existing scripted direct/two-stage tests assert the claimed field; empirical asserts
`client:"live"`. Empirical rationale is mechanical; model prose is neither requested nor stored.

**MC9 — benchmark feedback without false comparability.** This contract explicitly supersedes item
42 MC6's transport **for production**; its corpus, scorer, oracle and historical reports remain
frozen. The benchmark runner retains explicit `legacy_json_object` and `strict_schema` modes so a
contemporaneous seed-43 A/B is possible. Three reports are published:

1. exact original refs under legacy transport;
2. exact original refs under strict transport;
3. operational two-family probed-strict ensemble, labelled as a new configuration.

The accepted corpus/scorer/oracle are unchanged. No threshold is declared success and no claim is
made that strict schema fixes semantic false positives.

**MC10 — replay and forensic identity.** Strict schema and reasoning options are inputs to
`RecordReplayProvider.requestKey` and broker `model_request` artifacts. They are never omitted from
the bytes used to reproduce or audit a call.

## PHASE_REQUIRED

**PR1.** Paid APIs remain forbidden. Empirical production selection uses only models with both
prices exactly zero and strict JSON support.

**PR2.** Existing `llm-verifier` sidecar behavior stays valid, but direct/two-stage are recorded as
sidecar claims. No claim is made that TypeScript observed logprobs or that the sidecar is live.

**PR3.** Existing suite passes. At least one acceptance check fails on the unmodified tree.

## Acceptance checks

**AC1.** Assert the frozen review schema object literally. A null-bearing strict response parses to
the same `RawFinding` as replay input with omitted optionals. `json_object`, singular evidence,
string reproduction and title-case severity are not the strict fixture.

**AC2.** Active probe matrix: advertise+accept → true; advertise+400 → false; no advertisement but
accept → true; malformed, timeout, inconclusive and probe-failed → false. Assert persisted probe
state independently for review and score schemas. Router, reviewer selection and ensemble
alternatives require the relevant state and never downgrade. Repeated discovery with unchanged
schema/model performs no second strict probe and respects the discovery shortlist cap.

**AC3.** Exact provider payload asserts `json_schema`, name, strict, frozen schema and disabled
reasoning. Nex and NVIDIA return valid empty findings under that payload; the same NVIDIA request
without the reasoning option is recorded as an invalid response rather than support.

**AC4.** Two criteria × four repeats assert eight calls. For each criterion:
family0 normal/swapped, then family1 normal/swapped. A one-criterion input is padded to two; repeats
1/2/3 are rejected by `empiricalRepeats`; sidecar `repeats:1` remains valid. Asymmetric matrices
assert slot remap, completed-only mean, exact normalized rewards and the independent MC5 sigmoid
literals.

**AC5.** Family catalogs with duplicates and mutable quality stats still select deterministic first
refs from two distinct families. One-family and zero-family fixtures fall back with zero empirical
calls. Failure fixtures assert usage survives; one under-half pair abandons the whole empirical
selection, with no mixed mass; exact reason/requested/completed counts persist.

**AC6.** Pair-set literals: N=2 one pair; N=3 three; N=4 adjacent pivots `a,b` produce six;
N=5/N=8 use pivots `a,c` and produce the exact eight/seventeen listed in MC6. Assert ring A/B
participation, no duplicate provider payment, sigmoid mass
and deterministic ranking. Assert `Ra/Rb/pA/pB` against MC5 literals without calling production
helpers. A 28-pair implementation fails.

**AC7.** Production COMPARING with two non-dominated candidates invokes broker-backed empirical
calls. Assert persisted `model.call` rows: two distinct free strict families, real refs,
`role:verifier`, `purpose:empirical_pair_score`, retry max 1. Assert default backend empirical and no
providerless judge call before it. Default N=2 with one input criterion asserts padding and exactly
`2 criteria × 4 empiricalRepeats = 8` calls while sidecar repeats remains 2. Payload contains each candidate's actual CAS diff; missing and
over-cap diffs fall back before calls. Prompt contains composed base/task/judge and score contract.

**AC8.** Phase ceiling fixtures: N=3 / 8 input criteria / 4 repeats truncates to the first 4 criteria
and issues exactly 48 calls; rate-limit every call still stops at 48 and falls back visibly; N=5 and
N=8 cannot fit two criteria and fall back before calls. Re-entering COMPARING sees persisted calls
and cannot issue another 48. A separate fixture persists near-cap estimated input, re-enters and
proves no reset; the 48-call fixture uses small diffs. Estimated input over 192,000 stops and falls back. Strict probes
are excluded from COMPARING counts and independently broker-accounted.

**AC9.** Provenance literals independently pin backend empirical, client live, score scheme, both refs, criteria,
requested/completed, unique pairs and fallback reason. `logprobScheme` is null. Sidecar scripted
tests pin `claimedLogprobScheme` while observed field remains null. Hardcoded `backend:"sidecar"`
fails.

**AC10.** Strict score schema rejects prose, extra properties, missing keys and values outside 0..4.
Stored rationale contains only mechanical aggregates.

**AC11.** Scripted item-42 runs cover both transport modes. Live seed-43 persists all three MC9
reports with packet/oracle/raw/rescore artifacts. Comparison prints exact model refs, transport,
completion/schema/transport beside quality and never presents changed-denominator recall alone as
improvement.

**AC12.** Record/replay request keys and broker forensic request artifacts differ when strict schema
or reasoning options differ; both fields are visible in persisted evidence.

**AC13.** REVIEWING with hydrated/probed catalog and zero strict reviewers returns
`FAILED/providers_unavailable` with zero axis calls even when unprobed catalog models exist outside
the bounded shortlist. Missing a strict-probe record for an in-shortlist model returns
`FAILED/internal_error`; sticky-excluded probed models follow existing wait/exhaustion behavior. No
`CONFIG_ERROR` crash, silent wait or `json_object` downgrade.

**AC14.** Production EXECUTING→GATING persists a non-null `candidate_diff` artifact for each
implemented candidate; COMPARING loads those exact bytes. Missing, wrong-base and >2,000-token
fixtures fall back before empirical calls.

## Named fakes

| Fake | Killer |
|---|---|
| `json_object` renamed “strict” | AC1 |
| Advertisement treated as probed support | AC2 |
| Advertise-then-400 remains true | AC2 |
| Null optionals rejected by Zod | AC1 |
| Same family evaluates every repetition | AC4 |
| Family remains coupled to A/B slot | AC4 |
| Empirical minimum applied to sidecar repeats | AC4 |
| A/B reversal without score remap | AC4 |
| Failed evaluations counted as zeros | AC5 |
| Deterministic fallback mass mixed into empirical mass | AC5 |
| Ring pair paid again in pivot phase | AC6 |
| Full round-robin labelled PPT | AC6 |
| Candidate scores only metadata, not code diff | AC7 |
| GATING leaves `diffRef` null | AC14 |
| Production still constructs providerless judge | AC7 |
| Empirical calls bypass broker | AC7 |
| Rate-limit storm exceeds 48 attempts | AC8 |
| COMPARING re-entry spends a second 48 | AC8 |
| Empirical votes labelled `direct` | AC9 |
| Sidecar claim stored as observed logprobs | AC9 |
| Model prose stored as verifier rationale | AC10 |
| Changed-denominator recall presented as improvement | AC11 |
| Strict and legacy requests share a replay key | AC12 |
| Zero strict reviewers crash or downgrade | AC13 |

## Revision history

**Revision 1 → 2**, after independent Grok and Claude rejection:

- active strict-schema probe replaces catalog trust; NVIDIA's false advertisement is a fixture;
- exact nullable strict schema and pre-Zod normalisation are frozen;
- family and A/B alternation are decoupled;
- empirical pair mass and every PPT pair set are defined, including N=2/N=3;
- two families are mandatory and every call goes through broker with one attempt;
- phase ceiling is 48 attempts;
- empirical backend/provenance is distinct from sidecar logprob claims;
- item-42 feedback is split into exact-model transport A/B and a separately labelled operational
  strict ensemble.

**Revision 2 → 3**, after a second independent rejection:

- strict probing is fail-closed, broker-accounted and persisted;
- repeats are minimum/multiple four so each family sees both slots per criterion;
- two-family selection is deterministic and one-family fallback is explicit;
- verified candidate CAS diffs are part of the score payload;
- under-half pair failure aborts the whole empirical selection, preventing mixed mass;
- exact sigmoid literals and N=2/3/5/8 pair sets are independently pinned;
- reviewer zero-strict case terminates visibly;
- empirical/sidecar provenance and judge protocol composition are observable;
- benchmark retains contemporaneous legacy/strict controls;
- response schema/reasoning enter replay keys and forensic artifacts.

**Revision 3 → 4**, after Grok froze and Claude found four remaining class-(c) gaps:

- REVIEWING terminal is conditional on completed probing and has its own acceptance check;
- production GATING→`diffRef`→COMPARING is observed end to end;
- empirical repeats are separated from sidecar repeats;
- pivots are fixed at two and N=4/N=5 bounds are reconciled;
- phase attempt/token ceilings persist across COMPARING re-entry;
- strict-probe caching/fan-out is bounded.

**Revision 4 → 5**, after Grok froze and Claude found two remaining gaps:

- strict probing is a bounded DISCOVERING_MODELS epoch; missing in-shortlist records fail visibly
  instead of waiting forever, while out-of-shortlist models are irrelevant;
- production empirical calls receive `empiricalRepeats=4`; sidecar retains its independent
  `repeats=2`;
- token-cap persistence and N=4 pivot identities are explicitly observed.

## Out of scope

- Native Gemini transport solely to obtain logprobs.
- Passing API keys into the Python sidecar.
- A finding-level verifier filter before benchmark evidence justifies one.
- Progress/no-progress stopping (35 + 23).
- Worker execution state (31).
