# Build Verification Protocol (BVP)

How `polish` itself is built. Every block of the system is implemented and verified the same
way the finished tool verifies target projects: fresh implementers, deterministic gates
first, independent adversarial verifiers of a different model family, bounded fix rounds,
and phase-level invariant audits.

The Build Verification Protocol operates on two mandatory levels:

---

## Process v3 — supersedes v2's review ordering and bound, from 2026-09-14

User decision 2026-09-14. `docs/PLAN.md` §9 is the authoritative text; this is the summary.

1. **GPT-5.6-sol first, always.** It is the entry gate.
2. **Fix, then re-run GPT. Repeat until clean. No cap.**
3. **Grok second, and only on a commit GPT has passed.**
4. **Any Grok finding sends the fix back to GPT first.** Grok never re-reviews until GPT has cleared
   the new commit.
5. **Accepted only when both lanes are clean on the same commit.** Both lanes review every item,
   including documentation-only ones.

**What this replaces.** v2 §5's budget of three reviews and §6–§7's `deferred(unconfirmed_fix)` escape
are withdrawn: there is no maximum. v2 also allowed one reviewer for an item touching no production
file; v3 requires both.

**Why.** v2 ran the lanes in parallel on the same commit, and over P1.6–P1.7 the outcome was lopsided:
GPT produced the blocking finding in P1.10 round 1, P1.9 rounds 1 and 2, P1.7 rounds 1 and 2, and P1.3
round 1, four times catching a defect Grok had passed in the same round. Running the more productive
check first, to completion, stops the second lane reviewing code already known to need changing.

**Retroactive consequence.** Four accepted items had their final commit seen by only one lane and are
re-reviewed under v3: P1.10 (Grok missing), P1.9, P1.7 and P1.11 (GPT missing). P1.6 already had both
lanes clean on the accepted commit.

---

## Process v2 — superseded by v3 above for ordering and bound; the rest stands

User decision 2026-09-13, recorded in `docs/PLAN.md` §9, which is the authoritative text. Level 1
below is retained as the historical protocol and as the source of the clauses v2 keeps.

**Why it changed.** Level 1 §6 sets a bound of **at most 2 fix rounds per task**. That bound was
never honoured, not once, from the first task onward: `docs/ledger/A2.md` closed at 7 verifier
rounds, `A3.md` at 7, `A6.md` at 9. In Phase B the drift became severe — B-selfhost-8 ran 26 rounds
and produced 26 test-only commits after its two behaviour commits in rounds 1-3, with a 982-line
test file against a 109-line production change; B-selfhost-18 ran 15. The rule in force
("a survivable mutant is blocking") has no fixed point, and the coordinator's own round instruction
("name an axis none of these covers") made a finding compulsory.

**What v2 changes.**

1. **Reviewer count is conditional.** A task touching no production file gets **one** reviewer, from
   a family other than the coordinator's. A task touching **any** production file gets **two**
   reviewers of different families. Level 1 §4's single verifier is insufficient for production
   changes: in item 18 one lane passed while the other found defects in rounds 5, 7, 9 and 11.
2. **The bound is three reviews** — initial plus two fix rounds — replacing Level 1's "2 fix rounds",
   which was stated without a definition of what happens on the third.
3. **A production-relevant finding on the third review is a fix, not an escalation.** That fix gets
   **one confirming review**, the fourth and final. Level 1 §6 escalated to the user instead; that is
   what made every task a negotiation.
4. **If the confirming review still reports a production-relevant finding**, the task terminates as
   `deferred(unconfirmed_fix)` with the finding recorded, and at most one successor is enqueued at
   `depth+1`, refused at `depth ≥ 2`. This replaces user escalation with bounded deferral.
5. **`NONE` is a valid verdict** and the compulsory-axis instruction is deleted. Reviewer quality is
   measured on seeded-defect canaries, never on finding volume.
6. **Blocking is redefined.** A finding blocks only if it names a user-visible behaviour change or an
   invariant violation, with a reproduction the frozen contract's oracle accepts. Not file
   classification, and **not a survivable mutant**. Test-strength observations are recorded as notes
   and do not reopen a round.
7. **Abandonment.** A task ends when a round produces neither a production change nor a
   production-relevant finding. Accepted B-selfhost-35+23 already detects this shape
   (`src/convergence/pathology/detectors.ts:165-211`).
8. **Per block, not per task:** two reviewers of different families review the completed block once,
   against the block contract and the two root goals. Two clean verdicts accept the block.

**Unchanged from Level 1.** Contract frozen and hashed before code (§1); deterministic gates run by
the coordinator and never by the implementer's claim, with a gate failure returning the work without
spending review (§3); the verifier receives diff plus contract only, never the author's reasoning
(§4); reviewer isolation in a per-reviewer worktree at the commit under review; the reconcile
precedence `contract-misread → actionable → trade-off → noise` (§5); no re-running a verifier on an
unchanged artifact (§6).

**Machine load.** Reviewers run one at a time. The coordinator runs no gate while a reviewer is
working. Gates use `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm vitest run --maxWorkers=2`,
never bare `pnpm check`: `vitest.config.ts` sets `pool: "forks"`, one fork per core by default, and
three concurrent suites made the machine unusable on 2026-09-11.

---

## Level 1: Per-Task BVP (historical — see Process v2 above)

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
   re-run on an unchanged artifact. *(Superseded by Process v2 §2-§4. This bound was never
   honoured in practice — A2 7 rounds, A3 7, A6 9, B-selfhost-8 26, B-selfhost-18 15 — because it
   named no terminal outcome for the third round other than asking the user.)*
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
- **A round produces commits that touch no non-test file, while findings keep arriving.** This is
  the signal that was missing and that cost 26 rounds on B-selfhost-8 and 15 on B-selfhost-18; it is
  now Process v2 §7's abandonment clause rather than a signal to interpret.
- **Test volume growing out of proportion to the production change.** B-selfhost-8: 982 test lines
  against +109/−20 production lines. Test volume is a cost carried by all future work on that seam,
  not evidence of rigour.

## Ledger

Each task's contract, implementer/verifier models, gate results, findings and rulings are
recorded in `docs/ledger/<task-id>.md` so recovery after context loss uses the ledger and
`git log`, not memory. Phase-level invariant audits are documented in `docs/ledger/<phase>-audit.md`.
