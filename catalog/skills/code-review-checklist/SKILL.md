---
description: Systematic review checklist for correctness, security, data, performance and tests
profile: standard
tags: review
---

# Code Review Checklist
Work through in order and stop to report blockers early:
1. **Intent** — does the change do what the description says, and nothing else?
2. **Correctness** — edge cases, error paths, concurrency, time zones, off-by-one.
3. **Security** — input validation, authz on every path, secrets, injection.
4. **Data** — migrations, backward compatibility, idempotency.
5. **Performance** — queries in loops, unbounded work, payload sizes.
6. **Tests** — would they fail without the change? Do they cover failure paths?
7. **Readability** — names, structure, comments that explain *why*.
