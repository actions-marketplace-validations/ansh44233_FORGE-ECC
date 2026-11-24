# FORGE V3 — Phase 0 Repository Audit & Capability Gap Matrix

**Audit date:** 2026-11-23  
**Working branch:** `v3`  
**Scope:** Structural inventory of FORGE `main` and ECC `main`, plus targeted inspection of FORGE's CLI, installer, hooks, Shield, package metadata and ECC's package metadata/license/README. This is an inventory, not yet a line-by-line behavioral certification.

## 1. Repository baseline

| Measure | FORGE V2 main | ECC main | Notes |
|---|---:|---:|---|
| Tracked tree entries | 373 | 6,756 | Includes directories and files |
| Core source entries | 86 under `src` | 32 under `src` | Different architectures; not a quality comparison |
| Test entries | 75 | 672 | Entry count, not test count or pass rate |
| Agent catalog/files | 41 under `catalog/agents` | 72 under `agents` | FORGE has a curated catalog already |
| Command entries | 24 under `catalog/commands` | 99 under `commands` | ECC also ships harness-specific command mirrors |
| Rule entries | 34 under `catalog/rules` | 144 under `rules` | Language and harness distribution differs |
| Skill entries | 52 under `catalog/skills` | 1,066 under `skills` | ECC count includes nested files/directories, not 1,066 unique skills |
| Harness adapter targets declared in installer | 5 | Multiple native harness trees | FORGE currently declares Claude, Cursor, Codex, OpenCode and Gemini |

Tree snapshots:
- FORGE main: `6e57447266c7bdd0ed450223cc8b2bdc02b3e36f`
- ECC main: `4adeee6732a12d1540f49a4d50a38ce8c97f9a53`

## 2. FORGE strengths confirmed in source inspection

- **Universal installer foundation:** `src/core/harness-installer.ts` defines install plans, managed-file hashes, target-specific rendering and install state. Its comments describe preserving user-modified files.
- **Runtime hook foundation:** `src/core/harness-hooks.ts` defines pre-tool, post-edit, stop and session-start events, including guard, configuration checks, stop verification and session context.
- **Security foundation:** `src/core/forge-shield.ts` scans agent configuration, secrets, permissions, hooks, MCP, instruction files and CI workflows, with severity and remediation metadata.
- **Engineering workflow foundation:** CLI imports show project inspection, agent registry, orchestration, dashboard, quality audits, verification history, code intelligence, review, patch approval/application and sandbox-related modules.
- **Existing distribution/testing base:** npm package scripts include build, typecheck and Vitest; CI and release workflow files exist.

These are confirmed module/interface foundations. This audit has not run FORGE's test suite or verified every command end-to-end.

## 3. Capability gap matrix (structural assessment)

Status meanings:
- **Present:** a corresponding FORGE module or catalog is visible in the current tree.
- **Partial / verify:** some foundations exist, but parity, breadth or behavior needs a deeper code/test audit.
- **Gap candidate:** ECC has a visible dedicated surface and no equivalent top-level FORGE surface was identified in this structural pass. Confirm before treating it as absent.

