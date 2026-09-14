# P1 block acceptance

| Field | Value |
|---|---|
| Entry base | HOST `4c5bb63` |
| Block candidate | `81c278e5af42a127fa91285243044c3b669d95e7` |
| Plan | `docs/PLAN.md` §1 and §3 |
| Gate | Node 24.20.0; 93 files; 1,022 tests; exit 0 |
| Block reviewers | GPT-5.6-sol, then Grok |
| Block verdict | both clean on `81c278e` |

## Exit checklist

- Deterministic gate green.
- G1 entry baseline exists at `docs/ledger/g1-baseline.md`: six rounds,
  834,635 attributed reviewer tokens, median 87,984 and adversarial-call rate
  6/6.
- P1.4's seed-43 report is persisted and recorded in
  `docs/ledger/P1.4-run.md`.
- Findings 12, 13, 15, 16, 17, 21, 22, 25, 27, 28, 30 and the corpus defect
  (finding 53) are accepted. Finding 31 is an explicit accepted risk with the
  25-turn trigger.
- P1.1 and P1.5 cost-reducing defaults remain off because P2.2 has not passed.
  P1.2 remains a 1,500-token tail guard, not a claimed observed saving.

## Block review

GPT's first block review on `41739d2` found one documentation-only blocker:
the authoritative trusted-generations/disposition ledgers stopped at P1.4.
`81c278e` added P1.5, P1.8, P1.12 and P1.13, updated Current HOST, and marked
findings 13, 15 and 53 accepted.

GPT re-reviewed `81c278e` and returned clean. Grok then reviewed the same
commit and returned clean. Neither found a cross-item production conflict
among completed skip/truncation semantics, settings/spend restoration,
resumable answer/STOPPED states, executable/runtime corpus artifacts or cost
attribution.

## Scope boundary

P1 is accepted. P2 and P3 have not started in this run. Phase C is not
accepted; no `phase-c-accepted` tag is created. Phase D remains out of scope.
