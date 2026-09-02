---
name: simplify
description: Worker protocol for deleting complexity while respecting Chesterton's Fence and deep-module design.
applies_to:
  - worker
kind: task
budget_tokens: 650
resources: []
---

# Simplify

1. Identify accidental complexity (duplication, shallow wrappers, unused paths).
2. Before removing a fence, document why it existed and what still protects that need.
3. Prefer deeper modules with simple interfaces over many leaky helpers.
4. Delete only with tests/gates still green.

## Verification

Net complexity down; no silenced checks; no behavior regressions on acceptance and baseline.
