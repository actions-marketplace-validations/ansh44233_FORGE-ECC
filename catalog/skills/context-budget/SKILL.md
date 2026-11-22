---
description: Keep agent context small and relevant to save tokens and improve accuracy
profile: standard
tags: agents, performance
---

# Context Budget

- Search before reading: locate with grep/glob, then read only the relevant ranges.
- Summarize long tool output; keep exact error lines, drop noise.
- Write durable decisions to memory or a checkpoint instead of carrying them in context.
- Start a fresh session with a handoff when the context is mostly stale history.
