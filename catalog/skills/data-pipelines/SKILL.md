---
description: Build reliable data pipelines: idempotent loads, incremental processing, schema contracts, data quality checks and backfills
profile: full
tags: data, backend, reliability
---

# Data pipelines

Use when building or changing ETL/ELT jobs, dbt models or streaming transforms.

## Design
- Idempotent steps: re-running a day's job produces the same result (merge or upsert on keys, or overwrite partitions). Never append blindly.
- Process incrementally by partition or watermark, with late-arriving data in mind.
- Keep raw data immutable and transform into new tables.

## Contracts
Define schemas for inputs and outputs, validate at ingestion, and fail loudly on breaking changes instead of silently producing nulls.

## Data quality
Check row counts against the source, uniqueness of keys, not-null on required fields, accepted values, referential integrity and freshness. In dbt, use tests on models. Block downstream steps when checks fail.

## Operations
- Orchestrate with retries and alerts (Airflow, Dagster, Prefect).
- Backfills run as the same code with a date range, never as one-off SQL.
- Record lineage, and make the run date an input, never `now()`.

## Privacy
Minimize personal data, mask it in non-production copies, and apply retention rules.

## Verify
Run on a sample and a full partition, compare counts and aggregates with the source, run the quality checks, and re-run to prove idempotency.
