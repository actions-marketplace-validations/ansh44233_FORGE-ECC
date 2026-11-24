---
description: Model MongoDB data for its queries: embedding vs referencing, indexes, transactions and schema validation
profile: full
tags: database, backend, mongodb
---

# MongoDB modeling

Use when designing collections or changing MongoDB queries.

## Model for the queries
1. List the reads and writes with their frequency first.
2. Embed data that is read together and bounded in size (an order's line items). Reference data that is shared, grows without bound, or changes independently (a user's comments).
3. Keep documents well under the 16 MB limit. Unbounded arrays are a design bug.

## Indexes
- Compound indexes follow the ESR rule: Equality fields, then Sort fields, then Range fields.
- Check plans with `explain("executionStats")`: look for COLLSCAN and docs examined far above docs returned.
- TTL indexes for expiring data; unique indexes to enforce invariants.

## Consistency
- Single-document writes are atomic, so design invariants to live in one document where possible.
- Use multi-document transactions only when needed; keep them short.
- Set write concern `majority` for data you cannot lose.

## Schema
Use `$jsonSchema` validation on collections, and version documents (`schemaVersion`) to migrate lazily or in batches.

## Safety
Never build queries from raw user objects. Operators like `$where` or `$gt` can be injected. Validate input types first.

## Verify
`explain` output for the main queries, tests with realistic document sizes, and a migration dry run on a copy.
