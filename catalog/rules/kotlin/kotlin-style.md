---
description: Kotlin conventions
profile: standard
globs: **/*.kt, **/*.kts
---

# Kotlin
- Prefer `val` and immutable collections; no `!!` outside tests.
- Structured concurrency: scoped coroutines, never `GlobalScope`; rethrow `CancellationException`.
- Sealed classes or interfaces for closed result and state types; exhaustive `when`.
- Data classes for values; keep side effects out of `init` blocks.
