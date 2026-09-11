---
name: polish
description: Operate the local Polish verification daemon from Codex.
---

# Polish

Use the `polish` CLI for all orchestration. Do not construct a second run engine in chat tools.

Everyday usage is `polish run ...`. `pnpm cli:link`, rebuilds, and daemon restarts are
development install/update operations after pulling CLI/daemon changes — not part of
ordinary product use. The CLI must run under Node >= 24.

## Commands

- `polish project add [path]` — register a git project root
- `polish run [project] [mission] [--mission text] [--runtime auto|required|off] [--budget-tokens n] [--budget-usd n] [--detach|-d] [--json]`
  — on an interactive TTY, creates the daemon run and attaches `polish watch`. `--detach` / `--json` / non-TTY return immediately. Ctrl-C detaches observation only.
- `polish status [run-id] [--json]`
- `polish watch <run-id> [--verbose] [--json] [--plain] [--no-color]` — reattach. `--plain` is append-only semantic events.
- `polish log <run-id> [--follow] [--json]`
- `polish diff <run-id>`
- `polish pause|resume|stop|kill <run-id>`
- `polish answer <run-id> <answer>` — respond when a run is `NEEDS_HUMAN`
- `polish apply <run-id>` — fast-forward the user's original clean branch after `DONE`

## Daemon lifecycle

The CLI auto-starts `polishd` as a detached process. Closing Codex or detaching the
observer does not stop it. Its socket and PID file remain under `${POLISH_HOME:-~/.polish}`
until the daemon exits; verify this with `polish status` or inspect `polish.pid` /
`polish.sock`, not by starting a second daemon.

`DONE` never applies changes automatically — the user must run `polish apply` explicitly.

From the polish repo under Node 24, `pnpm cli:link` puts the current `dist/` `polish` and
`polishd` on PATH (via `~/.local/bin`, and pnpm global bin when available). It fails if a
stale previous link would win.
