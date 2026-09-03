# ADR-0003: Trusted-project threat model for v1

Status: Accepted · Date: 2026-09-02

## Context

Workers execute LLM-generated changes and project commands on the user's machine. A git
worktree plus a subprocess offers workspace isolation but no security boundary. Real
filesystem isolation (`sandbox-exec`, containers) has platform-specific reliability
concerns that we cannot verify before the core exists.

## Decision

v1 explicitly adopts a **trusted-project** model, documented in `docs/THREAT_MODEL.md`:

- The target project and its toolchain are trusted as much as the user's own shell.
- LLM output is untrusted but executes inside the same trust domain as the user's dev
  environment.
- Mitigations shipped in v1 are defense in depth, not isolation: env scrubbing of secrets,
  command allowlist per project profile, full command logging, acceptance artifacts stored
  outside worktrees, timeouts and process-group kill.
- `Sandbox` is an interface. `WorktreeSandbox` is the v1 backend. `SandboxExecSandbox`
  (macOS) and `ContainerSandbox` are reserved and become the default only after an
  integration test proves them on the target OS.
- `polish doctor` warns the user when the active backend provides no isolation.

## Consequences

- Users must treat `polish run` like running the project's own test suite.
- Filesystem isolation is a tracked task (C10), not an implicit promise.
