# Build Verification Protocol (BVP)

How `polish` itself is built. Every block of the system is implemented and verified the same
way the finished tool verifies target projects: fresh implementers, deterministic gates
first, independent adversarial verifiers of a different model family, bounded fix rounds.

## Per task

1. **Contract first.** Before any code: acceptance criteria and the exact deterministic
   checks (`pnpm typecheck`, `pnpm lint`, `pnpm deps:check`, `pnpm test`, plus task-specific
   tests) are written into the task. The contract names the invariants from the plan that
   the block must uphold.
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

## Model assignment

- Implementers and verifiers must come from different model families. The pairing is
  recorded in the task's ledger entry.
- Sensitive blocks get two verifiers of two families.

## Signals that the protocol is degenerating

- Two consecutive verifier rounds with substantive findings and zero classified as
  actionable → "doubt theater"; stop and escalate.
- A finding that appears, is fixed, and reappears → oscillation; stop and escalate.
- Verifier approves without citing a command it ran → reject the verdict.

## Ledger

Each task's contract, implementer/verifier models, gate results, findings and rulings are
recorded in `docs/ledger/<task-id>.md` so recovery after context loss uses the ledger and
`git log`, not memory.
