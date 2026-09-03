# A12 Phase A invariant audit

## Verdict

**PASS. Phase A CLOSED.** Two independent closing auditors returned `blocking_findings: 0`
on the wrap/elision/rename/vite-config artifact. Orchestrator gates: `tsc`, A-scope eslint,
depcruise (196/1019), and `vitest run` **312/312**.

## Remaining findings

Non-blocking residue: waiver authority is a caller callback (omit = deny);
`skip_only` over-detects `runIf(true)` and `.skip(` string literals; a same-line
assertion fix on a failing `it()` can be over-flagged `removed_test`;
`MANIFEST_FILES` omits `vitest.config.mts`/`.js`/`.cjs`/`.cts` (introductions still
fail-close via `TEST_CONFIG` path matching).

## Resolved findings

1. **Severity: blocking (resolved).**
   - **Claim:** A persisted acceptance path alias could bypass pre-materialization candidate
     tamper detection. `./tests/fixtures/../protected.test.ts` and
     `tests/protected.test.ts` identify the same checkout file, but were formerly compared
     as different strings. Canonical materialization could then erase the candidate change
     and allow gates to pass.
   - **Evidence:** `src/domain/acceptance.ts:60-71` now canonicalizes separators and dot
     segments before building the protected set: `posix.normalize(...)`.
     `src/project/checkRunner.ts:286-304` compares canonical candidate paths and rejects
     before materialization. `src/project/project.test.ts:328-372` reproduces the alias
     attack and asserts `materializeAcceptance` is not called.
   - **Reproduction idea:** Record an acceptance artifact as
     `./tests/fixtures/../protected.test.ts`, submit a candidate changing
     `tests/protected.test.ts`, and run independent gates. The candidate must fail with a
     protected-path problem before CAS materialization.

2. **Severity: blocking (resolved).**
   - **Claim:** Engine-terminal runs could retain READY jobs forever. Scheduler dispatch
     correctly skipped terminal phases, but did not transition their queued jobs, leaving
     persistent non-terminal work that recovery could never execute.
   - **Evidence:** `src/engine/engine.ts:223-230` now cancels run work when termination is
     recorded. `src/scheduler/scheduler.ts:310-333` also aborts in-flight work and cancels
     PENDING/READY jobs whenever the owning run phase is terminal.
     `src/engine/engine.test.ts:248-267` enqueues late work after `DONE` and verifies it
     becomes `CANCELLED`, not stranded.
   - **Reproduction idea:** Advance a run to `DONE`, enqueue a READY job, tick the engine,
     restart/recover, and inspect the job projection. It must be `CANCELLED` and its handler
     must never run.

## A12 contract confirmation

- **A12.1 satisfied:** `src/domain/checks.ts:102-161` computes baseline-relative newly
  failing, missing, degraded, and diagnostic-change deltas; `src/project/checkRunner.ts:73-85`
  makes that delta the gate verdict.
- **A12.2 satisfied:** `src/project/checkRunner.ts:286-304` rejects candidate changes to
  canonical protected paths before `materializeAcceptance`; alias coverage is in
  `src/project/project.test.ts:328-372`.
- **A12.3 satisfied:** `src/store/missionAcceptance.ts:21-48` records corpus entries as
  causal events; shared mission replay preservation is implemented in
  `src/store/eventLog.ts:132-164,200-208`.
- **A12.4 satisfied:** `src/store/protectedChangeWaivers.ts:29-57` requires same-run,
  allowlisted evidence produced by an independent validator; exact scope matching is in
  `src/domain/protectedChangeWaiver.ts:62-73`.
- **A12.5 satisfied:** `src/sandbox/allowlist.ts:158-204` builds explicit check, package
  script, and task capabilities; `src/sandbox/allowlist.ts:210-285` constrains built-in
  read/search/git options and rejects external-command options.
- **A12.6 satisfied:** `src/intel/basic.ts:176-191` places `--` before the LLM-controlled
  ripgrep pattern; adversarial coverage is in `src/intel/intel.test.ts:53-82`.
- **A12.7 satisfied:** `src/context/facts.ts:35-48` requires an existing, allowlisted,
  same-run evidence event and records it in the causal chain; projection run-envelope
  matching is enforced by `src/store/projections.ts:226-244`.
- **A12.8 satisfied:** `src/context/facts.ts:78-115` orders duplicates by provenance
  strength, recency, then id, and preserves provenance/evidence references.
- **A12.9 satisfied:** `src/broker/observations.ts:64-79` resets per-call statistics while
  replaying global persisted quality observations; `src/broker/catalog.ts:101-117`
  preserves quality unless explicitly reset for replay.
- **A12.10 satisfied:** `src/intel/probe.ts:139-173` discovers commands/options and versions
  a contract; `src/intel/probe.ts:176-227` runs an isolated fixture query against the real
  binary.
- **A12.11 satisfied:** `src/domain/event.ts:53-72` gives every canonical event
  `schemaVersion: 1`; `src/store/migrations.ts:163-166` safely defaults existing histories;
  `src/store/eventLog.ts:240-247` rebuilds JSONL from canonical database events.
- **A12.12 satisfied:** `src/context/worker.ts:11-31,40-82` separates protected hierarchy,
  mission, base policy, and task sections from droppable content;
  `src/context/worker.ts:179-197` fails with `BUDGET_EXCEEDED` rather than truncating them.
- **A12.13 satisfied:** `src/context/worker.ts:109-123,142-156` fences repository fragments
  and retrieval hits as untrusted data/evidence beneath the explicit hierarchy.
- **A12.14 satisfied:** `src/project/cleanliness.ts:20-72` performs only porcelain
  inspection, rejects dirty trees by default, and requires an explicit synthetic snapshot
  reference for dirty inclusion; `src/engine/engine.ts:61-70` applies the policy before
  persisting a run.
- **A12.15 satisfied:** `src/project/checkRunner.ts:397-423` performs bounded confirmation
  only after contradictory observations and exposes persistable flakiness evidence.
- **A12.16 satisfied:** `src/project/checkRunner.ts:36-58,98-129` keeps complete
  stdout/stderr/diagnostics in an injected CAS artifact while returning a compact check
  summary and fingerprint.

## Verification

`pnpm check` passed after both fixes:

- typecheck: passed
- lint: passed
- dependency check: passed (`107 modules`, `521 dependencies`)
- tests: passed (`16` files, `206` tests)

The command emitted the existing environment warning that the repository requests Node
`>=24` while the audit runner used Node `22.18.0`; it did not affect the successful gate.

## Handoff closure — immutable Phase A identity

Final implementation verified in this chat: `5b4956d3f40739fb332b5a3ba2169468c6e28e28`
(tree `c06827ae0f5a409a456a62b6620590d534184e11`).

Isolated worktree gates on that commit, Node `v22.18.0` / pnpm `11.25.0`:

- `pnpm check` PASS (typecheck, eslint, depcruise **114/615**, vitest **21 files / 243 tests**)
- `pnpm build` PASS
- Engine warning: wanted Node `>=24`; not a Node-24 certification

Post-close findings 2.1–2.3 were present and are now fail-closed on that implementation
commit (corpus mission isolation, help-discovered CodeGraph dialect, exact package-script
argv). Finding 2.4 is this docs commit plus annotated tag `phase-a-accepted`.

B/C/D files that existed in the dirty working tree are **not** part of this accepted tree
and must not be read as Phase A accepted work.
