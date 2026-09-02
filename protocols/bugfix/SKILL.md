---
name: bugfix
description: Worker protocol for fixing defects via red→green→refactor with a failing reproduction first.
applies_to:
  - worker
kind: task
budget_tokens: 700
resources: []
---

# Bugfix

1. **Reproduce** — obtain or write a failing test/command that demonstrates the bug.
2. **Localize** — minimise the failing surface; form a single primary hypothesis.
3. **Fix** — smallest change that makes the reproduction pass.
4. **Guard** — keep the regression test; run related suite.
5. **Refactor** only after green, without changing behavior.

## Verification

`finish` requires fresh failing-then-passing evidence for the reproduction. No product-code changes without a reproduction.