| Capability | FORGE V2 evidence | ECC evidence | V3 assessment / next action |
|---|---|---|---|
| Skills | `catalog/skills` | `skills/`, mirrored into harness-specific locations | **Present / breadth gap.** Add skill manifests, metadata, search, provenance, validation and compatibility reporting; grow by quality, not raw count. |
| Specialist agents | `catalog/agents`, agent registry | `agents/`, plus harness-specific agent definitions | **Present / breadth + adapter gap.** Build typed agent manifests, capability declarations and native exports. |
| Rules | `catalog/rules` | `rules/` and harness mirrors | **Present / distribution gap.** Expand language/framework packs with shared source and generated, validated outputs. |
| Commands | `catalog/commands`, CLI | `commands/` plus harness-specific command sets | **Present / workflow gap.** Add command registry, discovery/help, argument schemas and parity tests. |
| Hooks | `harness-hooks.ts`, `hook-engine.ts` | `hooks/` and adapter-specific hook implementations | **Present / partial.** FORGE's inspected hook protocol is Claude-shaped; add adapter contracts and tested mappings for each harness. |
| Harness support | Installer declares Claude, Cursor, Codex, OpenCode, Gemini | Native trees include Claude, Codex, Cursor, Gemini, OpenCode, Zed, Pi, Kiro, Trae, Qwen, Kimi, Hermes, OpenClaw, Grok and plugin surfaces | **Largest visible gap.** Add a capability matrix and prioritize adapters by documented API support; do not claim universal parity. |
| Memory | Project-memory and session-context modules exist | Unified-memory design, memory persistence hooks and examples | **Present / verify.** Audit persistence, retrieval, privacy, compaction, portability and data lifecycle; add conformance tests. |
| Instincts / continuous learning | Continuous-learning catalog item exists | Homunculus instinct store and import/export/status commands | **Partial / gap candidate.** Design opt-in, inspectable learnings with confidence, source evidence, promotion/rejection and export/import. |
| Research-first workflows | Research-first skill exists | Research playbook, contexts and deep-research/research-ops skills | **Partial.** Make research-first an enforceable workflow with source/evidence records and freshness checks. |
| Security / Shield | FORGE Shield module and permission policy exist | AgentShield, security guides, supply-chain and policy tooling | **Present / deepen.** Compare rule coverage, false-positive controls, SARIF, policy exceptions and CI integration. |
| Orchestration | FORGE orchestrator and run store exist | Team-agent orchestration, worktrees, loop and status commands | **Present / verify.** Compare delegation, bounded loops, concurrency, cancellation, recovery and auditable approvals. |
| Evaluation / benchmarks | Evaluation engine, benchmark modules and eval fixture exist | Eval harness, examples, CI validators and compatibility checks | **Present / deepen.** Establish reproducible task sets, baselines, regression gates and published evidence. |
| MCP | Package exposes MCP server script and dependencies | MCP config, server conventions, memory MCP and related skills | **Present / verify.** Audit tool schemas, permission boundaries, transport, secret handling and lifecycle. |
| Operator control plane | Dashboard server and web assets exist | Control pane, dashboard scripts and readiness surfaces | **Present / product gap candidate.** Consolidate operator experience around install health, run evidence, compatibility and approvals. |
| Install lifecycle | Installer and state tracking exist | Plan/apply/guided install, doctor, repair, uninstall and list commands | **Partial / verify.** Test dry-run, update, repair, rollback, uninstall and user-config preservation as a single lifecycle contract. |
| Governance / provenance | Some install-state hashes and verification records exist | Manifests, schemas, skill validation, host-compat checks and release gates | **Partial.** Standardize schemas, provenance, versioning, signing/checksums and generated artifact validation. |
| Integrations | GitHub App/API and provider modules exist | Integrations directory, plugins and MCP configs | **Present / expand selectively.** Define an integration contract and require explicit user authorization. |
| Release / supply chain | CI, release and rootless sandbox workflows exist | Release gates, supply-chain scans, SLSA workflow and broad CI | **Partial / verify.** Add provenance attestations, dependency policy, package contents audit and release evidence. |

## 4. Prioritized V3 work

### P0 — Establish trustworthy platform contracts
1. Define versioned schemas for skill, agent, command, rule, hook adapter, harness capability and install manifest.
2. Build a single harness capability registry with statuses: tested, partial, unsupported, unknown.
3. Add installer dry-run and explicit change plan; transactional apply/rollback; doctor, repair, list and uninstall.
4. Add contract tests for idempotency and preservation of user-owned files/configuration.
5. Record verification receipts: exact command, runtime, timestamp, exit code and artifact references.

### P1 — Close the highest-value ECC capability gaps
1. Add adapter interfaces and native exporters for additional harnesses only where stable extension points are documented.
2. Add an opt-in instincts/learning store with review, confidence, provenance, expiry and export/import.
3. Turn research-first into a repeatable workflow with source quality/freshness and evidence records.
4. Expand the skill and agent catalog using original FORGE-authored content and quality gates.
5. Strengthen orchestration with bounded concurrency, cancellation, recovery and approval checkpoints.

### P2 — Operator and ecosystem maturity
1. Consolidate dashboard views for adapters, catalog health, runs, approvals, security and verification evidence.
2. Add compatibility/evaluation dashboards and regression baselines.
3. Harden MCP and third-party integrations with least-privilege scopes and explicit consent.
4. Publish migration, compatibility and release evidence.

## 5. Audit limitations and next checks

This pass used Git tree structure and targeted source reads. It does **not** prove feature parity, test quality, runtime behavior, supported harness versions or CI health. Next audit tasks:

- Read the full FORGE CLI command router and harness catalog/renderers.
- Inspect project-memory, orchestration, MCP server, dashboard, evaluation and install-state modules.
- Inspect ECC manifests, schemas, adapter compliance scripts, instinct commands and memory conformance examples.
- Compare actual hook event coverage and generated output for each harness.
- Retrieve latest CI run statuses for both repositories and run local tests only in an available checkout/environment.

## 6. Licensing and implementation boundary

ECC's current `package.json` declares MIT and its LICENSE contains the standard MIT grant and notice condition. FORGE's package also declares MIT. This does not mean V3 should copy ECC's implementation wholesale. Default approach: implement independently from public behavior and concepts; if a specific code reuse is later justified, preserve the applicable copyright and license notices and document the reused files and provenance. Do not copy ECC prompts, skill prose, documentation, branding or assets as a shortcut.

## 7. Completion criteria for Phase 0

- [x] Capture repository tree snapshots and counts.
- [x] Inspect FORGE package, CLI entry point, installer, hooks and Shield interfaces.
- [x] Confirm ECC package version/license and broad harness/catalog structure.
- [x] Create initial structural capability gap matrix.
- [ ] Complete module-level behavioral audit.
- [ ] Inspect CI results and establish a reproducible V2 test baseline.
- [ ] Convert confirmed gaps into implementation issues/checklist.

**Phase 0 status: in progress.** Structural inventory is complete; behavioral and CI verification remain open.
