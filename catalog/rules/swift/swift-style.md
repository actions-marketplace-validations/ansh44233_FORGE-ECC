---
description: Swift conventions
profile: standard
globs: **/*.swift
---

# Swift
- No force unwraps outside tests; `guard` for early exits.
- Structured concurrency; `@MainActor` for UI.
- Keychain for secrets.
