---
description: Design consistent, versionable HTTP/RPC APIs with validated inputs and clear errors
profile: standard
tags: api, backend
---

# API Design

- Resource-oriented names, consistent pluralization and casing.
- Validate request bodies at the boundary with a schema; reject unknown fields where safe.
- Consistent error shape: machine code, human message, request id. Correct status codes.
- Pagination (cursor-based for large sets), idempotency keys for unsafe retries, rate limits.
- Version deliberately; never break existing clients silently. Document with examples.
