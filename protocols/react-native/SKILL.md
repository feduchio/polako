---
name: react-native
description: Domain notes for React Native apps — platform splits, native modules, and Metro/Jest realities.
applies_to:
  - worker
  - reviewer
  - supervisor
kind: domain
budget_tokens: 400
resources: []
---

# React Native domain

- Prefer shared JS/TS changes over native unless the mission requires native.
- Mind platform files (`.ios`/`.android`), permissions, and Hermes differences.
- Do not "fix" flaky device tests by skipping; quarantine needs evidence.
