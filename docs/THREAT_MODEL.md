# Threat model (v1)

## Summary

`polish` v1 operates under a **trusted-project** model. A git worktree plus a child
process is *workspace isolation*, not a security sandbox. Anything a worker can execute
runs with the same OS privileges as the user's own shell.

## Trust boundaries

Trusted:
- The target repository, its toolchain, its scripts (`package.json` scripts, test
  runners, build tools). Running `pnpm test` in the project is treated exactly like the
  user running it.
- The `polish` daemon process and its configuration (`~/.polish/`).

Untrusted:
- Every LLM output: diffs, commands, findings, plans. They can be wrong, adversarial, or
  the product of prompt injection through repository content.
- Repository content as *input to LLMs* (a README can contain instructions aimed at the
  model).

## What v1 guarantees

1. **Secrets never enter worker processes by design.** Provider API keys live only in the
   daemon (`~/.polish/secrets.env`, mode 0600). Worker/subprocess environments are built
   from an allowlist (`PATH`, `HOME`, `LANG`, `CI=1`, project-declared variables) with
   denylisted patterns (`*_API_KEY`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`) removed. This is
   **defense in depth**, not isolation: a worker process could still read
   `~/.polish/secrets.env` from disk because there is no filesystem isolation in v1.
2. **Command allowlist.** Workers may run only commands declared in the project profile
   (checks, package manager, read-only git) plus commands the user explicitly enabled for
   the mission. Arbitrary `run_command` is off by default.
3. **Every command is logged** (cwd, argv, exit code, truncated output, full output as an
   artifact) in the forensic history.
4. **Acceptance artifacts are outside the worktree.** Regression tests and check configs
   used for gating are stored in `~/.polish/runs/<run>/acceptance/` and injected at gate
   time with hash verification; the worker cannot modify what it is judged by.
5. **Timeouts and output limits** on all subprocesses; process-group kill on cancel.

## What v1 does NOT guarantee

- No filesystem isolation: a malicious or confused worker can read any file the user can
  read and write anywhere the user can write (outside the worktree included).
- No network isolation for worker subprocesses.
- No protection against a compromised target project (malicious `postinstall`, test that
  exfiltrates data). This is identical to the risk of running that project's tests
  yourself.

## Roadmap

- `SandboxExecSandbox` (macOS `sandbox-exec` profile: write only to the worktree and a
  temp dir, deny read of `~/.polish/secrets.env`, optional network deny) behind the
  `Sandbox` interface. Enabled by default only after an integration test proves it works
  on the current macOS release.
- `ContainerSandbox` for Linux/CI.
- `polish doctor` warns when the active sandbox backend is `worktree` (no isolation).

## User guidance

Run `polish` only against projects you would run `npm test` in yourself. Keep provider keys
in `~/.polish/secrets.env`, not in the project's `.env`.
