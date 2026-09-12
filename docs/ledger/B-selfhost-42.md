# B-selfhost-42 — blinded reviewer-quality benchmark

**Status:** DRAFT, revision 2. Not frozen. Base `f782310`.
Revision 1 was rejected independently by Grok and Claude; both rejections were correct.
**Finding:** 42, informed by 43–45 in `docs/ledger/B-selfhost-remaining.md`.

## Mission

Measure whether Polish's reviewers find real defects productively. The old corpus cannot answer:
it predates the reviewer-parser repair and contains zero persisted findings. The first live probe
was contaminated because its acceptance text stated the defect. A later honest probe found one
defect twice, which proves capability but not hit rate.

This task builds the missing measurement. It changes no production review policy.

## Benchmark design

Eight isolated matched pairs. Each has one clean implementation and one implementation carrying one
injected defect. The single `correctness` axis is fixed for all cells.

The criterion id/property is carried inside the added source file in the `diff`, because the
production context pack has no acceptance or code field. Example:
`// INV-01: remaining budget is never negative`. It states a property, not the implementation
mistake. Each snippet has its own deterministic invariant suite: the named property plus at least
two sibling properties over the same module. The clean file passes all three; the mutant differs by
one substitution and fails only the named property.

The eight fixed defect families are: off-by-one boundary; null/zero conflation; first instead of
latest snapshot; swallowed failure reported as success; required prompt section present only on the
first turn; missing identity merged under a null key; recency used where priority governs; illegal
state-machine transition.

## MISSION_CRITICAL invariants

**MC1 — blind production packet.** The exact five-key production pack is
`{axis, checkpoint, commitHash, diffBase, diff}`. Every checkpoint field and every byte outside
`diff` is identical across a pair. The diff contains no clean/mutant label, mutation name, expected
claim or expected line. Opaque `cellId` exists only in the export wrapper and is never sent to the
model. The oracle maps `cellId` to label/range separately.

**MC2 — deterministic scoring.** A finding is a hit iff:

- it is schema-valid and `blocking === true`;
- its criterion contains the case's `INV-\d{2}` id as a whole token, case-insensitive;
- an evidence path equals the oracle path after stripping leading `./`, `a/` or `b/`;
- evidence has a `line`, and closed interval `[line, endLine ?? line]` overlaps the oracle interval.

Missing line never overlaps. The same rule applied to a clean control is a false positive.
Existential matching is used when several findings are returned. No model scores another model.

**MC3 — failures stay separate.** Transport failure, schema rejection and completed-empty review are
three outcomes. Failures do not enter recall, false-positive or discrimination denominators.
Completion rate is reported beside quality.

**MC4 — exact metrics.** Per model and for the two-model team, report completed mutant/clean cells,
recall, false-positive rate, pair discrimination, schema/transport failure rates, input/output
tokens and output tokens per true hit. Zero denominators are `null`.

Per-model discrimination key is `(pairId, model, repetition)`; it is eligible only when both clean
and mutant cells completed. Team key is `(pairId, repetition)`; it is eligible when each label has
at least one completed model. Team hit/false-positive is the OR across completed models. A pair is
discriminated iff mutant hit is true and clean false-positive is false.

95% Wilson intervals use `z = 1.96`, no continuity correction:
`center=(p+z²/2n)/(1+z²/n)`,
`margin=z*sqrt(p(1-p)/n+z²/4n²)/(1+z²/n)`, clipped to `[0,1]`.

**MC5 — finite schedule.** Exactly one `correctness` `runAxisReview` per logical cell:
`8 pairs × 2 labels × 2 model families × 3 repetitions = 96`. Order is deterministically shuffled
from a recorded seed. A failed cell is never requeued by the benchmark. Provider-internal retry is
outside the logical-cell count.

The live-only abort flag is off in deterministic tests. When enabled, after the 20th scheduled cell,
more than four transport failures persist a partial report and stop; no later cell runs.

