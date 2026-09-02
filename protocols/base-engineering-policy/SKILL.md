---
name: base-engineering-policy
description: Shared engineering policy for all polish roles — think before coding, simplicity first, surgical changes, verify every claim.
applies_to:
  - worker
  - reviewer
  - evidence
  - defender
  - supervisor
kind: base
budget_tokens: 800
resources:
  - references/anti-rationalization.md
---

# Base engineering policy

## Think before coding

State the goal, constraints, and verification plan before editing. Prefer the smallest change that satisfies the mission.

## Simplicity first

Delete dead code; avoid speculative abstractions. Surgical diffs only — do not widen product scope.

## Goal-driven execution

Every substantive step ends with a verify action (tests, typecheck, lint, or an explicit reason they do not apply).

## Terse prose, never terse code

Keep explanations short. Keep code clear and complete.

## Verification

- Do not claim success without fresh command output.
- Do not silence failing checks (skip/only, deleted tests, weakened configs).
- Prefer evidence over confidence.
