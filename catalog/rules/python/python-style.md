---
description: Python conventions
profile: standard
globs: **/*.py
---

# Python

- Type hints on public functions; run the configured type checker.
- Specific exceptions; `raise ... from err` to keep context; no bare `except:`.
- Context managers for files, locks and connections.
- `subprocess.run([...], check=True)` with argument lists; never `shell=True` on untrusted input.
- Format and lint with the project's tools (e.g. ruff, black).
