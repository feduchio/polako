---
name: typescript
description: Domain notes for TypeScript/Node projects — strict types, no escape hatches, package-manager aware scripts.
applies_to:
  - worker
  - reviewer
  - supervisor
kind: domain
budget_tokens: 400
resources: []
---

# TypeScript domain

- Respect `strict` and project ESLint; do not add `any` / `@ts-ignore` / eslint-disable to silence gates.
- Prefer existing script names from package.json for checks.
- Keep ESM/CJS boundaries intact (`nodenext`, `.js` extensions in relative imports when required).
