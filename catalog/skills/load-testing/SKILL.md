---
description: Load test services with realistic traffic: goals, scenarios, ramp profiles, metrics and bottleneck analysis
profile: full
tags: performance, backend, testing
---

# Load testing

Use before launches, after performance work, or when capacity is unknown.

## Define success first
Write the target: requests per second, concurrency, p95/p99 latency and error rate for each important endpoint.

## Scenarios
- Model real user journeys and their mix, with think time, from production traffic where possible.
- Use realistic data volumes and cache states. A warm cache with one user tells you little.
- Run against an environment sized like production. Never point a load test at production without explicit agreement.

## Profiles
Smoke (tiny), load (expected peak), stress (beyond peak until it breaks) and soak (hours at normal load to find leaks). Ramp gradually.

## Tools
k6, Locust, Gatling or wrk. Keep scripts in the repo next to the code they test.

## Analyze
Correlate client metrics with server metrics: CPU, memory, GC, connection pools, database time, queue depth. Find the first resource to saturate, fix one thing, and re-run.

## Verify
Report targets vs results, the bottleneck found, the change made and the re-run numbers from the same profile.
