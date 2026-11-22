---
description: Safe, behavior-preserving refactoring moves with a test safety net
profile: standard
tags: refactor
---

# Refactoring Patterns
- Establish a green test baseline first; add characterization tests for untested code.
- Prefer small named moves: extract function, inline variable, move module, replace conditional with polymorphism, introduce parameter object.
- One move per commit; run tests after each.
- Separate refactors from behavior changes in different commits or PRs.
