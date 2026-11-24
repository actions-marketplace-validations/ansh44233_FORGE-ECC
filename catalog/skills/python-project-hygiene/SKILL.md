---
description: Set up and work in modern Python projects: uv/pip, virtualenvs, ruff, mypy/pyright and pytest
profile: standard
languages: python
tags: python, tooling, testing
---

# Python project hygiene

Use when touching any Python project, before writing code.

## Find the toolchain
- Read `pyproject.toml` (and `uv.lock`, `poetry.lock`, `requirements*.txt`). Use the tool the project already uses: `uv run`, `poetry run`, or an activated virtualenv. Never `pip install` into the system interpreter.
- Note the supported Python version (`requires-python`) and do not use newer syntax.

## Code
- Type hints on public functions; `from __future__ import annotations` only if the project already uses it.
- Prefer `pathlib`, f-strings, dataclasses or pydantic models over ad-hoc dicts for structured data.
- Never use mutable default arguments (`def f(items=[])`); use `None` and create inside.
- Catch specific exceptions; never bare `except:`. Re-raise with `raise ... from error` to keep context.
- Use `logging`, not `print`, in library and service code.
- Avoid `subprocess` with `shell=True` on any input you did not write; pass an argument list.

## Tests
- pytest: plain `assert`, fixtures for setup, `tmp_path` for files, `monkeypatch` for env vars, `pytest.mark.parametrize` for tables of cases.
- Run the narrowest test first: `pytest tests/test_x.py::test_case -q`.

## Verify (use the project's configured tools)
```bash
ruff check . && ruff format --check .     # or flake8/black if that is what the repo uses
mypy src/                                  # or pyright
pytest -q
```
Report exactly which of these exist in the repo and which you ran.
