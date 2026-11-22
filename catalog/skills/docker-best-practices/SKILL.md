---
description: Small, secure, reproducible container images
profile: full
tags: docker, devops
---

# Docker Best Practices
- Pin base images by digest; prefer slim/distroless.
- Multi-stage builds; copy only build outputs into the final stage.
- Run as a non-root user; read-only filesystem where possible.
- Never bake secrets into layers; use build secrets or runtime env.
- `.dockerignore` excludes `.git`, `node_modules`, `.env`.
