---
description: Write and change Rust code: ownership-friendly APIs, error handling, async, clippy and tests
profile: standard
languages: rust
tags: rust
---

# Rust crates

Use in projects with `Cargo.toml`.

## Errors
- Libraries: typed errors with `thiserror`. Applications: `anyhow::Result` with `.context("what failed")`.
- Use `?` for propagation. `unwrap()` / `expect()` only where failure is a bug, and say why in the `expect` message.

## APIs
- Take borrowed inputs (`&str`, `&[T]`, `impl AsRef<Path>`) and return owned outputs. Avoid cloning to silence the borrow checker; restructure ownership instead.
- Prefer iterators over index loops. Use `Option`/`Result` combinators where they read clearly.
- Derive `Debug` on public types; implement `Display` for user-facing errors.

## Async
- Do not hold a `std::sync::Mutex` guard across `.await`; use `tokio::sync::Mutex` or restructure.
- Never block inside async code (`std::thread::sleep`, blocking I/O, heavy CPU); use `tokio::task::spawn_blocking`.
- Bound concurrency (semaphores, `buffer_unordered(n)`) instead of spawning unbounded tasks.

## Unsafe
Avoid new `unsafe`. If unavoidable, keep the block minimal and add a `// SAFETY:` comment stating the invariants.

## Verify
```bash
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
```
