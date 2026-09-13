# B-selfhost-35 + 23 — prefix progress and test-only treadmill stop

**Status:** DRAFT, revision 1. Not frozen. Base `889b62d`.

## Scope

Two bounded early-stop mechanisms:

1. abandon a worker candidate whose observed state has stopped changing and whose prefix receives a
   unanimous minimum progress score;
2. stop a review/fix run after three accepted test-only checkpoints driven by validated blocking
   findings.

The first acts inside one worker rollout. The second acts across integrated checkpoints. Neither
changes review-quality semantics.

## MISSION_CRITICAL

**MC1 — progress schema and capability.** Add frozen strict schema
`{progress: integer 0..4}` with no additional properties. Active discovery probes it separately as
`supportsStrictProgressSchema`; only a validated broker-backed response is true. Advertisement,
timeout, malformed output and probe failure are false. Probe caching is keyed by model ref + schema
hash and uses the accepted bounded probe epoch.

**MC2 — bounded prefix packet.** Every completed worker turn is fed to a local progress tracker as
an observed step. A step contains assistant action names, tool-result success/failure and bounded
output/error tails; narration is fenced as untrusted. Each step is at most 300 estimated tokens and
the chronological prefix packet is at most 2,400 estimated tokens. It includes the task,
acceptance, current diff hash, changed paths and accepted-evidence count. It never contains a later
turn.

**MC3 — score only a deterministic plateau.** The runner records deterministic state snapshots at
turns 4, 8 and 12. A provider score is requested at turn 8 only when the turn-4 and turn-8 state
fingerprints and evidence counts are identical; likewise at turn 12 against turn 8. A changing
state makes zero progress-model calls at that checkpoint.

**MC4 — conservative two-family score.** A scoring checkpoint makes exactly two calls, one to the
lexicographically first free, probed-progress model in each of the first two distinct families.
Calls use strict schema, disabled reasoning, max output 64, retry 1,
`role:"verifier"` and `purpose:"agent_progress_score"`. Individual integer scores are retained;
the displayed score is their mean divided by 4. One/zero families or either failed call yields no
score and cannot abandon.

**MC5 — early abandon rule.** Earliest stop is turn 8. Abandon only when:

- state/evidence plateau in MC3 holds;
- both family calls completed;
- both returned literal `0`;
- the worker has not called `finish`.

At turn 12 the same rule applies. No average threshold, prose verdict, single-family vote or model
failure can abandon. Status is `ABANDONED_PROGRESS`, distinct from budget and worker failure.

**MC6 — bounded economics and observability.** At most two scoring checkpoints and four logical
progress calls per candidate; at most 9,600 estimated input tokens. Broker task/run budgets include
them. Transcript stores checkpoint turn, both model refs/scores, mean, state fingerprint and
decision. Emit `worker.progress_scored` and, only on stop, `worker.progress_abandoned`; model calls
remain first-class economics rows.

**MC7 — production wiring.** `createWorkerFactory` injects the tracker built from the same catalog,
broker and protocols as the worker. Progress is enabled by default for normal/complex coding tasks,
disabled for trivial and investigation tasks. Missing eligible models degrades to no tracker, never
to a heuristic score.

**MC8 — worker A/B.** A fixed 16-turn no-op scripted rollout is run with progress off and on. The
enabled arm stops at turn 8 after two progress calls and has lower combined estimated/provider token
usage than the 16-turn arm. A productive rollout whose diff changes at each checkpoint makes zero
progress calls and reaches its normal finish. A high-score plateau and a failed-score plateau both
continue.

**MC9 — checkpoint change provenance.** Successful INTEGRATING computes the actual
`git diff(previousHead, integratedCommit)` changed paths and writes a
`CheckpointChangeRecord` on `checkpoint.created`: task id, parent/head hashes, sorted paths,
classification and causal event id.

Classification is literal:

- test path: segment `test`, `tests`, `__tests__`, `__fixtures__`, or basename containing
  `.test.` / `.spec.`;
- neutral path: `docs/**`;
- `production` if any changed path is neither test nor neutral;
- `test_only` if at least one test path and none is production;
- `metadata_only` otherwise.

Empty or unavailable path evidence is `unknown`, never `test_only`.

**MC10 — pathology sample v2.** `PATHOLOGY_SAMPLE_VERSION` becomes 2. New samples carry all
checkpoint-change records through the boundary and task-origin records include
`originFindingId`. Historical v1 samples remain readable but cannot satisfy the new detector.

