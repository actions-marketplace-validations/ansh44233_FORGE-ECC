# FORGE Changelog

## 3.0.0 — Learn, loop and prove

FORGE 3.0 adds learning, unattended agent loops and a readiness score, and checks every result itself. The agent's word that it is done is never enough:

- **10 harnesses** with one install.
- **60 Shield rules.**
- **A readiness scorecard.**
- **Instincts that need your approval** before an agent uses them.
- **Cost tracking and a status line.**
- **A verified loop** that will not count a pass when the agent deleted or skipped tests.

Install:

```bash
npm install -g https://github.com/ansh44233/FORGE-ECC/releases/download/v3.0.0/forge-engineering-workbench-3.0.0.tgz
```

### Upgrading from 2.x
- Nothing breaks. The default install targets are the same five as in 2.x, and `.forge/install-state.json` is migrated from schema 1 to 2 automatically.
- To add the new hooks (prompt secret guard, pre-compact and session-end handoffs, cost tracking), run `forge install --hooks` again. Add `--statusline` for the status line.
- Shield has many more rules, so existing repos may show new findings. `forge shield --fail-on high` in CI only fails on high and critical findings.
- `forge loop` needs the agent CLI you choose (`claude`, `codex`, `gemini` or `opencode`) on your PATH.

### Added
- **Five new harness targets:** GitHub Copilot, Windsurf, Kiro, Cline and Zed, each in its own native format and listed in the capability manifest. The five original targets stay the default. A new target is added automatically when the project already uses that tool. Use `--target default|all|LIST` to choose.
- **`forge scorecard`** (alias `harness-audit`): deterministic 0–10 readiness score across nine categories. Each point cites its evidence, the output lists top actions, and `--min` works as a CI gate. It can also print JSON or Markdown.
- **Instincts and `forge evolve`:** learns habits from git co-change history, commit conventions, Guard denials and verification failures. Learned and imported instincts stay candidates until a person promotes them. Includes promote, reject, export and import. `forge evolve` compiles active instincts into a `forge-learned` skill, and active instincts are injected at session start.
- **Lifecycle hooks:**
  - `prompt-submit` blocks pasted live credentials.
  - `pre-compact` and `session-end` save automatic handoffs.
  - `stop` and `session-end` record token usage.
- **Guard rules:**
  - Blocks `--no-verify`.
  - Asks before git hooks are bypassed and before agents edit lint, format or type-check configs.
  - Supports validated project-specific rules in `.forge/harness-hooks.json`.
- **`forge cost`:** exact token usage per session, model and day, with labelled USD estimates and per-project rates.
- **`forge statusline`** and `forge install --statusline`. FORGE never replaces your own status line.
- **`forge loop`, a verified agent loop:**
  - Runs Claude Code, Codex, Gemini, OpenCode or any command until checks that FORGE runs itself pass.
  - Records a baseline, feeds failures back into the next iteration, and keeps a receipt for every iteration.
  - Stops when the agent stalls.
  - Integrity gate: stops with `needs-review` when the agent deletes or skips tests or changes test, lint or type configs, package scripts or CI, even if the checks went green.
- **Shield now has 60 rules (up from 23):**
  - Covers Codex, Gemini, VS Code/Copilot, Windsurf, Kiro, Cline, Zed and Roo config.
  - New critical rule: AI-agent GitHub workflows that anyone can trigger from an issue or comment.
  - New checks for dangerous pre-approved command families, subagent permission bypass, hook persistence and credential reads.
  - New MCP checks: container escapes, tunnels, credentials in URLs, and shadowed servers.
  - New secret checks: connection strings, webhooks, and `.env` files not ignored by git.
  - Two false positives found by scanning real-world harness repos are fixed.
  - The GitHub App scans the new locations too.
- **51 skills (up from 26), matched to your stack.**
  - 25 new skills:
    - Language and framework: TypeScript strict mode, Next.js App Router, React, Node.js APIs, Python tooling, FastAPI, Django, Go, Rust, Spring Boot, Rails, Laravel, .NET and SwiftUI.
    - Cross-stack: PostgreSQL, Kubernetes, Terraform, GraphQL, authentication and sessions, caching, LLM apps, ADRs, codebase onboarding, feature flags and background jobs.
  - The new `languages:` frontmatter field means a stack skill is installed only when that stack is detected, or with `--profile full`. A Python repo gets the Django skill, not the Spring one.
- Catalog commands: `/scorecard`, `/instincts`, `/evolve`, `/cost`, `/loop`.
- Transactional installer with a recovery journal, versioned install state with v1 migration, and the harness capability manifest (`forge harnesses`).

## 2.0.1 — Install and stability fixes

### Fixed
- **Installing a release no longer builds on your machine.** Install the prebuilt package attached to the GitHub release:
  ```bash
  npm install -g https://github.com/ansh44233/FORGE-ECC/releases/download/v2.0.1/forge-engineering-workbench-2.0.1.tgz
  ```
  Installing from a Git ref ran the TypeScript build during `npm install -g` and failed on some systems. README, docs, the landing page and the GitHub Action (for version tags) now use the release package.
- **GitHub App private key parsing.** `GITHUB_APP_PRIVATE_KEY` is accepted with real newlines, literal `\n`, CRLF, surrounding quotes, newlines turned into spaces, or base64, and a clear error is shown when it still cannot be read. `/api/github/health?check=key` reports the key's shape without exposing it.
- **CLI pipes.** `forge catalog | head` and similar pipes exit cleanly instead of crashing with `EPIPE`.

### Changed
- Landing page redesign with the FORGE icon set, and new README screenshots.

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
