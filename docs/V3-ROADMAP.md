# FORGE V3 — Product and Engineering Roadmap

> Status: planning baseline. This branch is intentionally isolated from `main`; merge only after review and verified checks.

## Product goal

Build FORGE as a cross-harness engineering operating system that brings together the useful capabilities demonstrated by ECC (skills, specialist agents, rules, commands, hooks, memory, instincts/continuous learning, research-first workflows, security, orchestration, and integrations) while keeping FORGE's differentiator: verifiable execution, explicit trust boundaries, reproducible installs, and evidence-backed engineering outcomes.

Reference projects:
- FORGE: https://github.com/ansh44233/FORGE-ECC
- ECC: https://github.com/affaan-m/ECC
- FORGE website: https://forge-ecc.vercel.app/
- ECC website: https://ecc.tools/

This roadmap is an independent implementation plan. Do not copy ECC source files, skill text, prompts, assets, branding, or documentation wholesale. Study public behavior and concepts, preserve attribution where ideas are directly derived, and implement original FORGE interfaces and content. Review the target repository's current license and notices before any code reuse.

## Product principles

1. **Harness-native, not one-size-fits-all:** use native extension/plugin formats where supported and clearly label adapter limitations.
2. **Safe by default:** least privilege, explicit approval for consequential actions, no silent secret collection, and reversible writes.
3. **Research before change:** inspect repository context, verify current APIs/docs, state assumptions, then plan and implement.
4. **Evidence over claims:** every verification result records command, environment, timestamp, exit status, and relevant artifact references.
5. **Composable:** skills, agents, rules, hooks, memory, MCP tools, and workflows can be installed independently.
6. **Predictable lifecycle:** install, update, doctor, repair, list, and uninstall must be idempotent and preserve user-owned configuration.
7. **Transparent compatibility:** publish a tested capability matrix per harness and version; never imply parity where only partial adapters exist.

## Capability inventory and planned parity

| Domain | FORGE V2 baseline | V3 target |
|---|---|---|
| Skills | Catalog and installer foundations | Searchable, validated, versioned skill packs with provenance and compatibility metadata |
| Specialist agents | Agent/harness foundations | Role-based agents for planning, implementation, review, debugging, security, testing, docs, and architecture |
| Rules | Existing agent configuration support | Shared core rules plus language/framework/project packs; scoped loading |
| Commands | CLI and integrations | Discoverable command registry with consistent CLI and harness-native entry points |
| Hooks | Guard, post-edit, stop, session-start | Cross-harness hook adapters, policy profiles, lifecycle tests, safe rollback |
| Memory | Layered project/global memory | Typed memory, provenance, recency/relevance retrieval, retention controls, export/import |
| Instincts / learning | Existing intelligence foundations | Candidate learnings from user-approved outcomes; confidence, evidence, deduplication, promotion/rejection |
| Research-first | Partial engineering intelligence | Structured research brief, source freshness, API/version verification, decision log before implementation |
| Security | FORGE Shield and runtime guard | Policy engine, secret/config scanning, supply-chain checks, SARIF, explainable findings, safe remediation preview |
| Orchestration | Agent and workflow foundations | Task graph, specialist delegation, bounded retries, cancellation, budgets, human approval gates |
| Verification | Typecheck/test/build and sandbox foundations | Verification profiles, isolated execution, reproducible receipts, artifact/evidence ledger |
| MCP | Existing MCP server | Stable, permission-scoped tool catalog with schemas, audit events, and compatibility tests |
| Harness support | Claude, Cursor, Codex, OpenCode, Gemini foundations | Capability-driven adapters and install/upgrade/uninstall matrix for supported harnesses |
| Integrations | GitHub App and provider integrations | Provider-neutral adapters, GitHub workflows, optional external integrations |
| Operator UI | Hosted dashboard foundation | Local-first control plane for sessions, agents, tasks, memory, security, verification, and audit |
| Quality | Existing CI and tests | Unit, integration, compatibility, security, package smoke, and release gates |

## Delivery phases

