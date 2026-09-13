# B-selfhost-35 + 23 run record

**Status:** ACCEPTED. Phase B remains open. Phase C is not accepted.

## Provenance

- Frozen base: `889b62d`.
- Frozen contract: revision 3 at `72bbe44`; reviewed body sha256
  `24acac09945bf579b299c5a07268160573fe812e59d172d3e81cc59d86c3b28c`.
- Initial implementation: `632d55b`.
- Accepted implementation: `0dc54b0`.
- Base negative controls:
  - `src/agents/progressTracker.ts` absent at `889b62d` (`git cat-file` exit 128);
  - `src/convergence/pathology/changeClassification.ts` absent at `889b62d` (exit 128).

## Delivered

- Separate fail-closed `{progress:0..4}` capability probe, cache and catalog flag. It does not alter
  the accepted review-probe epoch predicate.
- Per-rollout prefix tracker for normal/complex coding tasks only. It scores deterministic plateaus
  at turns 8 and 12 through two distinct free model families.
- Abandonment requires two completed literal zero scores. Model failure, one family, `0+1`, changed
  diff, changed live evidence and accepted finish cannot abandon.
- Progress packets retain action/result evidence under 300 tokens per step, stay under 2,400
  on-wire tokens per call, and fail closed without affecting the worker on metadata overflow.
- At most four task-attributed broker calls and 9,600 estimated progress-input tokens per candidate;
  transcript and event-log records distinguish scored and abandoned workers.
- Successful integration records the durable `previousHead..integratedCommit` changed paths and a
  literal production/test-only/metadata/unknown classification.
- Pathology sample v2 links checkpoint, task origin and current finding status by event sequence.
- `test_only_verification_treadmill` detects a configurable window of validated blocking
  test-only fixes and goes directly to replay-idempotent `NEEDS_HUMAN`.

## Verification

Node 24.20.0:

- `pnpm typecheck` — pass.
- `pnpm lint` — pass.
- `pnpm deps:check` — pass, 285 modules / 2,104 dependencies.
- `pnpm test` — pass, 85 files / 860 tests.
- `pnpm build` — pass.

The scripted 16-turn A/B used identical no-op workers:

- progress off: 16 worker calls, 240 scripted tokens;
- progress on: 8 worker calls + 2 progress calls, 150 combined scripted tokens;
- reduction: 6 calls and 90 tokens (37.5%) on the deliberately hopeless fixture.

The productive control changed its diff at turns 4/8/12, made zero progress calls and finished
normally. High-score plateaus ran through turn 32 with only the two bounded scoring checkpoints.

Live strict-schema smoke probes:

- `nex-agi/nex-n2.5-mini:free` returned `{"progress":0}` in 6 output tokens;
- `dots-studio/dots-3-note-preview:free` returned `{"progress":0}` in 6 output tokens;
- NVIDIA was temporarily overloaded, which correctly yields no capability and no abandonment.

## Review history

- Initial `632d55b`: Grok PASS; Claude PASS.
- Follow-up `0dc54b0` preserved action/result evidence before narration truncation and strengthened
  fail-closed progress, RESOLVED-status and persisted-lifecycle assertions.
- Clean Round 1, `0dc54b0`: Grok PASS; Claude PASS.
- Clean Round 2, unchanged `0dc54b0`: Grok PASS; Claude PASS.

This satisfies two consecutive clean rounds from both required external families on the same
commit.