**MC11 — test-only treadmill detector.** Add convergence knob
`testOnlyCheckpointWindow`, default/minimum 3. The detector fires only when the last three distinct
checkpoint changes are all `test_only`, each task origin is `valid_finding`, and each linked finding
is blocking and currently `VALID` or `RESOLVED`. Production, metadata-only, unknown, mission,
investigation, missing-link or duplicate-checkpoint entries reset/prevent the window.

**MC12 — stop action.** Pathology kind `test_only_verification_treadmill` orders before ordinary
`no_progress` and maps directly to `NEEDS_HUMAN`; no ensemble change or rollback is attempted.
Evidence refs include the three checkpoint event ids, task ids and finding ids. The persisted
decision/effect path is the existing C2 path and remains replay-idempotent.

## PHASE_REQUIRED

**PR1.** Paid APIs remain forbidden. Progress models require both prices exactly zero.

**PR2.** Worker output/status without a tracker is byte-compatible except for the new optional
transcript progress field.

**PR3.** The full suite passes. At least one acceptance check fails on base `889b62d`.

## Acceptance checks

**AC1.** Independently inline both the progress JSON Schema and fail-closed probe matrix. Removing
the separate progress flag or accepting a pair-score probe as progress support fails.

**AC2.** Prefix fixtures with adversarial narration and oversized outputs assert exact 300/2,400
caps, chronological retained steps, fence, task/acceptance and absence of future markers.

**AC3.** Plateau fixture asserts no progress calls before turn 8, exactly two at turn 8, two distinct
free probed families, exact strict/reasoning/max/retry metadata and both raw scores. One-family,
paid, unknown-price and unprobed decoys are never called.

**AC4.** Stop matrix independently pins: `0+0` with plateau stops at 8; `0+1`, `0+failure`,
single-family, changed diff, changed evidence and an accepted `finish` do not stop. Status and event
types are literal.

**AC5.** A high plateau reaches turn 12, performs exactly four progress calls total and never calls
again. Re-entry/retry cannot exceed four calls for the same candidate transcript.

**AC6.** A/B pins worker calls, progress calls and combined usage for the 16-turn no-op. Productive
control changes the diff at turns 4/8/12, makes zero progress calls and finishes normally.

**AC7.** Production worker factory test observes the real broker `model.call` rows and transcript
progress records. Removing the injected tracker or bypassing broker fails.

**AC8.** Path classifier literal matrix covers POSIX and Windows separators, near misses such as
`src/contest/parser.ts`, mixed production+test, docs+test, docs-only and empty.

**AC9.** Production INTEGRATING fixture asserts exact base/head diff paths and
`checkpoint.created.payload.change`; deriving classification from candidate `diffRef`, task kind or
gate names fails.

**AC10.** Sample v2 fixture pins finding id/origin link and chronological checkpoint-change records.
Historical v1 and missing change records remain readable and do not trigger.

**AC11.** Detector positives: three distinct test-only checkpoints linked to three VALID blocking
findings. Independent negatives mutate each conjunct named by MC11. Existing `detectNoProgress`
does not substitute for the new kind.

**AC12.** Strategy fixture pins pathology order, direct `NEEDS_HUMAN`, evidence refs and persisted
idempotent decision/effect execution.

## Named fakes

| Fake | Killer |
|---|---|
| score every turn | AC3/AC5 |
| score before deterministic plateau | AC3/AC4 |
| average `0+1` into abandon | AC4 |
| one family votes twice | AC3/AC4 |
| model failure becomes zero | AC4 |
| tracker sees a future step | AC2 |
| progress calls bypass broker | AC7 |
| progress cost omitted from task budget | AC7 |
| task kind alone classifies test-only | AC9 |
| candidate diff, not integrated diff, supplies paths | AC9 |
| `contest` contains `test` | AC8 |
| docs-only counts as test-only | AC8 |
| duplicate checkpoint samples fill the window | AC11 |
| RAW/nonblocking finding qualifies | AC11 |
| ordinary canonical progress hides the treadmill | AC11 |
| treadmill changes ensemble instead of stopping | AC12 |

## Out of scope

- Enabling a finding-level semantic filter.
- Changing the accepted review stopping rule.
- Worker explicit state (31).
- General capability-probe budget repair outside the strict probes already brokered.