**MC6 — exact production review path.** Each cell uses `reviewerSystemPrompt(..., "correctness")`,
the production five-key pack, `response_format: json_object`, `runAxisReview` parsing/normalisation
and evidence checking. A temporary corpus root materialises the snippet at the oracle-neutral path
and is passed as `repositoryRoot`; it is not a project worktree.

A recording `ProviderAdapter` wrapper captures exact request, raw response and usage before
`runAxisReview` parses it. A parser throw is `schema_failure` while captured body/usage remain.
Provider rejection is `transport_failure`; parsed `[]` is `completed_empty`. The benchmark never
implements its own reviewer parser.

**MC7 — two free families.** Live selection requires exactly one `nex-agi` and one `nvidia` catalog
model, both `supportsJson`, `inputCostPerM === 0`, `outputCostPerM === 0`, and distinct
`capabilities.family`. Missing either aborts before cell 1. No paid or one-family fallback.

**MC8 — auditable artifacts.** Report records corpus hash, exact system/user messages hash, model
refs/families, seed, cells, captured usage and metrics. Blinded packet JSONL and oracle JSONL are
separate UTF-8 artifacts, canonical key order, one JSON object per line, final newline; each hash is
sha256 of those exact bytes. Swapping files fails schema plus expected-hash checks.

Offline rescore feeds imported raw bodies through `runAxisReview` using a replay
`ProviderAdapter` and the same materialised root. It performs no provider call.

**MC9 — baseline portability.** Export wrapper carries opaque `cellId` plus the exact system/user
messages. An external flagship lane returns JSON keyed by `cellId`; import uses MC6 and MC2
unchanged. Missing token usage is `null`, never estimated.

## PHASE_REQUIRED

**PR1.** Corpus definitions and scoring are deterministic, provider-free unit code. Live execution
is RPC `benchmark.review`; CLI `polish benchmark-review` is a thin client. Paid APIs are forbidden.

**PR2.** The benchmark writes only CAS report/packet/oracle artifacts plus a temporary corpus root
used by evidence checking. It creates no coding Run, enters no phase machine, checks out no
worktree, and writes no project file. Benchmark usage lives in its own report; `polish cost` remains
the report for coding runs.

**PR3.** At least one acceptance check fails on the unmodified tree. Existing suite passes unchanged.

## Acceptance checks

**AC1 — blindness.** Capture exact `complete()` messages. Outside the `diff` value, clean and mutant
five-key packs are byte-identical, including every checkpoint/evidence field. Non-diff bytes contain
no oracle label, mutation name, expected claim, expected line or
`clean|mutant|defect|injected`. The diff contains the criterion property but no oracle. Opaque
`cellId` is absent from messages.

**AC2 — eight single-defect pairs.** Each pair has at least three invariant tests over its own
module. All clean controls pass their whole suite. Each mutant differs by one substitution and
fails only its named invariant within that suite.

**AC3 — scorer truth table.** Hand-written outputs cover: exact hit; criterion case-fold; wrong
criterion; `a/`/`b/`/`./` path prefixes; wrong file; missing line; non-overlapping line; line with
implicit `endLine`; nonblocking finding; several findings with one match; clean false positive;
completed empty; schema failure; transport failure. Assert classifications literally.

**AC4 — denominators.** A fixture with two hits, one completed miss, one schema failure and one
transport failure asserts recall `2/3`, completion `3/5`, and failures excluded from recall.

**AC5 — matched pair discrimination.** Assert per-model key `(pairId, model, repetition)` and team
key `(pairId, repetition)`. Hit plus clean false positive is not discriminated; hit plus clean empty
is. A pair with one failed side is excluded and counted separately. Team OR across models is tested.

**AC6 — intervals.** Wilson interval fixtures use these hand-written `z=1.96` literals:
`0/8 → [0, 0.3244156195108769]`,
`4/8 → [0.21521252682444186, 0.7847874731755582]`,
`8/8 → [0.6755843804891231, 1]`.
Expected values may not be produced by the function under test. Zero denominator returns `null`.

