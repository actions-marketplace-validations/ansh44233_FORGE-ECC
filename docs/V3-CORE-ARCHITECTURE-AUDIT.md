# FORGE V3 Core Architecture Audit

**Baseline:** `main` at the Phase 0 audit snapshot  
**Scope:** project memory, orchestration, MCP server, harness catalog/installer, and CI  
**Status:** source-level inspection; no claim of runtime parity or passing tests

## Findings

### 1. Project memory — strong foundation; improve retrieval and learning controls

Existing implementation includes:
- Typed memory kinds: decision, architecture, constraint, preference, fact, lesson, and handoff.
- Project-local `.forge/memory.json` plus layered/global search.
- BM25-style ranking with tag/kind boosts and recency decay.
- Evidence and source provenance fields.
- Credential-pattern rejection, bounded file/entry/content sizes, atomic replacement, and a write lock.
- Context assembly with an explicit token budget; handoffs are kept separate from normal context.

V3 opportunities:
- Add an explicit inspectable/opt-in learning policy; never silently convert arbitrary conversation or repository text into durable memory.
- Add memory lifecycle controls: list, inspect, edit, prune/expire, export/import, and explain-why-retrieved.
- Add schema migration/versioning strategy before expanding the persisted format.
- Improve retrieval evaluation with a small curated relevance dataset and regression tests.
- Treat all retrieved memory as untrusted context, not executable instructions; retain evidence links and stale-note warnings.

### 2. Orchestration — safe proposal engine, not yet a full agent runtime

Existing implementation includes:
- DAG validation (unknown dependencies, self-dependencies, cycles).
- Dependency-aware scheduling and bounded concurrency (1–16).
- Per-task approval gates, cancellation checks, task events, and persisted token estimates.
- Provider interface accepts task plus completed dependency results and bounded project context.
- The module explicitly has no shell, filesystem-write, network, or tool-execution capability.

V3 opportunities:
- Keep planning/proposal generation separate from execution adapters.
- Define typed capability grants and per-task tool allowlists before introducing any execution.
- Add durable run state/versioned event records, retry policy, timeout handling, idempotency keys, and resumability tests.
- Add explicit budget policies for wall time, provider calls, and tokens; test parallel failure and cancellation edge cases.
- Require approval for consequential write/command actions and record approval provenance.

### 3. MCP — useful tool surface with workspace boundaries

Existing server exposes project inspection, architecture mapping, search/list/read, quality audit, Git intelligence, agent listing, review-plan creation, layered memory search/add, and Shield scanning. Workspace resolution and permission policy are applied to workspace tools; the protocol integration test checks traversal rejection, secret exclusion, memory credential rejection, and core tool availability.

V3 opportunities:
- Publish a machine-readable tool/capability manifest and stable input/output contracts.
- Add explicit read/write classification and per-tool authorization tests.
- Add pagination or continuation for bounded results and structured error codes.
- Test malformed arguments, symlink/path edge cases, oversized inputs, and concurrent calls.
- Keep MCP stdio stdout protocol-clean; send diagnostics only to stderr.

### 4. Harness catalog and installer — lifecycle already exists

Existing installer tests cover catalog validation, language detection, profiles, native output for multiple harnesses, dry-run, idempotency, preservation of user edits, profile shrink, doctor, and uninstall restoration.

V3 opportunities:
- Introduce a versioned harness capability registry: supported features, native format, hook support, and documented limitations.
- Add install-plan preview/diff as a stable public contract.
- Add transactional apply with rollback on partial failure; test interrupted writes.
- Add repair/status/list commands and per-target contract fixtures.
- Expand adapters only when upstream harness behavior is documented and tested; avoid claiming universal parity.

### 5. CI and branch workflow — confirmed V3 coverage gap

The inspected `.github/workflows/ci.yml` push and pull-request branch filters list `main` and `forge-v2`, but not `v3`. Consequently, ordinary pushes and pull requests targeting `v3` are not covered by this workflow.

V3 action:
- Update branch filters to include `v3` (or use a deliberate branch strategy that guarantees V3 checks).
- Require typecheck, unit/integration tests, build, Shield self-scan, package smoke test, and sandbox integration before promotion.
- Keep CI changes isolated on `v3`; do not merge to `main` without explicit approval.

## Recommended implementation order

1. **P0 — CI visibility:** make V3 branch checks run and verify the workflow.
2. **P0 — platform contracts:** versioned capability manifest, stable schemas, install-plan contract, and verification receipts.
3. **P1 — installer reliability:** transactional apply/rollback and repair workflow.
4. **P1 — memory quality:** opt-in learning controls, lifecycle operations, and retrieval evals.
5. **P1 — orchestration reliability:** durable resumability, retry/timeout/budget policy, and capability-gated execution design.
6. **P2 — MCP ecosystem:** capability discovery, structured errors, pagination, and broader contract tests.
7. **P2 — harness expansion:** adapters and catalog content based on verified upstream capabilities.

## Evidence and limits

This is a source-level audit of the listed files and tests on the current FORGE baseline. Test files demonstrate intended coverage but do not prove tests pass. No runtime commands were executed as part of this audit. ECC feature-by-feature behavioral comparison remains a separate task; this document does not claim full ECC parity.
