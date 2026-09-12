# B-selfhost-42 — blinded reviewer-quality benchmark

**Status:** DRAFT, revision 1. Not frozen. Base `f782310`.
**Finding:** 42, informed by 43–45 in `docs/ledger/B-selfhost-remaining.md`.

## Mission

Measure whether Polish's reviewers find real defects productively. The old corpus cannot answer:
it predates the reviewer-parser repair and contains zero persisted findings. The first live probe
was contaminated because its acceptance text stated the defect. A later honest probe found one
defect twice, which proves capability but not hit rate.

This task builds the missing measurement. It changes no production review policy.

## Benchmark design

Eight matched pairs. Each pair has:

- one clean implementation and one implementation carrying exactly one injected defect;
- identical intent, acceptance text, file path and surrounding code;
- an opaque case id and a criterion id such as `INV-04`;
- a hidden oracle: mutant/clean label, criterion id, evidence path and line range;
- a blinded packet containing no label, oracle, mutation name or expected claim.

The acceptance text states a property, never the implementation mistake. Example:
`INV-01: remaining budget is never negative`, not `clamp cap - spent at zero`.

The eight defect families are fixed:

1. off-by-one boundary;
2. null versus zero conflation;
3. first snapshot used instead of latest;
4. swallowed provider/parse failure reported as a successful verdict;
5. required prompt section present only on the first turn;
6. missing identity merged into a shared null key;
7. recency used where priority governs;
8. illegal state-machine transition.

These are real defect classes already found in Polish. The benchmark snippets are minimal and
contain no second defect.

## MISSION_CRITICAL invariants

**MC1 — blind.** The exact packet sent to a reviewer contains no oracle field, clean/mutant label,
mutation name, expected claim, expected line or text unique to one label outside the code itself.
Pair ids are independently shuffled per repetition. The scorer receives the oracle separately.

**MC2 — matched controls.** Within a pair, criterion, acceptance, file path, context and token budget
are byte-identical. Only the code bytes required to inject/remove the defect differ, and the clean
and mutant code strings have equal byte length. A reviewer cannot classify from metadata or prompt
length.

**MC3 — deterministic scoring.** A mutant is a hit only when a schema-valid **blocking** finding
names the criterion id and its evidence path/range overlaps the hidden oracle range. A clean control
produces a false positive under the same rule. No model judges another model's answer.

**MC4 — failures stay separate.** Transport failure, schema rejection and completed-empty review are
three different outcomes. Neither failure type enters recall or false-positive denominators.
Completion rate is reported beside quality, so a model cannot look precise by failing often.

**MC5 — metrics.** Per model and for the union of the two free reviewer lanes, report:

- completed mutant/clean cells;
- mutation recall;
- clean false-positive rate;
- pair discrimination rate: mutant hit and matched clean control has no false positive;
- schema and transport failure rates;
- input tokens, output tokens and output tokens per true hit;
- 95% Wilson intervals for recall and false-positive rate.

Every zero denominator is `null`, never zero or infinity.

**MC6 — repeats and ordering.** Two distinct free model families, three repetitions per cell:
`8 pairs × 2 labels × 2 models × 3 = 96` requested reviews. Order is deterministically shuffled from
a recorded seed. A cell is attempted once; provider/broker retry policy may act internally, but the
benchmark never requeues a failed cell. This prevents another review storm.

**MC7 — exact production path.** Reviews use `reviewerSystemPrompt`, the production context-pack
shape, `response_format: json_object`, `runAxisReview` parsing/normalisation and evidence checking.
A custom benchmark-only parser or prompt is forbidden.

**MC8 — auditable result.** The report records corpus hash, prompt/protocol hash, model refs,
repetition seed, requested/completed counts, per-cell outcome, token usage and aggregate metrics.
The blinded packets and hidden oracle are separate artifacts. Results can be rescored offline
without a provider call.

