# B-selfhost-29 — run record

**Status:** TASK ACCEPTED at `3d718313e8c341432e2c20d636d55bad2c3282eb`.

## Provenance

- Base: `93bd7b6`.
- Frozen contract: `docs/ledger/B-selfhost-29.md`, revision 7, freeze `308da0c`.
- Reviewed contract: `431def2`, sha256
  `1ecc4612285bc5d724eaba2f0e6ced193c5277fd244f3bc98da4bc1d60d2e345`.
- Reviewers: Grok and Claude; coordinator: GPT-5.6 Sol.
- Acceptance: two consecutive clean rounds on unchanged `3d71831`.

## Delivered

- Pure event-log projection in `src/observe/economics.ts`.
- `polish cost <run-id> [--json]`.
- Input/output/call totals by role, purpose and task.
- Honest USD state: known zero versus unknown, with disjoint null-cost/null-usage counts.
- Review rounds, axes, completion/failure causes, raw/latest-valid finding yield and
  output-tokens-per-finding.
- Candidate count and maximum attempt per task.
- Run terminality and final task states.
- Dry text report plus complete JSON.

## Real-corpus verification

The projection was run against all six historical runs in `~/.polish/polish.db` and reproduced:

- 1,060,632 total tokens;
- reviewer 834,635 (78.7%), worker 182,900 (17.2%), council 43,097 (4.1%);
- reviewer 138,414 input / 696,221 output;
- 11 null-cost and 85 null-usage logical calls;
- 2,600 review executions, 18 completed, zero historical findings;
- failure causes: 2,465 rate-limit, 108 schema, 6 bad-request, 1 timeout, 2 other.

Every role, purpose and task breakdown sums to the run total. All council tokens land in the
explicit unassigned-task bucket.

## Review history

The contract required seven revisions. Reviews corrected false corpus claims, an unsatisfiable
task breakdown, ambiguous call/finding identities, non-exclusive failure classification, missing
input/output separation and weak equal-valued fixtures.

Implementation round 1 found no production arithmetic defect but eight unobserved contract clauses.
Tests were strengthened without changing the fold. Round 2 and the confirming round were both clean
on `3d71831`; 748 tests across 77 files, typecheck, lint, dependency check and build passed.

## Result

Cost and productivity claims are now mechanically inspectable. The report does not claim reviewer
quality from the old corpus: those runs predate the reviewer parser repair and contain no findings.
Finding 42 remains the measurement of current reviewer hit rate on an unbiased mutation corpus.
