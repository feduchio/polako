# B-selfhost-32 + 34 + 44 (+11) — strict review output and empirical verifier

**Status:** DRAFT, revision 2. Not frozen. Base `ecfd45d`.
Revision 1 was rejected independently by Grok and Claude; both rejections were correct.

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
  `integer|null`; no additional properties;
- `reproduction`: string array; `suggestedCheck`: `string|null`.

Before `RawFindingSchema`, null optional fields are removed. The defensive normaliser remains on the
same production/replay parser; strict live output is arrays/lower-case/null optionals.

**MC2 — probed capability truth.** `supportsStrictSchema` defaults false. Catalog advertisement is
only a discovery hint. Capability probing sends the frozen strict schema and marks support true only
when the response parses and validates; advertise-then-reject resolves false. Reviewer and verifier
selection require the probed flag and never downgrade to `json_object`.

**MC3 — empirical reward, honestly named.** One evaluation emits strict
`{scoreA: integer 0..4, scoreB: integer 0..4}` and no prose. At least two criteria are used; maximum
eight. For criterion index `c` and repeat `r`: slot order swaps when `r` is odd; family index is
`(r+c) mod 2`. Thus each family sees both slot orders. Reward is the arithmetic mean of completed
scores divided by 4. Failures are excluded, never zeros. Provenance is
`scoreScheme:"empirical_repeats"`; empirical `logprobScheme` is absent.

Empirical and reviewer calls set `reasoning:{effort:"none",exclude:true}` on providers that support
it. Capability probing covers the schema+reasoning combination; a model that requires reasoning and
cannot produce the bounded object resolves unsupported.

**MC4 — hard phase bound and broker accounting.** Exactly two distinct free, probed-strict families
are required; one or zero falls back before any empirical call. All evaluations use
`ModelBroker.complete` with retry policy `maxAttempts:1`, `role:"verifier"` and
`purpose:"empirical_pair_score"`. Per-COMPARING ceiling is 48 logical/provider attempts. Criteria
are truncated deterministically to fit while keeping at least two; if two cannot fit, fallback occurs
before calls. Fewer than half requested evaluations completed for a pair triggers visible
deterministic fallback. Completed usage remains recorded.

**MC5 — defined empirical pair mass.** Completed normalized rewards `Ra,Rb` produce
`pA = 1/(1+exp(-(Ra-Rb)))`, `pB=1-pA`. Each unique unordered pair contributes that win mass and one
comparison count to each candidate. Ranking is descending `winMass/count`, then id.

**MC6 — defined PPT pair set.** Candidate ids sort by code-unit order. N=2 evaluates its single
unordered pair. N=3 ring equals all three pairs. For N>=4:

1. ring pairs are `(id[i],id[(i+1)%N])`;
2. rank ring mass/count, id tie-break; first `k=min(pivots,N)` are pivots;
3. unique pair set is ring ∪ nonpivot×pivot ∪ pivot-pairs;
4. each unordered pair is evaluated once; MC3 handles slot reversal internally.

Pinned fixture with pivots `a,c`: N=3 → `ab,bc,ac`; N=5 →
`ab,bc,cd,de,ae,ad,ce,ac` (8); N=8 →
`ab,bc,cd,de,ef,fg,gh,ah,ad,ae,ce,af,cf,ag,cg,ch,ac` (17).
Full round-robin is not PPT.

**MC7 — production wiring, absorbing item 11.** Backend is `ts|sidecar|empirical`, default empirical.
`installProductionDrivers` injects an empirical strategy built from broker-backed adapters. Missing
the two-family eligibility gate produces visible fallback. `sidecar` and `ts` remain explicit.
The empirical prompt composes the existing `judge` protocol; it gains a production caller.

**MC8 — truthful provenance.** `FrontierSelection`, `TournamentSelection`, `candidate.compared` and
rationale artifact carry actual backend, `scoreScheme`, model refs, criteria, requested/completed
evaluations, unique comparison count and fallback reason. Sidecar claims move to
`claimedLogprobScheme`; persisted `logprobScheme` remains null unless TypeScript receives and uses
distributions. Existing scripted direct/two-stage tests assert the claimed field, not observed
logprobs. Empirical rationale is mechanical; model prose is neither requested nor stored.

