# B-selfhost-32 + 34 + 44 (+11) — strict review output and empirical verifier

**Status:** DRAFT, revision 3. Not frozen. Base `ecfd45d`.
Revisions 1 and 2 were rejected independently by Grok and Claude; both rejections were correct.

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
requires the score flag. Neither downgrades to `json_object`. Other capability probes remain finding
24's scope.

**MC3 — empirical reward, honestly named.** One evaluation emits strict
`{scoreA: integer 0..4, scoreB: integer 0..4}` and no prose. Empirical criteria are padded to at
least two and capped at eight. Repeats are a positive multiple of 4, default/minimum 4. Per
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
`purpose:"empirical_pair_score"`. Per-COMPARING ceiling is 48 logical/provider attempts. Criteria
are truncated deterministically to fit while keeping at least two; if two cannot fit, fallback occurs
before calls. If any pair completes fewer than half its requested evaluations, the **whole empirical
selection** is abandoned and deterministic fallback ranks the frontier; empirical and deterministic
mass are never mixed. Completed usage remains recorded.

Each candidate payload includes exact verified CAS diff text, gate report and metrics. GATING
persists `diffRef`; missing or over-8,000-token diff causes whole-selection fallback before empirical
calls. Candidate text is fenced as untrusted data.

**MC5 — defined empirical pair mass.** Completed normalized rewards `Ra,Rb` produce
`pA = 1/(1+exp(-(Ra-Rb)))`, `pB=1-pA`. Each unique unordered pair contributes that win mass and one
comparison count to each candidate. Ranking is descending `winMass/count`, then id.

Independent fixture: `Ra=5/6`, `Rb=1/6`, `pA=0.6607563687658172`,
`pB=0.3392436312341828`. Expected literals may not call the mass function.

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
the two-family eligibility gate produces visible deterministic fallback in COMPARING. In REVIEWING,
zero probed-strict models terminates the run as `FAILED/providers_unavailable` before an axis call;
there is no schema downgrade. `sidecar` and `ts` remain explicit.

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
alternatives require the relevant state and never downgrade.

**AC3.** Exact provider payload asserts `json_schema`, name, strict, frozen schema and disabled
reasoning. Nex and NVIDIA return valid empty findings under that payload; the same NVIDIA request
without the reasoning option is recorded as an invalid response rather than support.

**AC4.** Two criteria × four repeats assert eight calls. For each criterion:
family0 normal/swapped, then family1 normal/swapped. A one-criterion input is padded to two; repeats
1/2/3 are rejected by config. Asymmetric matrices assert slot remap, completed-only mean, exact
normalized rewards and the independent MC5 sigmoid literals.

**AC5.** Family catalogs with duplicates and mutable quality stats still select deterministic first
refs from two distinct families. One-family and zero-family fixtures fall back with zero empirical
calls. Failure fixtures assert usage survives; one under-half pair abandons the whole empirical
selection, with no mixed mass; exact reason/requested/completed counts persist.

**AC6.** Pair-set literals: N=2 one pair; N=3 three; N=5 exact eight listed in MC6; N=8 exact
seventeen. Assert ring A/B participation, pivots `a,c`, no duplicate provider payment, sigmoid mass
and deterministic ranking. Assert `Ra/Rb/pA/pB` against MC5 literals without calling production
helpers. A 28-pair implementation fails.

**AC7.** Production COMPARING with two non-dominated candidates invokes broker-backed empirical
calls. Assert persisted `model.call` rows: two distinct free strict families, real refs,
`role:verifier`, `purpose:empirical_pair_score`, retry max 1. Assert default backend empirical and no
providerless judge call before it. Payload contains each candidate's actual CAS diff; missing and
over-cap diffs fall back before calls. Prompt contains composed base/task/judge and score contract.

**AC8.** Phase ceiling fixtures: N=3 / 8 input criteria / 4 repeats truncates to the first 4 criteria
and issues exactly 48 calls; rate-limit every call still stops at 48 and falls back visibly; N=5 and
N=8 cannot fit two criteria and fall back before calls. Strict probes are excluded from COMPARING
counts and independently broker-accounted.

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

## Named fakes

| Fake | Killer |
|---|---|
| `json_object` renamed “strict” | AC1 |
| Advertisement treated as probed support | AC2 |
| Advertise-then-400 remains true | AC2 |
| Null optionals rejected by Zod | AC1 |
| Same family evaluates every repetition | AC4 |
| Family remains coupled to A/B slot | AC4 |
| A/B reversal without score remap | AC4 |
| Failed evaluations counted as zeros | AC5 |
| Deterministic fallback mass mixed into empirical mass | AC5 |
| Ring pair paid again in pivot phase | AC6 |
| Full round-robin labelled PPT | AC6 |
| Candidate scores only metadata, not code diff | AC7 |
| Production still constructs providerless judge | AC7 |
| Empirical calls bypass broker | AC7 |
| Rate-limit storm exceeds 48 attempts | AC8 |
| Empirical votes labelled `direct` | AC9 |
| Sidecar claim stored as observed logprobs | AC9 |
| Model prose stored as verifier rationale | AC10 |
| Changed-denominator recall presented as improvement | AC11 |
| Strict and legacy requests share a replay key | AC12 |

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

## Out of scope

- Native Gemini transport solely to obtain logprobs.
- Passing API keys into the Python sidecar.
- A finding-level verifier filter before benchmark evidence justifies one.
- Progress/no-progress stopping (35 + 23).
- Worker execution state (31).
