---
description: Work effectively in monorepos: find owners, scope changes, run affected checks
profile: full
tags: monorepo
---

# Monorepo Navigation
- Find the workspace tool (pnpm/yarn/npm workspaces, Nx, Turborepo, Bazel) and its package graph.
- Scope work to the affected package; respect package boundaries and public entry points.
- Run checks for affected packages (`turbo run test --filter=...`, `nx affected`) before the full suite.
- Check CODEOWNERS for reviewers.
