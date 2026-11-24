---
description: Change Laravel apps: Eloquent, migrations, validation, authorization policies, queues and tests
profile: standard
languages: php
tags: php, laravel, backend
---

# Laravel apps

Use in projects with `artisan` and `laravel/framework` in composer.json.

## Data
- Schema changes as migrations (`php artisan make:migration`); never edit applied migrations.
- Avoid N+1 with eager loading (`with()`); call `Model::preventLazyLoading()` outside production to surface it.
- Guard mass assignment with `$fillable`; never use `$guarded = []` on models filled from requests.
- Use query bindings; never put input into `DB::raw` or `whereRaw` without bindings.

## Requests
- Validate with Form Requests (`php artisan make:request`) and use `$request->validated()`.
- Authorize with policies (`$this->authorize('update', $post)`) for object-level access.
- Return API Resources rather than raw models so hidden attributes stay hidden.

## Queues and config
- Queued jobs must be idempotent; dispatch after commit (`afterCommit()`).
- Read config through `config()`, not `env()`, outside config files, so `config:cache` works.

## Verify
`php artisan test` (or `vendor/bin/pest` / `phpunit`), `vendor/bin/pint --test` or PHPStan/Larastan if configured.
