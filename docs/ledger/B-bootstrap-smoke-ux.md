# B-bootstrap-smoke-ux — Smoke readiness: discovery hints, intake re-entry, TTY observer

**Status:** ACCEPTED (Composer verifier, `blocking_findings: 0`; regex tightened after non-blocking over-match findings)  
**Class default:** PHASE_REQUIRED (bounded Phase-B production reliability; not Phase C)  
**Prompt:** Tiny production smoke `run_01m1mrwj926td69j47fea5` still did not reach coding execution.  
**Do not:** Phase C; remaining `B-selfhost-remaining`; hiding the defect by adding a lockfile to the fixture.

## Per-task BVP

- Implementer: Grok 4.6 (this chat)
- Deterministic gates (orchestrator): `pnpm check` PASS — 59 files / 468 tests
- Verifier: Composer 2.5 ([Adversarial smoke-UX review](6f46e5fb-ad11-47e5-a0f3-f29e3b546a08)) — PASS, `blocking_findings: 0`
- Fix round 1: narrowed `PROFILE_HINT_RE` to `framework=unknown` / `packageManager=null` only; added `profileHints.test.ts` so generic lockfile/API questions stay `needs_human`
- Non-blocking residue: SIGINT handler vs injected AbortSignal; `cli:link` stale-path not unit-tested; ~1 Hz heartbeat not timed in CI; interactive `run`→watch attach mocked at `runWatch`

`blocking_findings: 0`

## Root-cause class (captured smoke)

### 1. False `NEEDS_HUMAN` from profile hints

`fixtures/resume-dup-fetch` (copied to `/tmp/polish-smoke`) has a valid `package.json`, `scripts.test = "node --test …"`, no lockfile, no `package.json.packageManager`. Discovery produced `framework='unknown'` and `packageManager=null`. `defaultCheckCommands` still emitted `npm run test`; BASELINING executed it. Scope voted `needs_human` about those hints; that is not a human decision.

`FrameworkHintSchema` already included `node-test`; `detectFramework` never returned it. `detectPackageManager` looked only at lockfiles.

### 2. Duplicated council trio — not planner repair, not decompose

Raw events for `run_01m1mrwj926td69j47fea5`:

- seq 10–12: `council.role_resolved` (first `createCouncil`)
- seq 13–21: first complete `council_intake_{planner,scope,judge}` trio (`call_01m1mrwjhk…`), all `ok: true`
- **no** `supervisor.decision`, **no** `model.output_invalid` / repair
- seq 22–24: second `council.role_resolved`
- seq 25–33: second complete `council_intake_*` trio (`call_01m1mrx85x…`)
- seq 34: `supervisor.decision` intake `NEEDS_HUMAN` causedBy the **second** trio only

This is the same stage twice. Planner structured-output repair retries only the planner `complete()` (proven by test A: two planner calls, one scope, one judge). It cannot emit a second `role_resolved` or a second scope/judge call.

Mechanism: `DaemonService.tick` serializes `engine.tick()`, but `tickRun` had no per-run driver lock. After the first intake trio, a non-`OUTPUT_CONTRACT` throw (typically sibling JSON/`RoleOpinionSchema.parse` after the broker already recorded `model.call`) propagated out of `INTERPRETING_MISSION`. Daemon `tick()` had no `catch`, so the rejection was unhandled, `ticking` cleared in `finally`, and the next 50ms interval re-entered `INTERPRETING_MISSION` and paid for a second full trio. The first trio's opinions were discarded.

Fixes: per-run driver mutex; RoleAgent parse failures are `OUTPUT_CONTRACT` (pause, do not retry siblings); unexpected throws in `INTERPRETING_MISSION`/`PLANNING` pause the run; daemon `tick()` swallows after that pause so the interval cannot silently re-intake.

Observer now labels call purpose as `intake` vs `decompose`.

### 3–7. TTY, model names, attach-by-default, CLI setup, Node 24

See the matching tests. `humanizeModel` no longer splits on the `:free` colon. `polish run` attaches the watch TUI on an interactive TTY; `--detach`/`--json`/non-TTY do not. Ctrl-C restores the alternate screen and detaches observation only.

## Required behavior

1. `node --test` / `node:test` → framework hint `node-test`.
2. `package.json.packageManager` is read before lockfiles.
3. Missing PM/framework hints are informational. When mandatory check commands exist and baseline executed them, they must not become `NEEDS_HUMAN`.
4. One smoke intake = one `council_intake_*` trio (planner repair may add a second planner call only).
5. TTY watch uses the alternate screen, hides/restores the cursor, paints in place, heartbeats at ~1 Hz, bounds the activity region to terminal height. `--plain` is append-only.
6. OpenRouter `:free` IDs keep model identity (`MiniMax M3`, `Dots 3 Note Preview`, `GLM 5.2`).
7. Interactive `polish run` attaches watch. `--detach`/`-d`, `--json`, and non-TTY do not. Ctrl-C detaches; `polish watch RUN` reattaches.
8. `pnpm cli:link` requires Node >= 24, installs `~/.local/bin` shims even when `pnpm bin -g` is empty, and refuses a stale previous `which polish`.

## Deterministic evidence

- `discoverProject(fixtures/resume-dup-fetch)` → `node-test`, `packageManager=null`, executable `npm run test`.
- Intake with smoke-shaped profile + scope `needs_human` about those hints → `READY`, three `council_intake_*` purposes.
- Overlapping `tickRun` invokes the driver once; unexpected INTERPRETING_MISSION throw pauses and does not retry.
- Planner repair: 2 planner / 1 scope / 1 judge.
- TTY enter/exit sequences; plain mode emits each semantic event once; Ctrl-C watch uses only `status`/`log` RPC.
- `humanizeModel` cases above.
- `shouldAttachRunObserver` matrix.

## Out of scope

Phase C pathology/retry budgets; decompose schema repair; adding a lockfile to the smoke fixture; auto-starting another live smoke.
