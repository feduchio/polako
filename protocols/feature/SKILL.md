---
name: feature
description: Worker protocol for implementing a scoped feature with acceptance checks and incremental slices.
applies_to:
  - worker
kind: task
budget_tokens: 700
resources: []
---

# Feature

1. Restate acceptance criteria as checkable outcomes.
2. Implement the thinnest vertical slice that satisfies acceptance.
3. Prefer extending existing modules over new layers.
4. Add or update tests that lock the acceptance behavior.
5. Stop when acceptance passes — do not polish adjacent areas.

## Verification

Acceptance checks and project gates must pass on a clean candidate worktree.
