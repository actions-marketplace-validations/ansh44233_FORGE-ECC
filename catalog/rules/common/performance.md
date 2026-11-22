---
description: Performance hygiene and measurement
profile: standard
---

# Performance

- Measure before optimizing; record baseline and result.
- Avoid N+1 queries, unbounded loops over I/O and unbounded caches.
- Paginate large results; stream large files.