**MC9 — benchmark feedback without false comparability.** Item 42 remains frozen historical
evidence. Two seed-43 reruns are reported:

1. exact original model refs under strict transport, to measure schema/completion deltas; quality
   metrics are paired with schema/transport counts and are not compared alone;
2. operational two-family probed-strict ensemble, labelled as a new configuration.

The accepted corpus/scorer/oracle are unchanged. No threshold is declared success and no claim is
made that strict schema fixes semantic false positives.

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
accept → true; malformed response → false. Router, reviewer selection and ensemble alternatives
require the resolved probed flag and never downgrade.

**AC3.** Exact provider payload asserts `json_schema`, name, strict, frozen schema and disabled
reasoning. Nex and NVIDIA return valid empty findings under that payload; the same NVIDIA request
without the reasoning option is recorded as an invalid response rather than support.

**AC4.** Two criteria × two repeats assert four calls with schedule:
`c0r0 family0 normal`, `c0r1 family1 swapped`,
`c1r0 family1 normal`, `c1r1 family0 swapped`.
Asymmetric matrices assert slot remap, completed-only mean, exact normalized rewards and sigmoid mass.

**AC5.** One-family and zero-family fixtures fall back with zero empirical calls. Failure fixtures
assert usage survives; fewer than half completed falls back; exact reason/requested/completed counts
persist.

**AC6.** Pair-set literals: N=2 one pair; N=3 three; N=5 exact eight listed in MC6; N=8 exact
seventeen. Assert ring A/B participation, pivots `a,c`, no duplicate provider payment, sigmoid mass
and deterministic ranking. A 28-pair implementation fails.

**AC7.** Production COMPARING with two non-dominated candidates invokes broker-backed empirical
calls. Assert persisted `model.call` rows: two distinct free strict families, real refs,
`role:verifier`, `purpose:empirical_pair_score`, retry max 1. Assert default backend empirical and no
providerless judge call before it.

**AC8.** Phase ceiling fixtures: maximal production N=3 / 8 criteria / 2 repeats issues exactly 48
calls; rate-limit every call still stops at 48 and falls back visibly; a synthetic N=8 request cannot
fit two criteria and falls back before calls.

**AC9.** Provenance literals independently pin backend empirical, score scheme, both refs, criteria,
requested/completed, unique pairs and fallback reason. `logprobScheme` is null. Sidecar scripted
tests pin `claimedLogprobScheme` while observed field remains null.

**AC10.** Strict score schema rejects prose, extra properties, missing keys and values outside 0..4.
Stored rationale contains only mechanical aggregates.

**AC11.** Scripted item-42 strict rerun covers 96 cells. Live seed-43 runs persist both reports from
MC9 with packet/oracle/raw/rescore artifacts. Comparison prints completion/schema/transport beside
quality and never presents changed-denominator recall alone as improvement.

## Named fakes

| Fake | Killer |
|---|---|
| `json_object` renamed “strict” | AC1 |
| Advertisement treated as probed support | AC2 |
| Advertise-then-400 remains true | AC2 |
| Null optionals rejected by Zod | AC1 |
| Same family evaluates every repetition | AC4 |
| A/B reversal without score remap | AC4 |
| Failed evaluations counted as zeros | AC5 |
| Ring pair paid again in pivot phase | AC6 |
| Full round-robin labelled PPT | AC6 |
| Production still constructs providerless judge | AC7 |
| Empirical calls bypass broker | AC7 |
| Rate-limit storm exceeds 48 attempts | AC8 |
| Empirical votes labelled `direct` | AC9 |
| Sidecar claim stored as observed logprobs | AC9 |
| Model prose stored as verifier rationale | AC10 |
| Changed-denominator recall presented as improvement | AC11 |

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

## Out of scope

- Native Gemini transport solely to obtain logprobs.
- Passing API keys into the Python sidecar.
- A finding-level verifier filter before benchmark evidence justifies one.
- Progress/no-progress stopping (35 + 23).
- Worker execution state (31).
