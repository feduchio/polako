# Phase A accepted checkpoint

Phase A (A1–A12 foundation) is accepted at an immutable git object, not by ledger wording
alone.

## How to resolve the accepted state

```bash
git rev-parse phase-a-accepted
git show phase-a-accepted
```

The annotated tag `phase-a-accepted` points at the Phase A closure/docs commit. That
commit's parent implementation (verified by `pnpm check` in an isolated worktree) is:

- commit: `5b4956d3f40739fb332b5a3ba2169468c6e28e28`
- tree: `c06827ae0f5a409a456a62b6620590d534184e11`

Later commits on `main` may contain B/C/D checkpoint work. They are not Phase A.

## Verification recorded for `5b4956d`

Environment: Node `v22.18.0`, pnpm `11.25.0`, Darwin 25.6.0 arm64.
`engines.node` is `>=24`; the run emitted pnpm engine warnings and is not Node-24 certified.

- `pnpm typecheck` — PASS
- `pnpm lint` — PASS
- `pnpm deps:check` — PASS (114 modules, 615 dependencies)
- `pnpm test` — PASS (21 files, 243 tests)
- `pnpm check` — PASS
- `pnpm build` — PASS

Evidence narrative: `docs/ledger/A12.md`, `docs/ledger/A12-audit.md`.
