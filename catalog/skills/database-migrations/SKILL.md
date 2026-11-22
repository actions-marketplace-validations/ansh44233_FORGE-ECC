---
description: Write safe, reversible schema migrations and backfills
profile: full
tags: database
---

# Database Migrations

- Expand → migrate → contract: add new columns/tables first, backfill in batches, switch reads, then remove old.
- Every migration has a tested down path or a documented forward-fix.
- Avoid long locks on large tables (create indexes concurrently where supported).
- Deploy schema changes compatible with both the old and new application version.
