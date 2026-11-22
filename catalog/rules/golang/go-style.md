---
description: Go conventions
profile: standard
globs: **/*.go
---

# Go

- Check every error and wrap with context using `%w`.
- Pass `context.Context` first for I/O; honor cancellation.
- Every goroutine has an owner and an exit; run tests with `-race`.
- `gofmt`/`go vet` clean; small consumer-defined interfaces.
