# B-bootstrap-baseline-evidence — Baseline check output must be readable evidence, not a hash

**Status:** ACCEPTED  
**Class default:** PHASE_REQUIRED (bounded Phase-B production reliability; not Phase C)  
**Prompt:** Live smoke `run_01m1mvnrvpaye5yfssd5ev`. Mission was explicit; council `NEEDS_HUMAN` because baseline failure was represented only as `outputRef.sha256`.  
**Do not:** Phase C; remaining `B-selfhost-remaining`; fixture lockfile; regex-suppression of arbitrary council concerns.

## Per-task BVP

- Implementer: Grok 4.6 (this chat)
- Deterministic gates: `pnpm check` PASS — 59 files / 470 tests
- Verifier: Composer 2.5 ([Adversarial baseline-evidence review](5d0b2b01-3171-4de2-bb28-9498e20e582b)) — PASS, `blocking_findings: 0`

`blocking_findings: 0`

Non-blocking residue: live-model profile-hint noise is prompt-dependent (regex neutralization removed); unresolved judge `revise` still aggregates to `NEEDS_HUMAN`; artifact re-parse uses the node-test parser.

## Root-cause class (captured smoke)

BASELINING persisted a `check_output` artifact whose JSON already contains TAP stdout and compact `diagnostics` (`duplicate in-flight request detected`, `# fail 1`). `parseTestOutput` did not understand `node --test` / TAP, so `CheckResult.summary` was `null`. Council intake serialized the snapshot as-is: `status=fail` plus a sha256. Scope voted `needs_human` because it could not diagnose the failure. That is obtainable Polish evidence, not a product decision.

Judge also voted `needs_human` for a missing code proposal at intake (roles run in parallel; intake has no diff). That is a contract/prompt error, not a human question.

## Required behavior

1. Deterministic parser for Node `node --test` spec reporter and TAP: counts (`total/passed/failed/skipped`) and failing-test identity.
2. Before council intake, build a bounded `baselineEvidence` view from persisted `check_output` artifacts: command, status, exit, summary, compact diagnostics. Keep full stdout/stderr in CAS; prompt payload references the artifact, it does not inline the raw log.
3. Missing evidence Polish can obtain from repo/artifacts/commands is not a legitimate `NEEDS_HUMAN`.
4. Genuine semantic/product ambiguity remains `NEEDS_HUMAN`.
5. Do not suppress council concerns with regexes. Fix evidence availability and the council contract.
6. Human terminal `NEEDS_HUMAN` renders as waiting for input, not `NEEDS_HUMAN / RUNNING`. JSON keeps raw `phase` and `control`.

## Deterministic evidence

- Parser on exact resume-dup-fetch TAP/node-test output → 3 tests, 2 pass, 1 fail, failing identity includes `retries after transient failure and succeeds`.
- Evidence view includes diagnostics with `duplicate in-flight` and does not include full `TAP version 13` stdout.
- Intake payload uses that view; scripted approve → READY.
- Blocking API-compatibility ambiguity still `NEEDS_HUMAN`.
- Status text for genuine `NEEDS_HUMAN` contains `waiting for input` and not `NEEDS_HUMAN / RUNNING`; JSON view still has `phase: NEEDS_HUMAN` and raw `control`.
- `pnpm check`.

## Out of scope

Phase C; live smoke execution; changing the fixture to add a lockfile; worker/source-file ingestion at intake.
