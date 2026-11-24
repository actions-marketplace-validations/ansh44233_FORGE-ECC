---
description: Write idiomatic Go services: errors, context, goroutines, interfaces, table tests and the race detector
profile: standard
languages: golang
tags: go, backend
---

# Go services

Use in modules with `go.mod`.

## Errors
- Return errors; do not panic for expected failures. Wrap with context: `fmt.Errorf("load user %d: %w", id, err)`.
- Compare with `errors.Is` / `errors.As`, never by string.
- Handle every error or explicitly discard it with a comment explaining why.

## Context and concurrency
- Accept `ctx context.Context` as the first parameter of anything that does I/O, and pass it down. Respect cancellation in loops.
- Every goroutine needs a clear owner and exit condition. Use `errgroup.WithContext` for fan-out with cancellation.
- Protect shared state with a mutex or confine it to one goroutine; check with `go test -race`.
- Close resources with `defer` right after a successful open (`defer rows.Close()`), and check `rows.Err()` after iterating.

## Design
- Accept interfaces, return concrete types. Define small interfaces where they are consumed.
- Keep `main` thin: parse config, wire dependencies, start the server, handle shutdown with `signal.NotifyContext`.
- HTTP servers need timeouts (`ReadHeaderTimeout`, `ReadTimeout`, `WriteTimeout`); `http.ListenAndServe` with no server struct has none.
- Outbound HTTP: reuse one `http.Client` with a timeout, and always close response bodies.

## Tests
Table-driven tests with `t.Run(tc.name, ...)`, `t.Helper()` in helpers, `t.TempDir()` for files, and `httptest` for handlers.

## Verify
```bash
gofmt -l . && go vet ./...
go test -race ./...
```
Plus `golangci-lint run` or `staticcheck ./...` if the repo configures them.
