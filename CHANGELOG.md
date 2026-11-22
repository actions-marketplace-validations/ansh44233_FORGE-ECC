# FORGE Changelog

## 2.0.0 — The verified agent harness

FORGE 2.0 turns the workbench into a harness layer for the AI coding tools you already use — and keeps FORGE's evidence-first approach: install, guard, verify and prove.

### Install into every harness
- `forge install` renders FORGE agents, skills, slash commands and coding rules into **Claude Code, Cursor, Codex, OpenCode and Gemini** native formats, with `minimal`, `standard` and `full` profiles and automatic language detection (TypeScript/Node, React, Python, Go, Rust, Java/Kotlin, C#, PHP, Ruby, Swift).
- Every written file is hashed in `.forge/install-state.json`; FORGE never overwrites files it did not write or that you edited (unless `--force`), only edits its own managed block in `AGENTS.md`/`GEMINI.md`, and refuses to write through symlinks.
- `forge doctor`, `forge repair`, `forge uninstall` (restores the original project) and `forge catalog`.
- Catalog: 41 agents, 26 skills, 24 commands and 23 rules, each validated in CI.

### FORGE Shield
- `forge shield` scores agent configuration 0–100: Claude Code permissions and hooks, MCP servers (Claude, Cursor, VS Code, Gemini, OpenCode), hidden prompt injection (invisible Unicode, override phrases, hidden comments), secrets and CI workflow risks.
- JSON, Markdown and SARIF 2.1.0 output, `--fail-on` CI gate, safe `--fix`; defensive guidance that quotes attack phrases is not flagged.
- GitHub Action `operation: shield`; FORGE's own CI self-scans.

### Runtime hooks and memory
- `forge install --hooks` adds Claude Code hooks: **FORGE Guard** (denies catastrophic commands, asks before force-push, history discard, destructive SQL, publish/deploy, sudo, secret access and agent-config edits), a Shield check when agents edit their own configuration, an optional verification gate on Stop, and session-start memory injection.
- Layered memory (project + global) with provenance, credential rejection, relevance + recency search, handoffs; MCP tools `forge_memory_search`, `forge_memory_add`, `forge_shield_scan`.

### GitHub App and hosted dashboard
- Comment `/forge analyze` to get a setup pull request with FORGE files and a generated repository-specific `forge-project` skill (real verify commands, conventions, commit style). Also `/forge repair`, `audit`, `doctor`, `risk`, `help`.
- Every pull request gets a **FORGE** check run with an explainable change-risk score and Shield annotations.
- Hosted dashboard at `/app/`: Shield scores, setup health, PR risk, stack, activity and one-click setup PRs for repositories you can access.
- `forge analyze --write` generates the project skill locally.

### Upgrade notes
- The GitHub App needs Contents, Pull requests, Issues and Checks read & write, plus Issue comment and Pull request events. Sign in to the dashboard again after upgrading.
- `forge memory context --query` no longer mistakes the query for a project path.
- All 1.0 commands keep working unchanged.

## 1.0.0 — First major release

FORGE 1.0.0 brings the independent FORGE engineering workbench together as a versioned, installable product. It is designed to provide a local-first alternative for teams and developers who want codebase intelligence, agent orchestration, reviewable workflows, and measurable verification.

### Product experience
- Local engineering dashboard with project overview, health snapshots, architecture and dependency graphs, run history, task inspection, approvals, traces, reviews, verification history, and benchmark/evaluation views.
- Workspace explorer and code search for inspecting project files and symbols.
- Agent Configuration Studio for custom agent and skill Markdown, snapshots, and benchmark-gated configuration promotion.
- Visual workflow editor for reusable specialist-agent pipelines and draft run creation.
- Provider readiness and diagnostics views that avoid exposing credential values.

### Engineering capabilities
- Project inspection, architecture mapping, dependency intelligence, engineering-risk analysis, change intelligence, and quality auditing.
- Specialist-agent orchestration with saved runs, incremental task settlement, approval gates, replay/retry, and resume recovery.
- Project memory, workspace skills, declarative hooks, permission policies, and bounded read-only workspace tools.
- Review history, dry-run patch validation, explicit patch approval records, and staged promotion APIs.
- Verification history, evaluation suites, benchmark matrices, regression comparisons, and experiment manifests.
- MCP server and CLI workflows for local engineering automation.

### Install and launch
```bash
npm install -g forge-engineering-workbench
forge --version
forge init ./my-project
forge dashboard ./my-project
```

The dashboard binds to localhost by default. Open the URL printed in the terminal.

### Important V1 boundaries
- The public Vercel website is a static product site. The live dashboard runs locally against a workspace selected on the user's machine; it is not a hosted multi-user dashboard.
- Provider-backed runs require the user's own supported provider configuration and credentials. No provider connection or API spend is included by this release.
- Native model tool-calling is currently limited to bounded read-only workspace tools for the OpenAI-compatible provider. Other documented providers remain proposal-only in the normal run path.
- MCP workspace tools are read-only. Patch validation is a dry run; patch promotion is a separately reviewed library API, not an automatic agent action.
- Local script verification executes project-controlled code on the host. Docker verification is opt-in and depends on the host runtime. Do not treat local execution or heuristic risk scores as a security guarantee.
- Rootless Docker, live provider end-to-end validation, and hosted multi-user operation are not claimed as verified V1 capabilities.

This release establishes the FORGE product foundation. Future releases can expand integrations and hosted operation without weakening the local-first permission and approval model.
