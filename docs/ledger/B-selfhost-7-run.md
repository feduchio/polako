# B-selfhost-7 provenance

| Status | **CONTRACT FROZEN** |
| Exact base | `df49a5ef75996da5ee17c51b4f66e974d8952fc0` |
| Draft reviewed | `6157eb428ad98f351a84a7345e9a0f0f83a7a04013bb79ccf3dc7b19ab384c76` FAIL/FAIL |
| Frozen hash | `bba8198de33abf746be2b7cc58f8bfcc9ba54bba63d285abe4003748862d797d` |
| Freeze commit | pending |
| Impl | pending |
| Clean | 0/2 |

## Contract review outcome

Both reviewers failed the draft. Every blocking finding was incorporated; there
was no second contract round.

Grok blocking findings:

1. The draft's default rule contradicted base — an omitted `runtime` yields
   `"auto"` at both the RPC handler and the CLI, not the loaded `polish.toml`
   value, so the draft asserted two incompatible rules at once.
2. AC1 could pass against a `getConfig()` snapshot while the live object stayed
   mutated.
3. The acceptance checks never required creation through the real `createRun`
   entry point, so an engine-only test could pass with the leak intact.
4. "Driven interleaved" was not observable: sequential `tickRun` alternation is
   satisfied by a save-restore implementation that still leaks under the real
   `Promise.all` fan-out.
5. The resolved run config was unspecified beyond `.mode`, admitting a stub that
   drops `runtimeValidation.level`.

Claude blocking findings, additional to the above:

6. A construction-time deep clone defeats several invariants at once while
   leaving the leak; the contract needed a greppable static pin plus an object
   identity check between `getConfig()` and production composition.
7. The contract never enumerated the reader sites, so a one-call-site fix would
   pass. The complete set is `candidateDrivers.ts:667`, `candidateDrivers.ts:702`
   and `convergenceDrivers.ts:440`.
8. The item-12 boundary as drafted forbade the cleanest implementation while
   leaving post-restart behavior unpinned, since `facade.json` already persists
   `runtime` at base.

## Coordinator verification

Both reviews were checked against the base source rather than taken on trust.
Confirmed: the `"auto"` defaults at `service.ts:129` and `cli/index.ts:18`; the
`Promise.all` fan-out at `engine.ts:160-163`; the single `PhaseContext`
construction point at `engine.ts:202`; exactly three production readers of
`runtimeValidation`; `facade.json` carrying `runtime` and being read back at
`composition.ts:773`; `enqueueBudgetDeadlineJob` taking only
`Pick<PolishConfig, "budget">`, which keeps item 8 separable.

A useful consequence surfaced during verification and is now pinned in the
contract: `createRun` awaits `this.tick()`, which drives every active run, so
creating a second run reproduces the leak deterministically with no artificial
interleaving.

## Finding recorded, not fixed here

That `polish.toml`'s `runtimeValidation.mode` is shadowed by the `"auto"`
default for daemon-created runs is a real defect, but changing it is a behavior
change this contract deliberately refuses. Recorded as open finding 17.