**AC7 — recording wrapper.** A response with usage and malformed JSON is captured, then
`runAxisReview` throws; the cell is `schema_failure`, and raw body/usage remain in its record. A
provider rejection is `transport_failure`; parsed `{"findings":[]}` is `completed_empty`.
Input/output sums and output tokens per hit are literal; zero hits returns `null`.

**AC8 — production path.** Scripted catalogs expose exactly one free JSON model in each of distinct
`nex-agi` and `nvidia` families. With live abort disabled, all 96 `correctness` cells run once
through `runAxisReview`. Assert logical request count, families, repetitions, exact prompt/pack,
normaliser and strong evidence from the materialised root. One schema failure remains a schema
failure with captured usage.

**AC9 — finite failure.** With live abort disabled, a provider that fails every cell receives
exactly 96 logical requests and records 96 transport failures. With it enabled, five transport
failures among the first 20 persist a partial report at exactly 20 and issue no 21st request.

**AC10 — artifacts and rescore.** Export packets and oracle separately, hash both, import a response
JSONL and reproduce byte-identical metrics without provider access. Swapping oracle and packet files
must fail schema/hash checks.

**AC11 — CLI/daemon seam.** RPC `benchmark.review` and CLI `polish benchmark-review` print the dry
summary; `--json` prints the full report. Scripted providers run in-process. No coding Run, phase
transition, project write or paid/live API occurs.

## Live measurement after implementation

Run only after deterministic acceptance:

- models: one `nex-agi` free model and one NVIDIA free model;
- three repetitions, 96 cells, no benchmark-level retry;
- enable the live abort rule from MC5;
- publish raw completion, recall, false-positive, discrimination and token metrics;
- export the same blind packets for a single Claude baseline; quality is comparable, cost remains
  unknown unless the lane reports usage.

No threshold is declared success in advance. This task measures; the result decides findings 31,
32/34/44 and 35/23.

## Named fakes

| Fake | Killer |
|---|---|
| Acceptance text names the mutation | AC1 |
| Clean and mutant paths differ | AC1 |
| Checkpoint evidence or ids reveal the label | AC1 |
| One pair contains two defects | AC2 |
| Any finding counts as a hit | AC3 |
| Wrong-line evidence counts as a hit | AC3 |
| Missing evidence line counts as overlap | AC3 |
| Schema failures counted as misses | AC4 |
| Clean false positives ignored in pair score | AC5 |
| Normal approximation used instead of Wilson | AC6 |
| Total output divided by completed reviews instead of hits | AC7 |
| Usage from a schema-rejected response is discarded | AC7 |
| Benchmark uses a simplified parser/prompt | AC8 |
| More than one review axis runs per cell | AC8 |
| One model family silently replaces the missing second family | AC8 |
| Failed cells requeued until completion | AC9 |
| Live abort applies to deterministic 96-cell tests | AC9 |
| Oracle embedded in exported packet | AC10 |
| External baseline scored by a different rubric | AC10 |
| CLI command exists but bypasses the daemon path | AC11 |
| Benchmark creates a coding Run or project worktree | AC11 |

## Revision history

**Revision 1 → 2**, after independent Grok and Claude reviews:

- rebuilt blindness around the real five-key production pack; criterion/property now lives in diff;
- pinned the single `correctness` axis and 96-cell arithmetic;
- defined exact criterion/path/range scoring and clean false positives;
- specified recording-wrapper capture before parser failure;
- defined per-model and two-model-team discrimination denominators;
- made the 20-cell abort live-only;
- replaced the impossible cross-snippet invariant claim with per-snippet suites;
- removed the coding-Run/`polish cost` coupling; benchmark usage stays in its own report;
- specified exact free-family selection, temporary evidence root, canonical artifacts and Wilson
  constants.

## Out of scope

- Changing reviewer prompts, models, axes or production policy.
- Grammar-constrained decoding and verifier scoring (findings 32/34/44).
- Replacing item 18's context architecture (finding 31).
- Claiming superiority over a flagship from eight cases. The baseline is diagnostic.
- Paid provider calls.
