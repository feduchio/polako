# ADR-0001: Architecture of the polish orchestrator

Status: Accepted · Date: 2026-09-02

## Context

We need a local orchestrator that replaces the manual loop "strong model plans → cheap model
implements → strong model reviews → new plan" with an autonomous, verification-driven cycle
that can run for hours, survive Cursor/daemon restarts, and stop only on convergence or a
genuine human decision.

## Decision

- **Daemon-centric runtime.** `polishd` owns all state and execution; `polish` CLI and the
  MCP server are thin facades over a local JSON-RPC socket. Cursor is a frontend, never the
  runtime.
- **Two orthogonal axes of run state.** `phase` (where the pipeline is) and `control`
  (RUNNING / PAUSE_REQUESTED / PAUSED / STOP_REQUESTED / STOPPED / KILLED) are independent,
  so pause/stop/kill are valid from any phase without a combinatorial FSM.
- **Event-sourced persistence** (ADR-0002) with projections in SQLite, JSONL mirror,
  artifacts on disk, git refs for code checkpoints.
- **Resource-aware scheduler** with persistent jobs and lanes (`llm.<provider>`,
  `local.test`, `local.build`, `integration`=1, `supervisor`, `verifier`).
- **Three context tiers**: immutable raw Mission → versioned project-aware
  MissionInterpretation; Supervisor memory as provenance-typed facts; fresh Worker context
  packs per task.
- **Verification chain**: BaselineSnapshot → isolated candidates → independent gates (clean
  checkout, protected acceptance artifacts, silencing detection, baseline-relative
  regression) → tournament → serial integration with integration gates → review swarm →
  finding validation → clean rounds bound to a checkpoint hash → simplification →
  re-verification.
- **Task origins are closed**: `valid_finding | mission_requirement | investigation`.
  UNCERTAIN/REJECTED findings can only spawn investigation tasks that do not touch product
  code.
- **Provider-agnostic Model Broker**: no model names in core; selection by capabilities,
  observed performance, health, and diversity as a soft preference above a quality
  threshold.
- **Protocol Registry** in the agentskills.io SKILL.md format composes base policy + task
  protocol + domain + role protocols deterministically; the bundle hash is logged.
- **RepositoryIntelligence** abstraction with CodeGraph (native / CLI / MCP) and a basic
  ripgrep+git backend, bound to a concrete worktree.
- **Trusted-project threat model** for v1 (ADR-0003).

## Invariants vs. configurable strategy

Invariants are listed in `README.md`/plan §1 and are enforced by tests. Concrete verifier
algorithms (score scale, K, PPT), context budget fractions, retry thresholds, reviewer
counts and `required_clean_rounds` are **strategies with defaults** in `config.yaml`, not
invariants.

## Consequences

- More upfront structure (store, scheduler, FSM tables) before the first end-to-end run.
- Every substantive decision is reconstructible from the event log.
- Adding providers, sandboxes, verifier strategies or supervisor roles does not touch the
  engine.
