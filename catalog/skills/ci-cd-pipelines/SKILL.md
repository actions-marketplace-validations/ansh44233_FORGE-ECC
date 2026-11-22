---
description: Fast, secure and reproducible CI/CD pipelines
profile: full
tags: ci, devops
---

# CI/CD Pipelines
- Run typecheck, lint, tests and build on every PR; make them required checks.
- Pin actions by version or SHA; least-privilege `permissions:`; no secrets on untrusted PR events.
- Cache dependencies by lockfile hash.
- Deploy from protected branches only, with preview environments and a rollback path.
- Scan agent configuration in CI: `forge shield . --fail-on high`.
