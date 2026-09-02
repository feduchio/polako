---
name: refactor
description: Worker protocol for behavior-preserving structural change with characterization tests first.
applies_to:
  - worker
kind: task
budget_tokens: 650
resources: []
---

# Refactor

1. Capture characterization tests or golden outputs before structural change.
2. Change structure only; observable behavior stays identical.
3. Keep diffs focused; no feature work mixed in.
4. Re-run characterization and project gates.

## Verification

Behavior deltas are bugs. If behavior must change, stop and reclassify the task.
