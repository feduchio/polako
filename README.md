# polish

Local, semi-autonomous **verification-driven software engineering orchestrator**.

You point it at a local project and a mission ("fix the duplicated request on app resume,
do not widen product scope"). It then, without a human dispatcher:

1. discovers the project and snapshots its baseline (tests / typecheck / lint / build);
2. stores the raw mission immutably, then builds a project-aware interpretation;
3. decomposes the mission into a task DAG;
4. selects heterogeneous worker models dynamically (OpenRouter, Gemini API, Groq, ...);
5. implements several isolated candidates per task in git worktrees;
6. runs independent deterministic gates (clean checkout, protected acceptance artifacts,
   silencing detection, baseline-relative regression);
7. compares candidates, integrates the winner serially with integration gates;
8. runs an independent review swarm, validates every finding with evidence;
9. turns only VALID blocking findings into new tasks;
10. repeats until several clean rounds hold for the same checkpoint hash, simplifies,
    re-verifies and reports — or stops with a concrete `NEEDS_HUMAN` question.

Core principle: **never trust a single LLM call where the answer can be checked by other
models, tests, runtime evidence or independent reproduction.**

## Status

Phase A (foundation) in progress. See `docs/` for the architecture, the build verification
protocol and the threat model. The implementation plan lives in the Cursor plan file
`polish_orchestrator_implementation_plan`.

## Requirements

- Node 24 LTS (`.node-version` / `.nvmrc`), pnpm 11 (`corepack enable`).
- git 2.40+.
- Repository intelligence is the built-in index. There is no external code graph or verifier process.

## Development

```bash
pnpm install
pnpm check        # typecheck + lint + module boundaries + tests
pnpm test:watch
```

### Local CLI (`polish` / `polishd` on PATH)

This is a **development install/update** step. It must run under **Node >= 24**.
Ordinary product usage after a successful link is just `polish run ...` — do not
rebuild, relink, or kill `polishd` for everyday runs.

```bash
cd ~/polish
# Node 24 (nvm/fnm/volta). `pnpm cli:link` refuses Node < 24.
pnpm cli:link
```

The script builds, then installs shims into `~/.local/bin` (and pnpm's global bin
when `pnpm bin -g` is available). It verifies `which polish` resolves to **this**
repo's current `dist/`, and fails if a stale previous link would hide it.

Then from **any** directory:

```bash
polish --help
polish run /path/to/project --runtime off --mission "..."
polish status <runId>
polish watch <runId>
polish watch <runId> --plain
polish log <runId>
polish pause <runId>
polish resume <runId>
```

`polish run` on an interactive TTY attaches the same observer as `polish watch`.
Use `--detach` / `-d` (or `--json` / a pipe) to return immediately. Ctrl-C from
the observer detaches only; the daemon-owned run continues. Reattach with
`polish watch <runId>`.

If `polish` is still not found, add `~/.local/bin` to `PATH`. Do not add a
machine-specific alias as the install mechanism. `pnpm cli:unlink` removes the
link. Restart `polishd` only after linking a **new** daemon build.

Module boundaries are enforced by `.dependency-cruiser.cjs`. Every block of the system is
built under `docs/BVP.md` (independent verifier agents, bounded fix rounds).

## Layout

```text
src/
  domain/      types, zod schemas, FSM tables (pure)
  shared/      ids, time, hashing, errors (leaf utilities)
  store/       node:sqlite, migrations, event log, projections, artifacts
  scheduler/   persistent jobs, lanes, leases, cancellation
  engine/      run engine: phase loop + control plane + recovery
  sandbox/     worktree sandbox, env scrubbing, process runner
  project/     registry, discovery, checks, baseline, silencing detection
  broker/      provider adapters, catalog, router, quotas, secrets
  providers/   openrouter, gemini, groq, scripted, record-replay
  protocols/   protocol registry + composer
  intel/       repository intelligence (basic, codegraph)
  context/     mission / supervisor / worker context construction, facts
  agents/      agent runner, tools, roles
  council/     supervisor council roles
  verify/      gates, tournament, verifier strategies
  findings/    dedupe, triage, reproduction, judge
  convergence/ clean rounds, dominance, pathology
  report/      semantic log, why-chain, reports
  daemon/      RPC server, lifecycle
  cli/         thin CLI over RPC
  mcp/         thin MCP facade over RPC
protocols/     SKILL.md-compatible protocol bundles
docs/          ADRs, BVP, threat model
fixtures/      target projects used in tests
```

## License

MIT
