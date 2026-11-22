---
description: Node.js runtime conventions
profile: standard
globs: **/*.ts, **/*.js, **/*.mjs
---

# Node.js
- Use `node:` prefixed built-ins; `fs/promises` over sync I/O on hot paths.
- Spawn processes with argument arrays (`execFile`/`spawn`), never shell strings with user input.
- Validate environment variables at startup; fail fast with clear messages.
- Handle `unhandledRejection` and stream errors.
