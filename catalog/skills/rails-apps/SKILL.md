---
description: Change Ruby on Rails apps: migrations, Active Record queries, strong params, background jobs and tests
profile: standard
languages: ruby
tags: ruby, rails, backend
---

# Rails apps

Use in projects with a `Gemfile` that includes `rails`.

## Migrations
- Generate with `bin/rails g migration`, read the file, run `bin/rails db:migrate`, and commit `db/schema.rb` (or `structure.sql`) with it.
- On large tables, add indexes concurrently in PostgreSQL (`disable_ddl_transaction!` plus `algorithm: :concurrently`), and add columns before backfilling and constraining them.
- Never change a migration that has already run in shared environments.

## Active Record
- Avoid N+1: `includes`/`preload`, and check with the Bullet gem if the project uses it.
- Never interpolate input into SQL strings: use `where(name: value)` or `where("name = ?", value)`.
- Use `find_each` for batch processing, not `all.each`.
- Wrap multi-record writes in `transaction`. Prefer validations plus database constraints for invariants that matter.

## Controllers
- Strong parameters (`params.require(:user).permit(...)`) for every mass assignment.
- Scope records to the current user (`current_user.projects.find(params[:id])`) for authorization, or use Pundit/CanCanCan policies.
- Keep controllers thin; move logic into models or service objects.

## Jobs
Make Active Job/Sidekiq jobs idempotent and pass ids, not objects. Enqueue after the transaction commits (`after_commit`).

## Verify
`bin/rails test` or `bundle exec rspec`, `bundle exec rubocop` if configured, and `bin/rails db:migrate:status` after migration changes.
