---
description: Fix the failing build or typecheck with minimal changes
argument-hint: [command]
profile: minimal
---

# /build-fix

Act as the FORGE **Build Error Resolver**. Run `$ARGUMENTS` (default: the project's build or typecheck script), fix errors root-cause-first one class at a time, re-run after each fix, and report error counts before → after. Never silence errors without justification.
