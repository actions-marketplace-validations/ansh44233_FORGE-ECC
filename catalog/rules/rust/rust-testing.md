---
description: Rust testing conventions
profile: standard
globs: **/*.rs
---

# Rust Testing
- Unit tests in `#[cfg(test)]` modules; integration tests in `tests/`.
- Property tests (proptest) for parsers and invariants.
- `cargo test` and `cargo clippy` clean in CI.
