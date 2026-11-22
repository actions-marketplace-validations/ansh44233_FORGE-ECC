---
description: TypeScript/JavaScript testing conventions
profile: standard
globs: **/*.test.ts, **/*.spec.ts, **/*.test.tsx, **/*.spec.tsx
---

# TypeScript Testing

- Use the project's runner (Vitest/Jest). Co-locate or mirror source layout consistently.
- Use fake timers and dependency injection instead of sleeps and real network.
- Type-check tests too.
