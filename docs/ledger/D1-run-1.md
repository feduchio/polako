# D1 attempt 1 — the first run against a real external project

| Field | Value |
|---|---|
| Run | `run_01m2gy5yg30631j247sn13` |
| Target | `/Users/fedorsvetlov/screen-audit-toolkit` at `38704d1` — npm, `package-lock.json`, 373 tests |
| HOST | `7836418` (F54 accepted at `43f6d7a`) |
| Flags | `--runtime auto --budget-tokens 2000000` |
| Outcome | `FAILED` after 3m16s, in `GATING`, with the free-model daily quota exhausted |

## What this attempt was for

`docs/PLAN.md` phase D, item D1: a run on a real user project, which the plan named as the proof
the product works and which had never been done. Finding 54 was its precondition, because the first
external project ever targeted (P2.3, `unjs/defu`) produced a baseline saying a healthy repository
was broken.

## The precondition held

```
shell.command_finished  check=dependency_install  command=["npm","ci"]  exitCode=0  durationMs=3094
baseline.snapshotted    test:pass(373)  typecheck:pass  build:pass
```

A fresh worktree with no `node_modules`, a project whose test command is
`node --import tsx --test "src/**/*.test.ts"` and whose manifest declares six dependencies. Before
F54 this baseline was three `fail` results with fingerprints, and every later comparison would have
been relative to a lie. It is now three passes and a 373-test count.

**This is the first true baseline Polish has ever taken of a project that is not its own fixture.**

## Where it stopped, and why that is not the product's fault

The mission was interpreted, ten tasks were planned, and the first task ran five attempts of two
candidates each. Every one of them failed the same way:

```
ProviderError: rate limited: Rate limit exceeded: free-models-per-day
```

96 rate-limit observations across `nvidia/nemotron-3.5-lightning:free` and
`dots-studio/dots-3-note-preview:free`. The daily free-model quota was already spent. No candidate
ever produced a commit, so **candidate gating never ran**, and the half of finding 54 that installs
dependencies per gate checkout is still unexercised outside the suite.

Each of the 22 discarded candidates carries the provider error on `Candidate.error`, which is MC18
of F54 doing exactly what it was added for: the discards are legible as an infrastructure fact
rather than as a verdict on the work.

## The defect this attempt found

The **run** reached `FAILED` with `terminalReason: null`. Every candidate says why it was discarded;
the run says nothing. An operator running `polish status` on a failed run sees a phase and no
reason, which is the condition finding 37 established a precedent against and F54 round 5 fixed for
the environment case only. Recorded as finding 55.

## Mission used

Two bounded corrections to the toolkit's own measurements, chosen from a read-only survey because
both are provable by `npm test` without a device: charge a cluster instance for its own
`selfDurationMs` rather than for the whole commit it appeared in, and make visible that per-owner
self-duration totals are built from at most 40 sampled updates per commit while `updateCount`
carries the full total. The readiness criterion named the two tests that must fail without the
changes.

## Next

Re-run when the quota resets. The baseline half is proven; what is still unproven end to end is
everything after a worker succeeds — gating with a per-candidate install, comparison, integration.
