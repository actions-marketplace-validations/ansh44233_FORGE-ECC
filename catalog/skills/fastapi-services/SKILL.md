---
description: Build FastAPI endpoints with pydantic models, dependencies, async correctness and tests
profile: standard
languages: python
tags: python, fastapi, api, backend
---

# FastAPI services

Use in projects that depend on `fastapi`.

## Endpoints
- Declare request and response models with pydantic and set `response_model` so internal fields never leak. Check whether the project uses pydantic v1 or v2 (`model_dump` vs `dict`).
- Use dependencies (`Depends`) for database sessions, the current user and permissions. Keep authorization checks in a dependency or the service layer, not copy-pasted in handlers.
- Return correct status codes (`status_code=201` for creation, `HTTPException(404)` for missing objects). Do not return 200 with an error payload.

## Async correctness
- In `async def` endpoints, never call blocking code (sync database drivers, `requests`, `time.sleep`, heavy CPU work). Use async libraries (`httpx.AsyncClient`, async SQLAlchemy) or declare the endpoint with plain `def` so FastAPI runs it in a thread pool.
- Create clients (httpx, database engines) once at startup with the `lifespan` handler, not per request.

## Data and settings
- Settings via `pydantic-settings`, read once. Secrets only from the environment.
- Database sessions: one per request through a dependency that closes it (`yield`).
- Migrations through Alembic. Never call `create_all` in production code paths.

## Security
CORS limited to known origins · OAuth2/JWT validation in a dependency, verifying signature, expiry and audience · password hashing with argon2 or bcrypt · rate limiting on login.

## Verify
Tests with `TestClient` (or `httpx.AsyncClient` with `ASGITransport` for async tests), overriding dependencies with `app.dependency_overrides`. Then `pytest -q`, ruff and the type checker.
