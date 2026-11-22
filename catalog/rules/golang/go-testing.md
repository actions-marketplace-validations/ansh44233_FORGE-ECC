---
description: Go testing conventions
profile: standard
globs: **/*_test.go
---

# Go Testing
- Table-driven tests with `t.Run`; `t.Parallel()` where safe.
- Run with `-race`; use `httptest` and fakes instead of real network.
