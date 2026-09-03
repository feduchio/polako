# Phase A certified final

Additive certification of the immutable accepted Phase A tree on the declared
target runtime. This does **not** move `phase-a-accepted`.

## Identity

| Ref | Object |
|---|---|
| `phase-a-accepted` (immutable) | annotated tag → `0e514e0bef9e9c9e21a6d27a96f29773e94e20ce` |
| Validated implementation | `5b4956d3f40739fb332b5a3ba2169468c6e28e28` |
| Validated tree | `c06827ae0f5a409a456a62b6620590d534184e11` |
| `phase-a-certified-final` | this commit / annotated tag |

## Post-close foundation checklist

Checked against `phase-a-accepted` / `5b4956d`. None of these required a code pick from
`archive/post-a-wip`.

| Item | Status |
|---|---|
| Mission Acceptance Corpus cross-mission isolation | Already in `5b4956d` (`sourceRunId` must belong to the same `missionId`) |
| Real CodeGraph CLI dialect / capability probing | Already in `5b4956d` (help-discovered dialect; fake CLI remains the deterministic fixture) |
| Package-script trailing argv restrictions | Already in `5b4956d` (exact `pnpm run <script>` unless `packageScriptsAllowTrailingArgs`) |
| Cursor skill tracked in git | **Not a Phase A foundation fix.** Daemon/CLI/MCP do not exist in Phase A. Tracked in B9 when the production operator surface exists. Post-A `b5a5f83` remains on `archive/post-a-wip`. |
| Node 24 target-runtime verification | **This certification.** No code change. |

No other post-close commits were marked as Phase-A/handoff implementation fixes.
`02e3a7d` / `b5a5f83` are untrusted post-A donor / gitignore+skill work.

## Node 24 gates

Environment: Node `v24.20.0`, pnpm `11.25.0`, Darwin 25.6.0 arm64.
Working tree: `phase-b-real` at `phase-a-accepted` (`0e514e0`), unsandboxed.

| Gate | Result |
|---|---|
| `node -v` | `v24.20.0` |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `pnpm deps:check` | PASS (114 modules, 615 dependencies) |
| `pnpm test` | PASS (21 files, 243 tests) |
| `pnpm check` | PASS |
| `pnpm build` | PASS |

A sandboxed rerun of `pnpm test` failed 16 git-init worktree tests (`Operation not permitted`
on `.git/hooks`). Those failures are sandbox confinement, not Node 24 incompatibility.
The certification run was unsandboxed and passed.

## What was not done

- A1–A12 were not reopened or rewritten.
- `phase-a-accepted` was not moved.
- Post-A B/C/D code was not merged.
