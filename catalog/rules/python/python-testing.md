---
description: Python testing conventions
profile: standard
globs: **/test_*.py, **/*_test.py, tests/**/*.py
---

# Python Testing

- pytest with fixtures; parametrize cases instead of loops.
- No network or real clock in unit tests; use monkeypatch/freezegun-style tools.
