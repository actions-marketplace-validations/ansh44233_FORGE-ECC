---
description: Rust conventions
profile: standard
globs: **/*.rs
---

# Rust

- Return `Result` for recoverable errors; avoid `unwrap()`/`expect()` outside tests and proven invariants.
- Every `unsafe` block carries a `// SAFETY:` comment.
- `cargo fmt` and `cargo clippy -- -D warnings` clean.
