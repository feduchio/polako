---
name: polish
description: Operate the local Polish verification daemon from Cursor.
---

# Polish

Use the `polish` CLI for all orchestration. Do not construct a second run engine in chat tools.

## Commands

- `polish project add [path]` — register a git project root
- `polish run [project] [mission] [--mission text] [--runtime auto|required|off] [--budget-tokens n] [--budget-usd n]`
- `polish status [run-id] [--json]`
- `polish watch <run-id> [--verbose] [--json] [--no-color]`
- `polish log <run-id> [--follow] [--json]`
- `polish diff <run-id>`
- `polish pause|resume|stop|kill <run-id>`
- `polish answer <run-id> <answer>` — respond when a run is `NEEDS_HUMAN`
- `polish apply <run-id>` — fast-forward the user's original clean branch after `DONE`

## Daemon lifecycle

The CLI auto-starts `polishd` as a detached process. Closing Cursor does not stop it. Its socket
and PID file remain under `${POLISH_HOME:-~/.polish}` until the daemon exits; verify this with
`polish status` or inspect `polish.pid` / `polish.sock`, not by starting a second daemon.

`DONE` never applies changes automatically — the user must run `polish apply` explicitly.

From the polish repo, `pnpm cli:link` puts `polish` and `polishd` on PATH for any working directory.
