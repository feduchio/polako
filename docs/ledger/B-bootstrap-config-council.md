# B-bootstrap-1 — Production config loader + pinned Supervisor Council + daemon E2E without pre-discover

**Status:** ACCEPTED (verifier round 1 — zero VALID blocking)

## Per-task BVP

- Implementer: [Config+council bootstrap](e14ac132-6a5a-406f-a368-ba8562e17cdf) (Composer)
- Deterministic gates: orchestrator `pnpm check` PASS — 47 files / 399 tests
- Verifier attempt 1: GPT-5.6 — aborted at startup (Other Models quota); no verdict
- Verifier round 1: [Retry adversarial verifier](383ab9ae-b645-4a2a-a036-91a3f9e836db) (Grok, different family from implementer) — PASS, `blocking_findings: 0`
- Non-blocking (not deferred Phase-B requirements; leftover test/UX tightness): unknown TOML keys stripped by Zod; daemon E2E does not assert pinned model ids on PLANNING `model.call`; `SecretStore.fromFile` still falls back to `process.env`

`blocking_findings: 0`

**Class default:** PHASE_REQUIRED
**Plan:** Fable §7 Model Broker; §17 B7 Supervisor council v1; §17 B9 Daemon + CLI; §17 B11 real providers; user contract §§3–8.
**Prompt:** production CLI/daemon must consume `~/.polish/polish.toml` + `secrets.env`; pinned council from `config.supervisors`; INTERPRETING_MISSION must not require test-body `catalog.discover()`.

## Source-plan references

- Fable §0: keys live in `~/.polish/secrets.env`.
- Fable §7: ProviderAdapter, ModelCatalog, Router, secrets.
- Fable §17 B7: Planner / Scope Guardian / Judge from user-assembled council.
- Fable §17 B9: unix-socket RPC, autostart, one production composition.
- Fable §5 FSM: `BASELINING → INTERPRETING_MISSION → DISCOVERING_MODELS → PLANNING` (do not reorder unless pinned council is proven).
- User contract §3: configuration stays outside the repository.
- User contract §6: catalog must be ready before the first *dynamic* council/router request; pinned council may load from explicit config.
- User contract §7: `config.supervisors` must be honored; Broker is for workers/reviewers and fallback only.

## Phase-B requirement

Production entrypoint:

```
CLI/RPC → DaemonService → load ~/.polish/polish.toml → secrets.env
  → enabled providers → apiKeyEnv resolution
  → ProviderAdapter construction → ModelCatalog/Router
  → pinned Supervisor Council (planner / scope_guardian / judge)
  → INTERPRETING_MISSION without prior catalog.discover()
  → DISCOVERING_MODELS (workers/reviewers)
  → PLANNING with the same pinned council
```

## Global invariants

- Secrets never appear in logs, events, or tests.
- Tests use a temporary `HOME` / `.polish` with fake credentials, never the user's real keys.
- Do not move provider configuration into the repository.
- Do not implement C8 Model Audition.
- Do not change semantic roles to make the FSM pass.
- Supervisor Council is user-pinned; workers/reviewers remain dynamic after discovery.

## Required behavior

1. `DaemonService` / `polishd` loads `join(home, "polish.toml")` when present; missing file → `defaultConfig()` (current defaults), not a crash.
2. Parse TOML into `PolishConfigSchema` (providers, supervisors, runtime, budget, lanes, etc.).
3. `SecretStore.fromFile(join(home, "secrets.env"))` remains the credential source.
4. `loadConfiguredProviders`:
   - `scripted` / `record-replay` may load without `apiKeyEnv`;
   - live kinds (`openrouter`, `gemini`, `groq`) require enabled + `apiKeyEnv` present in secrets.
5. `resolveCouncilRoles` must use `config.supervisors` when a role is pinned (`planner`, `scope_guardian`, `judge`). Each execution records provenance: provider, model, role, `config_source=pinned` or `fallback_reason`.
6. Dynamic `router.select` is used only when a role is not pinned.
7. INTERPRETING_MISSION with pinned council must succeed with an empty catalog (no `catalog.discover()` beforehand).
8. A daemon/RPC regression test must:
   - create a temp HOME with `polish.toml` + fake `secrets.env`;
   - start `DaemonService` (or RPC) with production drivers;
   - **not** call `catalog.discover()` from the test body;
   - **not** replace production phase drivers;
   - drive a ScriptedProvider fixture at least through interpretation + planning (coding DONE may follow if scripts allow; minimum is council intake + decompose without pre-discover).

## Forbidden shortcuts

- Leaving `this.config = defaultConfig()` as the production path.
- Reading the developer's real `~/.polish/secrets.env` in unit tests.
- Logging or asserting full API key values.
- Manually calling `catalog.discover()` before INTERPRETING_MISSION in the new daemon test.
- Replacing production drivers with stubs/test drivers.
- Silently substituting Broker-selected models for a pinned council.
- Reordering FSM solely to hide the empty-catalog bug while still ignoring `config.supervisors`.
- Implementing C2/C8/C6.

## Deterministic evidence

- Unit: temp HOME, `polish.toml` with two providers + three supervisor pins → `DaemonService` config/providers/council match.
- Unit: live provider entry without secret is skipped; scripted entry without `apiKeyEnv` is loaded.
- Unit: pinned council provenance events/fields exist.
- Daemon-level: INTERPRETING_MISSION + PLANNING without test-body `catalog.discover()`.
- Existing `pnpm check` stays green.
- No real secrets in git or test fixtures.

## Cross-module invariants

- `src/daemon/service.ts` owns loaded config for the daemon process.
- `src/daemon/composition.ts` `buildProductionDeps` / `resolveCouncilRoles` consume that config.
- `src/engine/councilDrivers.ts` FSM order stays `INTERPRETING_MISSION → DISCOVERING_MODELS → PLANNING`.
- CLI flags still override per-run runtime/budget *later*; this task must not mutate global runtime mode as a substitute for loading config (leave run-scoped runtime to the next bootstrap task if needed). Do not expand into budget engine (C2).
