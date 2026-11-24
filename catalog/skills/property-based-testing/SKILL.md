---
description: Use property-based testing to find edge cases: invariants, generators, shrinking and round-trip properties
profile: full
tags: testing, quality
---

# Property-based testing

Use for parsers, serializers, algorithms, data transformations and anything with many edge cases.

## Find properties
- Round-trip: `decode(encode(x)) == x`.
- Invariants: sorting keeps length and elements, and the output is ordered.
- Oracles: compare against a simple, slow reference implementation.
- Idempotence: `normalize(normalize(x)) == normalize(x)`.
- Metamorphic relations: adding a filter never returns more results.

## Generators
Generate the input space the code really accepts, including empty values, unicode, extremes and duplicates. Build complex values from smaller generators, and constrain at generation time rather than discarding most cases.

## Tools
fast-check (TypeScript), Hypothesis (Python), proptest (Rust), jqwik (Java) and gopter or rapid (Go).

## Failures
Let the tool shrink failures to a minimal case, then add that case as a regular example test so it stays covered.

## Verify
Run with a fixed seed in CI and a higher number of runs locally or nightly. Record the seed on failure.
