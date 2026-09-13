# B-selfhost-42 — run record

**Status:** TASK ACCEPTED at `b055c81a6f1c42c0b14bede314803ae2f4d32309`.

## Provenance

- Base: accepted item 29, `f782310`.
- Frozen contract: revision 4 at `8c954a3`; reviewed body `0e678d2`, sha256
  `d74131812c38c6e15e3e2c0ad8c0f40fe699747eeedec3da4e96323754c910df`.
- Reviewers: Grok and Claude; coordinator: GPT-5.6 Sol.
- Acceptance: two consecutive clean rounds on unchanged `b055c81`.
- Gate: 777 tests / 81 files; typecheck, lint, dependency check and build clean on Node 24.20.0.

## Delivered

- Eight blinded clean/mutant pairs covering real Polish defect classes.
- Three local invariants per pair; clean passes all, mutant fails only the named property.
- Primary localisation recall, strict-id recall, clean-site false positives, Wilson intervals and
  per-model/team discrimination.
- Exact production prompt, parser, normaliser and evidence-checking path.
- 96-cell finite schedule, two free families, three repetitions, no benchmark requeue and per-cell
  timeout.
- Recording wrapper preserving raw body and usage across schema failure.
- Canonical packet/oracle artifacts and offline rescore through `runAxisReview`.
- RPC `benchmark.review` and CLI `polish benchmark-review`.

## Live measurement

Seed 43, 96/96 cells:

| Lane | Completion | Primary recall | Strict-id | False positives | Output tokens/hit |
|---|---:|---:|---:|---:|---:|
| `nex-agi/nex-n2.5-mini:free` | 70.8% | 20.0% | 15.0% | 14.3% | 10,006 |
| `nvidia/nemotron-3-super-120b-a12b:free` | 77.1% | 100.0% | 73.7% | 55.6% | 1,538 |
| Team | 74.0% | 82.6% | 65.2% | **60.0%** | 3,644 |

Team pair discrimination: **36.8%** (7/19 eligible). Failures: 11 schema and 14 transport over
96 logical cells. Tokens: 44,151 input + 69,244 output.

The initial live report used the pre-review team failure aggregation and was rescored offline from
its 96 persisted cells after that defect was fixed.

CAS:

- packets `bcb6c6dd43441787e2921b0d23b4d3021c18965cd5dcb1c881e6b6a9af629a65`;
- oracle `20b574ea200eed4b121e7112e93017be0c2f50ec7a50b44045786559c4a83fbb`;
- raw report `d7f63562457fb07ca95e399c7565319f9c8abafefa2de483a26b1279f0676cb8`;
- corrected rescore `b664122c992e1f77af2d4a11ca79100a463969e632bde60f426ecd0dbecdc932`.

## Decision

The free reviewer team is not ready to gate production policy: recall is high only by union, while
clean-site false positives are 60% and pair discrimination is 36.8%. NVIDIA is sensitive but noisy;
Nex is conservative but misses 80% of completed mutants. This supports the next planned work:
verifier scoring/sidecar and progress gating before changing the worker-state architecture.

No claim of superiority over a flagship is made; the exported blind packets permit that baseline.
