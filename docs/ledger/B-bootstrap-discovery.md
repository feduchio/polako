# B-bootstrap-3 — Bounded discovery + probe INCONCLUSIVE (self-host launch blocker)

**Status:** ACCEPTED (verifier round 3 — zero VALID blocking)

## Per-task BVP

- Implementer round 1: [Bounded discovery + probes](cebccc6c-b8bc-409d-b674-f152dac8c290)
- Verifier round 1: [Verify bounded discovery](6289c570-8edb-4005-90f0-7f83421bf737) — FAIL (stop+prose, timeout)
- Implementer round 2: [Fix probe verdict matrix](4785a60d-0b01-4b83-ae9b-2e8580068f5c)
- Verifier round 2: [Reverify probe verdicts](1d2347aa-d8de-4dec-b016-827124bf15be) — FAIL (`finish=error` / `content_filter`)
- Implementer round 3: [Fix remaining probe finishes](2889232e-9b8b-4398-a044-9467955194b6)
- Verifier round 3: [Reverify probe taxonomy v3](cc52ef77-f95b-471f-b59b-1aba74b2de86) — PASS, `blocking_findings: 0`
- Deterministic gates: orchestrator `pnpm check` PASS — 48 files / 409 tests
- Non-blocking (not deferred B requirements): discover-without-cap if `maxProbesPerProvider` omitted; unknown price as $0; pinned ref mismatch vs `listModels`; no driver-level 50-model test

`blocking_findings: 0`

## Verifier round 1

- Verifier: [Verify bounded discovery](6289c570-8edb-4005-90f0-7f83421bf737) — FAIL
- VALID blocking (must fix; do not weaken):
  1. Tools probe `finish=stop` + prose (no tool_calls) currently `unsupported` and clears declared `supportsTools`. Contract: unsupported = explicit refusal / capability-denying error only. Stop/text without tools is INCONCLUSIVE (same worker-emptying failure mode as `length` for thinking models). Test `clears capabilities when probes fail but health succeeds` encodes the bug — replace it.
  2. `ProviderError` kind `timeout` is classified `probe_failed`. Ledger: timeout-without-denial is INCONCLUSIVE.
- Non-blocking: leave for later (unbounded discover without maxProbes, unknown price as $0, pinned ref mismatch, missing driver-level test).

## Verifier round 2 (from zero)

- Verifier: [Reverify probe verdicts](1d2347aa-d8de-4dec-b016-827124bf15be) — FAIL
- Round-1 holes gone (stop+prose, timeout).
- VALID blocking remaining:
  1. Tools `finish=error` or `content_filter` (no tool_calls) still `unsupported` and clears declared `supportsTools`. `mapFinish` default maps unknown Gemini reasons to `error`. Tools `unsupported` only via `ProviderError` `bad_request`. Any other completed tools probe without `tool_calls` is INCONCLUSIVE.
  2. JSON: `finish=error` even with valid JSON is `unsupported` because supported requires `finishReason !== "error"`. Valid JSON is supported; `error`/`content_filter` without JSON is INCONCLUSIVE; completed `stop` with non-JSON may stay unsupported for json.

## Required behavior
**Class default:** PHASE_REQUIRED
**Plan:** Fable §7 / §17 B11 bounded operational discovery. User contract §§19–20.
**Prompt:** Do not probe every listed model. Do not treat `finish=length` as "no tool calling". Do not implement C8 audition.

## Why this is still Stage-1

ScriptedProvider daemon E2E is ACCEPTED. A live self-host run against the user's OpenRouter+Gemini config would call `listModels` then probe **every** model (B11 live listing: 424 OpenRouter models). That prevents a real coding mission. Probe `maxTokens: 32` + `finish=length` already marked Gemini flash as no-tools (B11 ledger). Worker factory `requireTools: true` would then have no workers.

This is not the remaining B list. It is the last launch blocker before host/target self-host.

## Source-plan references

- Fable §7 Model Broker; §17 B11 adapters + probes (not C8).
- User §19: health once → list → declared metadata filter → pricing/free → context/capability → shortlist → probe only shortlist. Probe count bounded and testable.
- User §20: SUPPORTED / UNSUPPORTED / INCONCLUSIVE / PROBE_FAILED. `length` ≠ unsupported. INCONCLUSIVE is not a permanent downgrade. Declared capabilities are input evidence; probes are additional.
- User §15: `retry.maxAttempts` must not be `worker.maxTurns`. Separate `agent.maxTurns` (simple cap, not C2).

## Required behavior

1. `catalog.discover({ capabilityProbe })` (production DISCOVERING_MODELS) must:
   - call provider `health` at most once per provider per discover;
   - `listModels` once per healthy provider;
   - upsert **all** listed models from declared metadata without probing them all;
   - build a shortlist using declared capabilities + price/free (prefer free/cheap, require declared tools for worker-capable shortlist) + always include models pinned in `config.supervisors`;
   - probe **only** the shortlist;
   - cap probes per provider via config (e.g. `discovery.maxProbesPerProvider`, default ≤ 8). Pinned supervisor models count first and are not dropped by the cap.
2. Probe results distinguish:
   - tools/json **supported**
   - **unsupported** (explicit refusal / provider error that clearly denies the capability)
   - **inconclusive** (`finish=length`, truncated, empty, timeout-without-denial)
   - **probe_failed** (transport/throw)
3. INCONCLUSIVE / PROBE_FAILED must not set `supportsTools=false` (or `supportsJson=false`) over declared-true metadata. Model stays available if health ok. May be retried later; not permanently unsupported.
4. Probe `maxTokens` must be large enough for thinking models (not 32). Configurable, default ≥ 256.
5. `createWorkerFactory` uses `config` agent turn cap, **not** `retry.maxAttempts`. Add `agent.maxTurns` (and keep `budget.maxTaskTokens` for tokens). Defaults: maxTurns ≥ 32. Task retry policy stays `retry.*`.
6. Tests (temp providers, no real keys):
   - 50 listed models, `maxProbesPerProvider=3` → exactly 3 probe call-pairs (or 3 models probed) plus any pinned extras, never 50.
   - tools probe `finish=length` → INCONCLUSIVE, declared `supportsTools` preserved, model available.
   - `maxTurns` comes from agent config, not retry.maxAttempts (unit on createWorkerFactory or AgentRunner wiring).

## Forbidden

- C8 audition strategy / systematic eval.
- C2 pathology/adaptive budget engine.
- Probing all models "because we need quality".
- Treating length as unsupported.
- Changing FSM.
- Real API keys in tests.

## Deterministic evidence

- Targeted broker/catalog/probe tests + `pnpm check`.

## Cross-module

- Production path: `createDiscoveringModelsDriverFromCatalog` in `src/daemon/composition.ts`.
- Pinned council still does not require discovery (B-bootstrap-1). Shortlist must still include pinned refs so later worker/reviewer routing can probe them.
