---
description: Reliable end-to-end tests for critical user journeys
profile: full
tags: testing, e2e
---

# E2E Testing
- Cover a few critical journeys deeply rather than many shallowly.
- Role/label selectors; never brittle CSS paths.
- Isolated test data created per test; no order dependence.
- Wait on application state, never fixed sleeps.
- Capture traces/screenshots on failure; track flake rate.
