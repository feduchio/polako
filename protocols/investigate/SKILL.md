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

UNCERTAIN/REJECTED findings may only spawn investigation tasks.

1. Gather read-only evidence (logs, repro commands, code references).
2. Do **not** modify product code.
3. Emit structured notes: hypothesis, evidence refs, recommended next action.
4. Bound rounds; escalate to NEEDS_HUMAN when exhausted.

## Verification

No product-tree writes. All claims cite artifact paths or command output handles.
