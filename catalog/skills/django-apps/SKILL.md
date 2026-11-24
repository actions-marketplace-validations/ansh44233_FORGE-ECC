---
description: Change Django apps safely: models and migrations, querysets, views, forms, permissions and tests
profile: standard
languages: python
tags: python, django, backend
---

# Django apps

Use in projects with `manage.py` and `django` in dependencies.

## Models and migrations
- After changing a model, run `python manage.py makemigrations <app>` and read the generated file. Commit it with the model change.
- Adding a non-nullable column to a large table: add it nullable or with a default, backfill in a data migration, then make it non-null in a later migration.
- Never edit a migration that has been applied in shared environments; add a new one.
- `python manage.py makemigrations --check --dry-run` in CI catches forgotten migrations.

## Queries
- Avoid N+1: `select_related` for foreign keys, `prefetch_related` for many-to-many and reverse relations. Check with `django-debug-toolbar` or `assertNumQueries` in tests.
- Use `F()` expressions and `update()` for atomic counters; wrap multi-step writes in `transaction.atomic()`.
- Never build SQL with string formatting; use the ORM or `params` in `raw()`.

## Views and security
- Check object-level permissions: `get_object_or_404(Model, pk=pk, owner=request.user)` rather than fetching by id alone.
- Keep CSRF protection on; do not add `csrf_exempt` to session-authenticated views.
- Validate input with forms or DRF serializers; never trust `request.POST` directly.
- Settings: `DEBUG=False`, `ALLOWED_HOSTS` set, `SECRET_KEY` from the environment. `python manage.py check --deploy` lists the rest.

## Verify
`python manage.py test` (or `pytest` with pytest-django), `makemigrations --check`, and `check --deploy` for settings changes.