**MC9 — baseline portability.** Exported blinded JSONL can be reviewed by one external lane and its
JSON responses imported through the same production parser and deterministic scorer. This permits a
single flagship baseline without exposing the oracle. If token usage is unavailable for that lane,
cost is reported as unknown rather than estimated.

## PHASE_REQUIRED

**PR1.** Corpus definitions and scoring are deterministic, provider-free unit code. Live execution
is behind a daemon/CLI command and uses routing constrained to `free_only`; paid APIs are forbidden.

**PR2.** The benchmark emits one persisted summary event and artifacts, so `polish cost` can account
for its reviewer calls. It must not write source files or mutate a project worktree.

**PR3.** At least one acceptance check fails on the unmodified tree. Existing suite passes unchanged.

## Acceptance checks

**AC1 — blindness.** Serialize every blinded packet and assert none contains its pair's oracle label,
mutation name, expected claim or expected line. Assert the clean and mutant packet metadata are
identical after replacing only the code field.

**AC2 — eight single-defect pairs.** Execute each snippet's deterministic invariant test: all eight
clean controls pass; each mutant fails exactly its named invariant and no other invariant.

**AC3 — scorer truth table.** Hand-written reviewer outputs cover: exact hit, wrong criterion, wrong
file, non-overlapping line, nonblocking finding, clean blocking finding, empty review, schema failure
and transport failure. Assert classifications literally.

**AC4 — denominators.** A fixture with two hits, one completed miss, one schema failure and one
transport failure asserts recall `2/3`, completion `3/5`, and failures excluded from recall.

**AC5 — matched pair discrimination.** A mutant hit paired with a clean false positive does not count
as discriminated. A hit plus clean empty does. Assert both.

**AC6 — intervals.** Wilson interval fixtures use hand-written values for `0/8`, `4/8`, `8/8`;
implementation must not derive expected values through its own function.

**AC7 — token efficiency.** Input/output usage is summed from every provider response that returned
usage, including a response whose body later fails schema parsing. A transport failure contributes
usage only if the provider/broker recorded it. Output tokens per true hit is literal on a fixture
and `null` at zero hits.

**AC8 — production path.** Scripted providers run all 96 scheduled cells through `runAxisReview`;
assert request count, two model families, three repetitions, production prompt prefix, parser,
normaliser and evidence-strength result. One scripted schema failure remains a schema failure rather
than a miss.

**AC9 — no benchmark retry.** A provider that fails every cell receives exactly 96 logical cell
requests, not 97. The persisted report records 96 transport failures and terminates.

**AC10 — artifacts and rescore.** Export packets and oracle separately, hash both, import a response
JSONL and reproduce byte-identical metrics without provider access. Swapping oracle and packet files
must fail schema/hash checks.

**AC11 — CLI/daemon seam.** `polish benchmark-review` prints the dry summary and `--json` prints the
full report. The test uses scripted providers and no paid/live API.

## Live measurement after implementation

Run only after deterministic acceptance:

- models: one `nex-agi` free model and one NVIDIA free model;
- three repetitions, 96 cells, no benchmark-level retry;
- stop the whole measurement if more than 20% of the first 20 cells are transport failures;
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
| One pair contains two defects | AC2 |
| Any finding counts as a hit | AC3 |
| Wrong-line evidence counts as a hit | AC3 |
| Schema failures counted as misses | AC4 |
| Clean false positives ignored in pair score | AC5 |
| Normal approximation used instead of Wilson | AC6 |
| Total output divided by completed reviews instead of hits | AC7 |
| Benchmark uses a simplified parser/prompt | AC8 |
| Failed cells requeued until completion | AC9 |
| Oracle embedded in exported packet | AC10 |
| External baseline scored by a different rubric | AC10 |
| CLI command exists but bypasses the daemon path | AC11 |

## Out of scope

- Changing reviewer prompts, models, axes or production policy.
- Grammar-constrained decoding and verifier scoring (findings 32/34/44).
- Replacing item 18's context architecture (finding 31).
- Claiming superiority over a flagship from eight cases. The baseline is diagnostic.
- Paid provider calls.
