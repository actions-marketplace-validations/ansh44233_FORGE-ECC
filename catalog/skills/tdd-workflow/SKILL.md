---
description: Test-driven development cycle with observed red and green evidence
profile: minimal
tags: testing, tdd
---

# TDD Workflow

1. Write one failing test for the next behavior; run it and confirm it fails for the right reason.
2. Make the smallest change that passes; run the focused test.
3. Refactor with tests green.
4. Cover normal, boundary and failure cases. Keep tests deterministic (fake clocks, no real network).
5. Never claim a red→green cycle you did not observe.
