# FORGE V2 — Day 1 V1 Baseline Audit

**Date:** 2026-11-20  
**Audit status:** Initial repository baseline; deeper module-by-module review is still required.  
**V1 baseline commit:** `7de27108a2290dba8625b2b5c1e61c935dc5a49c`  
**V2 branch:** `forge-v2`, created from the exact V1 baseline commit above.

## 1. Safety boundary

- `main` remains the V1 source of truth.
- All V2 work belongs on `forge-v2`.
- This audit document is the only Day 1 change so far; no application source, V1 dashboard, public landing page, or deployment configuration has been changed.
- No Vercel deployment has been triggered by this work.
- Do not merge V2 into `main` until the release checklist and explicit approval are complete.

## 2. Repository baseline

The `main` tree contains 178 tracked files, including 67 `src/core` modules, 70 test files, 11 API files and 3 GitHub Actions workflows.

The project is a TypeScript / Node.js 22+ package. Its current scripts include build, typecheck, Vitest, CLI start/dev and MCP server commands. Runtime dependencies include TypeScript, Zod and the MCP server SDK.

The latest observed successful `FORGE CI` run on `main` was created on 2026-11-17. CI runs typecheck, tests, build, package/CLI smoke checks and a real Docker sandbox integration job.

## 3. Capability baseline (initial classification)

| Area | Observed V1 implementation | Initial V2 classification |
|---|---|---|
| Agent catalog | 12 built-in specialist definitions plus workspace Markdown agents | Extend contracts, capabilities, lifecycle and routing |
| Orchestration | Dependency validation, bounded parallel task batches, approvals, cancellation hooks and persisted run records | Strengthen task-level settlement, recovery and durable execution |
| Providers | OpenAI-compatible, hosted provider adapters, Claude Code adapter and model routing | Standardize provider contracts, capabilities, budgets and compatibility |
| Workspace context | Read-only code search evidence supplied to agent tasks | Improve retrieval quality, ranking, provenance and context budgets |
| Skills | 7 built-in skills; workspace Markdown and nested `SKILL.md` discovery | Add schema/version compatibility, catalog management and safer distribution |
| Memory | Version-1 JSON project memory with bounded entries, simple lexical relevance and secret-pattern rejection | Add layered memory, provenance, retention, stronger sensitive-data handling and migrations |
| Hooks | One `before-agent` event with approval, context-append and block actions | Add lifecycle coverage and deterministic policy/audit semantics |
| Permissions | Proposal-only default; restricted OpenAI path limited to audited read-only tools | Define capability-scoped permissions and consistent enforcement |
| Workflows | Persisted workflow definitions, task dependencies and optional visual positions | Add templates, checkpoints, resumability and task settlement semantics |
| Patch workflow | Review validation, explicit approval records, staging and promotion workflow | Improve end-to-end evidence, rollback and auditability |
| Verification | Explicit npm-script verification with timeouts and output limits | Add profiles, richer test selection and evidence linkage |
| Container sandbox | Digest-pinned image, no network, read-only root, dropped capabilities, resource limits and workspace snapshot | Preserve strong baseline; audit runtime boundaries and broaden policy tests |
| Quality / intelligence | Project inspection, architecture/dependency analysis, risk, code review and regression signals | Improve language coverage, accuracy and evidence quality |
| Evaluation | Deterministic rubric evaluation and optional model judge with quote evidence checks | Add benchmark reliability, semantic quality measures and release gates |
| Operator UI | Local dashboard server and CLI; dashboard HTML is embedded in a very large server module | Separate UI/API boundaries and make the operator experience easier to evolve |
| Public website | Static `public/index.html` landing page | Keep separate from local dashboard; no redesign in this phase |

This table records code paths inspected and the current implementation shape. It is not a claim that every path has passed a fresh local runtime test.

## 4. Architecture observations and risks

### A. Large orchestration surfaces
- `src/cli.ts` is approximately 108 KB.
- `src/core/dashboard-server.ts` is approximately 155 KB and contains the local dashboard HTML and many API routes.
- These are high-coupling files. V2 should introduce seams incrementally rather than rewrite them wholesale.

### B. Agent execution boundary must remain explicit
- The core orchestrator coordinates provider-generated proposals and does not itself expose arbitrary shell, filesystem-write, network or tool execution.
- The permission layer defaults to proposal-only and currently describes a narrow read-only tool path for OpenAI.
- Patch promotion is a separate approval-oriented workflow.
- V2 must not blur read-only tools, patch staging, patch promotion and arbitrary command execution into one permission.

### C. Existing foundations are stronger than a blank-slate project
- Agent registry, routing, task DAGs, run persistence, review history, workflow storage, memory, skill discovery, sandbox policy, verification, benchmarks and traces already exist.
- V2 should first improve contracts and integration between these systems, not duplicate them with parallel implementations.

### D. Extensibility limits
- Hooks currently support only `before-agent`.
- Memory is a single versioned JSON document and uses simple term matching for retrieval.
- Skill discovery exists, including nested `SKILL.md` files, but a complete install/update/catalog compatibility lifecycle is not established by the inspected implementation.
- Workflow definitions exist, but a full durable workflow runtime with checkpoints and per-task recovery needs further review.

### E. CI and branch protection
- The current CI workflow triggers on pushes to `main` and pull requests targeting `main`; direct pushes to `forge-v2` are not currently covered by that push trigger.
- GitHub reported `protected: false` for both `main` and the newly created `forge-v2` branch at audit time.
- Before V2 implementation accelerates, add a V2 CI trigger and enable suitable branch protection/rules for `main`. No protection settings have been changed by this audit.

### F. Deployment boundary
- The repository has a Vercel configuration that builds the package and serves the `public` directory.
- The repository files alone do not prove which Vercel branch is configured for production. Verify that setting before any merge or deployment.
- Keep the public V1 site untouched while V2 is developed and previewed separately.

## 5. Day 1 decisions

1. Preserve the V1 baseline commit and keep `main` as the production line.
2. Use `forge-v2` as the isolated development branch.
3. Do not replace working V1 modules without a demonstrated gap and migration plan.
4. Prefer additive, contract-first changes and small refactors.
5. Treat feature completion as implementation + tests + docs + observed verification.
6. Require explicit user approval for provider spend, credential use, destructive actions, permission expansion and production deployment.
7. Keep FORGE's own architecture and identity; use ECC as a capability reference, not as a repository to bulk-copy.

## 6. Day 2 audit tasks

- Complete module-by-module review of agent orchestration, provider contracts, run persistence and recovery.
- Trace the real CLI-to-provider-to-run-store execution path.
- Trace dashboard routes to core services and identify safe module boundaries.
- Inspect sandbox, patch approval/promotion and workspace path protections.
- Review test coverage against public behavior and known edge cases.
- Establish a baseline CI matrix for `forge-v2`.
- Produce the V1 capability matrix with `Implemented / Partial / Missing / Needs verification` and the V2 architecture decision record.

## 7. Verification limits

This Day 1 work used repository source and GitHub metadata inspection. It did not run `npm ci`, tests, typecheck, build, Docker integration tests or a Vercel preview locally. The latest observed successful main CI run is historical evidence, not a fresh Day 1 test run.
