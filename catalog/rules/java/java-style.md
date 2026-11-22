---
description: Java/Kotlin conventions
profile: standard
globs: **/*.java, **/*.kt
---

# Java / Kotlin

- try-with-resources for all closeables; `Optional` for absent return values.
- Constructor injection; immutable value objects.
- No blocking calls in reactive or coroutine code paths.
