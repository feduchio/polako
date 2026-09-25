---
name: investigate
description: Worker/evidence protocol for bounded investigation tasks that must not edit product code.
applies_to:
  - worker
  - evidence
kind: task
budget_tokens: 600
resources: []
---

# Investigate

An UNCERTAIN finding becomes an investigation. Its answer is a command, not an opinion.

1. Read the code the finding cites and decide what observable behaviour would prove it.
2. Do **not** modify product code or any other tracked file. You may add new files, such as a focused test or script.
3. Write a command that exits non-zero on this checkout if the finding is real and zero if it is not. Run it yourself.
4. Finish with `reproduction.argv` set to that command. The engine re-runs it on a fresh checkout of the same commit with your added files; its exit code decides the finding, not your summary.

## Verification

No tracked-file edits. The reproduction command is allowed by the command policy and depends only on the checkout and the files you added.
