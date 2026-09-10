# B-selfhost-6 provenance

| Status | **TASK ACCEPTED** |
| Exact base | `916f7f26df1b7490d35289781a4e799d7cd8e7ed` |
| Draft reviewed | `d098000ff96ef6ed1b0cb63a20d6c215abef415b8b961b2f1ccbf22c18cc4151` FAIL/FAIL |
| Frozen hash | `0f0d478f7b82d61ebd20c320ab15a925dd11c3dd2531a109e8d0a9927e5ffba3` |
| Freeze commit | `d4d82e5292d8c83a50012e17cdbe593f4f69c926` |
| Impl | `df49a5ef75996da5ee17c51b4f66e974d8952fc0` on `task/B-selfhost-6-candidate-grok` |
| Accepted at | `df49a5ef75996da5ee17c51b4f66e974d8952fc0` on `task/B-selfhost-6-integration` |
| Clean | 2/2 on the accepted commit |

## Implementation

The two Grok task implementers assigned to this contract both stopped without
producing a candidate. The coordinator finished the work directly from the
partial diff they left uncommitted in the candidate worktree.

- `090f924` — production INTEGRATING path resolves runtime templates as checkout
  discovery, else the run's `project.discovered` payload, else corpus, and
  persists every executed scenario's evidence against the integrated commit;
  `resolveRuntimeEvidence` and its export deleted; CONVERGENCE_CHECK reads
  through the extracted `corpusRuntimeEvidenceAllowsDone`.
- `df49a5e` — the required-mode `RuntimeUnavailableError` catch narrowed so it
  can only fail closed; any other throw propagates instead of allowing `auto`
  to advance. Adds the INTEGRATING case where templates exist but no configured
  validator can run them.

## Review rounds

| Round | Commit | Grok | Claude |
| --- | --- | --- | --- |
| 1 | `090f924` | PASS | PASS (non-blocking: catch too broad; AC5 branch not isolated) |
| 2 | `df49a5e` | PASS | PASS |
| 3 | `df49a5e` | PASS | PASS |

Round 1 was clean, but the coordinator acted on Claude's non-blocking finding
rather than accepting, because the wide catch would have returned *allow* for
`auto` on an unexpected throw where the base blocked. Changing code reset the
clean-round count, so rounds 2 and 3 are the two clean rounds on the accepted
commit.

Anti-fake evidence: reviewers independently killed the contract tests by
mutation — deleting the persist loop, inverting template precedence,
soft-passing `auto`, removing the required fail-closed return, and binding a
placeholder checkpoint hash each broke the tests that claim to cover them.

## Gates

`pnpm check` + `pnpm build` on Node 24.20.0: typecheck, eslint,
dependency-cruiser (256 modules, 0 violations), 69 files / 620 tests green.

## Deliberate deltas from base

1. `required` with an unusable validator now reports integration status
   `failed_runtime` instead of `error`. Both fail closed and neither advances
   the run head; this makes it consistent with `required` and no validator,
   which base already reported as `failed_runtime`.
2. `expectedCheckpointHash` on the persist call is defensive: no test observes
   its omission, because `rerunRuntimeScenarios` already binds the scenario to
   the integrated commit. Its rejection behavior is pinned at the service level
   by pre-existing base coverage. The property the contract requires — an honest
   hash on persisted evidence — is mutation-covered.

## Findings recorded, not fixed here

`corpusRuntimeEvidenceAllowsDone` has no early return for mode `off`, so a
failed entry at the current hash would block DONE even with runtime validation
disabled. This is a faithful extraction of the base logic and is out of scope
for this contract. Recorded as a new open finding.