### Phase 0 — Baseline and compatibility audit
- Inventory every V2 command, module, catalog entry, hook, MCP tool, API route, dashboard view, and test.
- Build a feature-by-feature ECC comparison from public documentation and repository behavior.
- Record what is already implemented, partial, absent, or not applicable in FORGE.
- Establish architecture decisions, threat model, supported Node.js/platform matrix, and baseline CI.
- No destructive rewrites; preserve V2 behavior unless a migration is explicitly designed.

### Phase 1 — V3 core architecture
- Define typed registries for skills, agents, rules, commands, hooks, harness adapters, and policies.
- Define manifest schemas, semantic versioning, validation, provenance, and compatibility metadata.
- Implement a dry-run install plan and transactional file writer with backups and rollback.
- Add doctor/status/list/repair/uninstall lifecycle contracts.

### Phase 2 — Skills, agents, rules, and commands
- Port capability concepts, not third-party source text.
- Add specialist packs and stack-aware discovery.
- Validate frontmatter/schema, references, allowed tools, and harness compatibility.
- Add pack-level tests and reproducible catalog generation.

### Phase 3 — Hooks, memory, instincts, and research
- Add harness-specific hook adapters with explicit capability boundaries.
- Implement typed memory with evidence, provenance, privacy controls, and user-managed retention.
- Implement opt-in learning candidates; never silently convert arbitrary project content into trusted instructions.
- Add research briefs with source links, checked dates, uncertainty, and implementation decisions.

### Phase 4 — Security and verified execution
- Unify Shield, runtime guard, policy evaluation, and approval decisions.
- Add threat-model-driven tests for command injection, path traversal, symlink escape, secret exposure, and unsafe config mutation.
- Run verification in bounded isolated workspaces; produce machine-readable receipts.
- Make security and dependency checks enforceable in CI with documented exception handling.

### Phase 5 — Orchestration and integrations
- Add task DAGs, agent delegation contracts, resource budgets, cancellation, and bounded retries.
- Add provider-neutral model adapters and MCP permission scopes.
- Expand GitHub integration with safe, reviewable workflows; no automatic merge by default.

### Phase 6 — Operator dashboard
- Show active sessions, tasks, agent state, tool activity, approvals, memory, security findings, and verification receipts.
- Use read-only views by default; consequential actions require explicit confirmation and audit events.
- Ensure dashboard status is derived from actual execution records, not optimistic UI state.

### Phase 7 — Release readiness
- Run clean-install, upgrade-from-V2, repair, rollback, and uninstall tests on supported platforms.
- Verify npm tarball contents and install from the published artifact in a clean environment.
- Require passing typecheck, unit/integration tests, security gates, compatibility tests, and package smoke tests.
- Publish migration guide, capability matrix, threat model, changelog, and reproducible release evidence.

## V3 quality gates

- No secrets or credentials are persisted in memory, logs, telemetry, or generated artifacts.
- Install/update/uninstall operations are idempotent and preserve unrelated user configuration.
- Every harness adapter reports tested, partial, unsupported, or unknown capabilities.
- Every security finding has severity, evidence, remediation guidance, and a stable identifier.
- Every claimed passing check links to a real successful run or local receipt.
- No autonomous merge, publish, deploy, destructive filesystem action, or permission broadening without explicit user approval.
- All generated files are validated before being written; dry-run is available for mutations.
- V2 migration is tested before any default behavior changes.

## Initial implementation order

1. Complete Phase 0 inventory and feature-gap matrix.
2. Add V3 manifest/schema and registry contracts.
3. Add adapter capability matrix and contract tests.
4. Add transactional install planner and rollback tests.
5. Expand skills/agents/rules/commands using original FORGE-authored content.
6. Add memory/instinct and research receipts.
7. Unify policy/security/verification receipts.
8. Add orchestration and dashboard surfaces.

## Definition of done

A V3 capability is not complete because a file or UI exists. It is complete when its schema, behavior, harness compatibility, security boundaries, lifecycle operations, tests, documentation, and observable evidence are all present.
