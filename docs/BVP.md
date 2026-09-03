# Build Verification Protocol (BVP)

How `polish` itself is built. Every block of the system is implemented and verified the same
way the finished tool verifies target projects: fresh implementers, deterministic gates
first, independent adversarial verifiers of a different model family, bounded fix rounds,
and phase-level invariant audits.

The Build Verification Protocol operates on two mandatory levels:

---

## Level 1: Per-Task BVP

1. **Contract first.** Before any code: acceptance criteria and the exact deterministic
   checks (`pnpm typecheck`, `pnpm lint`, `pnpm deps:check`, `pnpm test`, plus task-specific
   tests) are written into the task contract (`docs/ledger/<task-id>.md`). The contract names
   the invariants from the plan that the block must uphold.
2. **Implementer.** A fresh-context subagent receives the contract and file pointers only.
   For invariant-bearing blocks (domain FSM, scheduler, store, sandbox, gates) two
   candidates are produced in isolated worktrees (`best-of-n-runner`) and compared on
   evidence.
3. **Deterministic gates.** Run by the orchestrator, never by the implementer's claim. A
   failing gate returns the work to the implementer without spending LLM review.
4. **Verifier.** A fresh-context subagent of a *different model family* than the
   implementer receives **ARTIFACT (diff) + CONTRACT only** — never the implementer's
   claims or reasoning. The prompt is adversarial ("find what is wrong, assume the author
   is overconfident"). The verifier must run the checks itself and cite commands and
   output for every claim. Output is structured findings: `severity, claim, evidence,
   reproduction`.
5. **Reconcile.** Each finding is classified by the orchestrator against the artifact text,
   in precedence order: `contract-misread` (fix the contract) → `actionable` (fix the
   code) → `trade-off` (document) → `noise`. Only `actionable` findings start a fix round.
6. **Bound.** At most **2 fix rounds** per task. A third round with substantive findings
   escalates to the user with a concrete question instead of grinding. A verifier is never
   re-run on an unchanged artifact.
7. **Invariant blocks** additionally carry property tests (`fast-check`) and simulation
   tests (`ScriptedProvider`, fake clock). The verifier is told to read them and attempt to
   break them.

---

## Level 2: Phase Invariant Audit

Conducted after completing each major phase (Phase A, Phase B, Phase C) over the entire
integrated codebase.

1. **Scope and Target.** Evaluates global architecture invariants (§1), ADRs, whole integrated
   phase codebase, cross-module call paths, and integration/mutation probes.
2. **Adversarial Phase Auditor.** A dedicated subagent with the explicit goal of demonstrating
   that two or more locally correct modules violate a system invariant when composed.
3. **Core Attack Vectors**:
   - `BaselineSnapshot` ↔ `IndependentGates` (no false regressions for pre-existing baseline failures);
   - `AcceptanceArtifact` ↔ candidate checkout ↔ gates (tampering prevention, clean injection);
   - `Scheduler` ↔ `Engine` (control, pause/stop/kill, starvation prevention, crash recovery);
   - `Sandbox` ↔ command policy (no capability escape via allowed commands);
   - `Facts` ↔ `EventStore` (evidence-based promotion integrity, precedence during consolidation);
   - `Broker` ↔ persisted observations (global model quality preserved across per-run restores);
   - `ContextBuilder` ↔ `ProtocolRegistry` (untrusted data prompt boundary, non-droppable base policy);
   - `RepositoryIntelligence` ↔ real external CLI adapters.
4. **Phase Acceptance.** Findings are validated, reconciled, and fixed. The phase is only marked
   closed once all blocking phase-level findings are resolved.

---

## Model assignment

- Implementers and verifiers must come from different model families. The pairing is
  recorded in the task's ledger entry.
- Sensitive blocks and phase audits get two verifiers of two families.

## Signals that the protocol is degenerating

- Two consecutive verifier rounds with substantive findings and zero classified as
  actionable → "doubt theater"; stop and escalate.
- A finding that appears, is fixed, and reappears → oscillation; stop and escalate.
- Verifier approves without citing a command it ran → reject the verdict.

## Ledger

Each task's contract, implementer/verifier models, gate results, findings and rulings are
recorded in `docs/ledger/<task-id>.md` so recovery after context loss uses the ledger and
`git log`, not memory. Phase-level invariant audits are documented in `docs/ledger/<phase>-audit.md`.
