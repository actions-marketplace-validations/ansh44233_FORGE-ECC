import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * FORGE Shield v3 rule pack: deeper checks for permissions, hooks, MCP,
 * instructions and CI, plus coverage for Copilot, Windsurf, Kiro, Cline,
 * Zed and Codex configuration. Pure functions over file contents, so every
 * finding is reproducible.
 */

export type Severity = "critical" | "high" | "medium" | "low";
export type Category = "secrets" | "permissions" | "hooks" | "mcp" | "injection" | "instructions" | "ci";
export interface RuleDef { id: string; severity: Severity; category: Category; title: string; recommendation: string; fixable?: boolean }
export type MakeFinding = (ruleId: string, file: string, line: number, detail: string) => { ruleId: string; file: string; line: number };

export const EXTENDED_RULES: RuleDef[] = [
  // Secrets
  { id: "SHIELD-SEC-004", severity: "high", category: "secrets", title: "Connection string with an embedded password", recommendation: "Move the password into an environment variable and build the URL at runtime; rotate the exposed password." },
  { id: "SHIELD-SEC-005", severity: "high", category: "secrets", title: "Webhook URL with an embedded secret", recommendation: "Anyone with a Slack/Discord/Teams webhook URL can post as your app; move it to a secret store and regenerate it." },
  { id: "SHIELD-SEC-006", severity: "medium", category: "secrets", title: ".env file is not ignored by git", recommendation: "Add `.env` and `.env.*` (except `.env.example`) to .gitignore so agents and humans cannot commit it." },
  { id: "SHIELD-SEC-007", severity: "medium", category: "secrets", title: "Local agent settings are not ignored by git", recommendation: "Add `.claude/settings.local.json` (and other *.local.* agent files) to .gitignore; they often hold personal tokens and approvals." },
  { id: "SHIELD-SEC-008", severity: "medium", category: "secrets", title: "MCP server is handed cloud credential files", recommendation: "Give the server a scoped, short-lived credential instead of ~/.aws/credentials, kubeconfig or a service-account key file." },
  // Permissions
  { id: "SHIELD-PERM-007", severity: "high", category: "permissions", title: "Dangerous command family is pre-approved", recommendation: "Remove allow rules such as `Bash(rm:*)`, `Bash(git push:*)`, `Bash(curl:*)`, `Bash(sudo:*)` or `Bash(npm publish:*)`; let these prompt every time." },
  { id: "SHIELD-PERM-008", severity: "medium", category: "permissions", title: "Agent is given access to the home or root directory", recommendation: "Limit `additionalDirectories` to specific project folders." },
  { id: "SHIELD-PERM-009", severity: "high", category: "permissions", title: "Codex runs without a sandbox or approvals", recommendation: "Use `sandbox_mode = \"workspace-write\"` and an approval policy other than `never` for interactive use." },
  { id: "SHIELD-PERM-010", severity: "medium", category: "permissions", title: "Gemini CLI auto-accepts tool calls", recommendation: "Turn off `autoAccept` / YOLO mode in .gemini/settings.json; approve state-changing tools individually." },
  { id: "SHIELD-PERM-011", severity: "high", category: "permissions", title: "Editor agent auto-approves tool calls", recommendation: "Remove `chat.tools.autoApprove` (and global auto-approve) from .vscode/settings.json; it lets Copilot/agent mode run terminal commands unreviewed." },
  { id: "SHIELD-PERM-012", severity: "medium", category: "permissions", title: "All hooks are disabled", recommendation: "Remove `disableAllHooks`; it silently turns off security hooks such as FORGE Guard." },
  { id: "SHIELD-PERM-013", severity: "medium", category: "permissions", title: "Agent may read the entire home directory or filesystem", recommendation: "Scope Read rules to the project; never pre-approve `Read(~/**)` or `Read(//**)`." },
  { id: "SHIELD-PERM-014", severity: "medium", category: "permissions", title: "Unrestricted web fetch is pre-approved", recommendation: "Approve `WebFetch(domain:example.com)` per domain; unrestricted fetch is both a prompt-injection and exfiltration path." },
  { id: "SHIELD-PERM-015", severity: "high", category: "permissions", title: "Subagent bypasses permission checks", recommendation: "Remove `permissionMode: bypassPermissions` from the subagent's frontmatter; subagents should not have more power than the main session." },
  // Hooks
  { id: "SHIELD-HOOK-005", severity: "medium", category: "hooks", title: "Hook runs a script from outside the repository", recommendation: "Keep hook scripts in the repo (e.g. .claude/hooks/) so they are reviewed with the code." },
  { id: "SHIELD-HOOK-006", severity: "high", category: "hooks", title: "Hook writes to agent instructions or settings", recommendation: "Hooks that modify CLAUDE.md, AGENTS.md or agent settings can persist injected instructions; remove the write." },
  { id: "SHIELD-HOOK-007", severity: "high", category: "hooks", title: "Hook reads credential files", recommendation: "Remove reads of .env, ~/.ssh, ~/.aws or keychains from hooks; hooks run on every tool call." },
  { id: "SHIELD-HOOK-008", severity: "medium", category: "hooks", title: "Hook runs an unpinned package", recommendation: "Pin the package version (`npx -y tool@1.2.3`) or vendor the script." },
  // MCP
  { id: "SHIELD-MCP-005", severity: "high", category: "mcp", title: "MCP server container has host-level access", recommendation: "Drop `--privileged`, host networking and mounts of `/`, the home directory or the Docker socket." },
  { id: "SHIELD-MCP-006", severity: "high", category: "secrets", title: "Credential in a remote MCP server URL", recommendation: "Send credentials in a header read from an environment variable, never in the URL query string." },
  { id: "SHIELD-MCP-007", severity: "medium", category: "mcp", title: "MCP server installed from an unpinned git or tarball URL", recommendation: "Pin git sources to a commit SHA or use a versioned registry package." },
  { id: "SHIELD-MCP-008", severity: "high", category: "mcp", title: "MCP server runs with sudo", recommendation: "Run MCP servers as the current user; grant only the specific access they need." },
  { id: "SHIELD-MCP-009", severity: "medium", category: "mcp", title: "Same MCP server name defined differently in two configs", recommendation: "Rename or remove the duplicate; a later config can silently shadow a trusted server." },
  { id: "SHIELD-MCP-010", severity: "low", category: "mcp", title: "Many MCP servers enabled", recommendation: "Each server adds tool descriptions to every prompt and widens the attack surface; keep the set small and project-specific." },
  { id: "SHIELD-MCP-011", severity: "high", category: "mcp", title: "MCP server reached through a public tunnel or paste host", recommendation: "Do not connect agents to ngrok, trycloudflare, localtunnel or paste URLs; host reviewed servers on a stable, owned domain." },
  // Injection / instructions
  { id: "SHIELD-INJ-004", severity: "high", category: "injection", title: "Instructions tell the agent to run downloaded code", recommendation: "Remove `curl … | sh` style steps from agent instructions and skills; vendor and review scripts instead." },
  { id: "SHIELD-INJ-005", severity: "high", category: "injection", title: "Instructions tell the agent to send secrets or files elsewhere", recommendation: "Remove text that asks the agent to upload, post or send credentials, environment variables or keys." },
  { id: "SHIELD-INJ-006", severity: "medium", category: "injection", title: "Large encoded blob in agent instructions", recommendation: "Remove long base64/hex payloads from instructions; reviewers cannot see what they contain." },
  { id: "SHIELD-INJ-007", severity: "medium", category: "injection", title: "Instructions recommend disabling safety checks", recommendation: "Remove advice to use `--dangerously-skip-permissions`, `--yolo`, `bypassPermissions` or `--no-verify`." },
  { id: "SHIELD-INJ-008", severity: "low", category: "instructions", title: "Agent instruction file is very large", recommendation: "Split it into scoped rules or skills; huge always-on instructions waste context and hide risky lines." },
  // CI
  { id: "SHIELD-CI-004", severity: "low", category: "ci", title: "Third-party action is not pinned to a commit", recommendation: "Pin third-party actions to a full commit SHA (`uses: owner/action@<40-char sha> # v1.2.3`)." },
  { id: "SHIELD-CI-005", severity: "high", category: "ci", title: "Workflow prints or sends a secret", recommendation: "Never `echo` secrets or pass them on a command line to curl; use them only through env vars read by the tool." },
  { id: "SHIELD-CI-006", severity: "critical", category: "ci", title: "AI agent workflow can be triggered by anyone", recommendation: "Gate the agent job on `github.event.comment.author_association` (OWNER/MEMBER/COLLABORATOR) or a label applied by maintainers; otherwise any user can prompt-inject your agent with repository secrets." },
  { id: "SHIELD-CI-007", severity: "high", category: "ci", title: "AI agent in CI runs with permissions bypassed", recommendation: "Remove `--dangerously-skip-permissions` / unrestricted `Bash` from the agent action; allow only the tools the job needs." },
  { id: "SHIELD-CI-008", severity: "medium", category: "ci", title: "Self-hosted runner used for pull requests", recommendation: "Do not run untrusted pull request code on self-hosted runners; use GitHub-hosted runners or require approval." },
  { id: "SHIELD-CI-009", severity: "low", category: "ci", title: "Workflow does not declare token permissions", recommendation: "Add a top-level `permissions:` block (e.g. `contents: read`) so GITHUB_TOKEN is least-privilege." },
  { id: "SHIELD-CI-010", severity: "high", category: "ci", title: "Workflow runs downloaded code", recommendation: "Replace `curl … | sh` with a pinned, checksummed download or a pinned action." },
];

/** Extra locations scanned by Shield v3. */
export const EXTENDED_INSTRUCTION_FILES = [".clinerules", ".rules", ".github/copilot-instructions.md"];
export const EXTENDED_SETTINGS_FILES = [".vscode/settings.json", ".codex/config.toml", ".gemini/settings.json", ".zed/settings.json"];
export const EXTENDED_MCP_FILES = [".kiro/settings/mcp.json", ".roo/mcp.json", ".zed/settings.json", ".windsurf/mcp.json"];
export const EXTENDED_DIRECTORIES = [".github/instructions", ".github/prompts", ".github/agents", ".windsurf/rules", ".windsurf/workflows", ".kiro/steering", ".clinerules", ".roo/rules"];

const lineAt = (content: string, index: number) => content.slice(0, Math.max(0, index)).split("\n").length;
const lineOfText = (content: string, needle: string | RegExp) => {
  const index = typeof needle === "string" ? content.indexOf(needle) : content.search(needle);
  return index < 0 ? 1 : lineAt(content, index);
};
const asRecord = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const DEFENSIVE = /\b(?:not|never|don't|do\s+not|must\s+not|avoid|refuse|reject|block|blocks|blocked|deny|denies|flag|flags|detect|warn|forbid|forbidden|instead\s+of|such\s+as|e\.g\.|for\s+example|like)\b[^.]{0,100}$/i;
function defensive(line: string, index: number): boolean {
  const before = line.slice(0, index);
  if (((before.match(/[`"“”']/g) ?? []).length) % 2 === 1) return true;
  return DEFENSIVE.test(before);
}

// ---------------------------------------------------------------------------
// Text-level checks (any scanned file)
// ---------------------------------------------------------------------------

const CONNECTION = /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver):\/\/[^:\s/@"'`]+:([^@\s"'`]{3,})@[\w.-]+/gi;
const WEBHOOK = /https:\/\/(?:hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{12,}|(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]{30,}|[\w-]+\.webhook\.office\.com\/webhookb2\/[\w@-]{20,})/;

export function scanTextExtended(file: string, content: string, make: MakeFinding): Array<ReturnType<MakeFinding>> {
  const out: Array<ReturnType<MakeFinding>> = [];
  for (const match of content.matchAll(CONNECTION)) {
    const password = match[1] ?? "";
    if (/^\$\{?[A-Za-z_]|^<|^\*+$|^(?:password|pass|secret|changeme|xxx+|\.\.\.)$/i.test(password)) continue;
    out.push(make("SHIELD-SEC-004", file, lineAt(content, match.index ?? 0), "A database or broker URL contains a literal password. The value is not shown."));
  }
  const hook = WEBHOOK.exec(content);
  if (hook) out.push(make("SHIELD-SEC-005", file, lineAt(content, hook.index), "A chat webhook URL with its secret path is present. The value is not shown."));
  return out;
}

const INSTRUCTION_FILE = /\.(?:md|mdc|txt)$|(?:^|\/)(?:\.clinerules|\.rules|\.cursorrules|\.windsurfrules)$/i;
const REMOTE_EXEC = /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\b(?:ba)?sh\s+<\(\s*(?:curl|wget)|\biex\s*\(\s*(?:iwr|Invoke-WebRequest)/i;
const EXFIL = /\b(?:send|post|upload|exfiltrate|transmit|forward|email|paste)\b[^.\n]{0,60}(?:\.env\b|\b(?:env(?:ironment)?\s+var(?:iable)?s|secrets?|api[\s_-]?keys?|tokens?|credentials?|ssh\s+keys?|private\s+keys?|passwords?)\b)[^\n]{0,60}\b(?:to|into|at)\b[^.\n]{0,40}(?:https?:\/\/|\bwebhook\b|\bserver\b|\bendpoint\b|\burl\b|@)/i;
const UNSAFE_ADVICE = /--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|\bbypassPermissions\b|--yolo\b|\bgit\s+commit\b[^\n]*--no-verify|--no-verify\b/;
const BLOB = /[A-Za-z0-9+/]{400,}={0,2}|\b(?:[0-9a-f]{2}){250,}\b/;

export function scanInstructionsExtended(file: string, content: string, make: MakeFinding, options: { generated?: boolean } = {}): Array<ReturnType<MakeFinding>> {
  const out: Array<ReturnType<MakeFinding>> = [];
  if (!INSTRUCTION_FILE.test(file)) return out;
  const lines = content.split(/\r?\n/);
  // Human-facing docs that happen to live in an agent folder (install guides, changelogs).
  const humanDoc = /(?:^|\/)(?:README|MIGRATION|CHANGELOG|CONTRIBUTING|INSTALL|LICENSE)[\w.-]*\.md$/i.test(file);
  let inFence = false;
  lines.forEach((line, index) => {
    if (/^\s*(?:```|~~~)/.test(line)) inFence = !inFence;
    const remote = REMOTE_EXEC.exec(line);
    if (remote && !humanDoc && !defensive(line, remote.index)) out.push(make("SHIELD-INJ-004", file, index + 1, "An instruction pipes downloaded content into a shell."));
    const exfil = EXFIL.exec(line);
    if (exfil && !defensive(line, exfil.index)) out.push(make("SHIELD-INJ-005", file, index + 1, "An instruction asks the agent to send credentials or private data to an external destination."));
    const unsafe = UNSAFE_ADVICE.exec(line);
    // FORGE's own generated rules mention these flags only to forbid them.
    if (unsafe && !options.generated && !defensive(line, unsafe.index) && !inFence) out.push(make("SHIELD-INJ-007", file, index + 1, `The text recommends \`${unsafe[0].trim()}\`.`));
    if (BLOB.test(line)) out.push(make("SHIELD-INJ-006", file, index + 1, "A long encoded payload is embedded in the instructions."));
  });
  if (content.length > 40_000 && /(?:^|\/)(?:AGENTS|CLAUDE|GEMINI)\.md$|copilot-instructions\.md$|\.cursorrules$|\.windsurfrules$/.test(file)) {
    out.push(make("SHIELD-INJ-008", file, 1, `The always-on instruction file is ${Math.round(content.length / 1000)} KB.`));
  }
  if (/^\.claude\/agents\/[^/]+\.md$/.test(file)) {
    const front = /^---\n([\s\S]*?)\n---/.exec(content)?.[1] ?? "";
    if (/^\s*permissionMode\s*:\s*["']?bypassPermissions/m.test(front)) out.push(make("SHIELD-PERM-015", file, lineOfText(content, "permissionMode"), "The subagent frontmatter sets `permissionMode: bypassPermissions`."));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const DANGEROUS_ALLOW = /^Bash\(\s*(?:rm|sudo|curl|wget|git\s+push|git\s+reset|npm\s+publish|pnpm\s+publish|yarn\s+publish|docker|kubectl|terraform|ssh|scp|chmod|chown|dd|mkfs|eval|bash|sh|zsh|node\s+-e|python3?\s+-c)\b[^)]*\)$/i;

export function scanClaudeSettingsExtended(file: string, content: string, settings: Record<string, unknown>, make: MakeFinding): Array<ReturnType<MakeFinding>> {
  const out: Array<ReturnType<MakeFinding>> = [];
  const permissions = asRecord(settings.permissions);
  for (const rule of strings(permissions?.allow)) {
    const normalized = rule.trim();
    if (DANGEROUS_ALLOW.test(normalized)) out.push(make("SHIELD-PERM-007", file, lineOfText(content, `"${rule}"`), `\`${rule}\` pre-approves a destructive or network command family.`));
    if (/^Read\(\s*(?:~\/\*\*|\/\/\*\*|~|\/\*\*|\/)\s*\)$/.test(normalized)) out.push(make("SHIELD-PERM-013", file, lineOfText(content, `"${rule}"`), `\`${rule}\` lets the agent read outside the project.`));
    if (normalized === "WebFetch" || normalized === "WebFetch(*)") out.push(make("SHIELD-PERM-014", file, lineOfText(content, `"${rule}"`), "`WebFetch` is approved for every domain."));
  }
  for (const dir of strings(permissions?.additionalDirectories)) {
    if (/^(?:\/|~\/?|\$HOME\/?|\/(?:Users|home)\/[^/]+\/?|[A-Za-z]:\\?)$/.test(dir.trim())) out.push(make("SHIELD-PERM-008", file, lineOfText(content, `"${dir}"`), `\`additionalDirectories\` includes \`${dir}\`.`));
  }
  if (settings.disableAllHooks === true) out.push(make("SHIELD-PERM-012", file, lineOfText(content, "disableAllHooks"), "`disableAllHooks` is true."));
  return out;
}

export function scanHookCommandExtended(file: string, content: string, command: string, make: MakeFinding): Array<ReturnType<MakeFinding>> {
  const out: Array<ReturnType<MakeFinding>> = [];
  const line = lineOfText(content, command.slice(0, 60));
  if (/(?:^|[\s;&|])(?:\/(?!dev\/|tmp\/|usr\/bin\/env\b|usr\/(?:local\/)?bin\/)[\w.-]+\/|~\/)[\w./-]+\.(?:sh|js|mjs|py|rb|ps1)\b/.test(command) && !/\$CLAUDE_PROJECT_DIR|\$\{CLAUDE_PROJECT_DIR\}/.test(command)) {
    out.push(make("SHIELD-HOOK-005", file, line, "The hook executes a script stored outside this repository."));
  }
  if (/(?:>>?|\btee\b(?:\s+-a)?|\bsed\s+-i\b[^|;&]*)\s*["']?[^\s|;&]*(?:CLAUDE\.md|AGENTS\.md|GEMINI\.md|\.cursorrules|copilot-instructions\.md|\.claude\/settings[\w.]*\.json|\.mcp\.json)/.test(command)) {
    out.push(make("SHIELD-HOOK-006", file, line, "The hook writes into agent instructions or settings."));
  }
  if (/\b(?:cat|less|head|tail|cp|base64|xxd|grep)\b[^|;&]*(?:\.env\b|~\/\.ssh|\$HOME\/\.ssh|\.aws\/credentials|id_(?:rsa|ed25519)|\.netrc|security\s+find-generic-password)/.test(command)) {
    out.push(make("SHIELD-HOOK-007", file, line, "The hook reads credential material."));
  }
  const npx = /\b(?:npx|bunx|pnpx)\s+(?:-y\s+|--yes\s+)?((?:@[\w.-]+\/)?[\w.-]+(?:@[\w.^~<>=-]+)?)/.exec(command);
  if (npx && npx[1] && !/@(?:\d|[~^]\d)/.test(npx[1].replace(/^@/, "")) && !/^forge(?:-engineering-workbench)?$/.test(npx[1])) {
    out.push(make("SHIELD-HOOK-008", file, line, `The hook runs \`${npx[1]}\` without a pinned version.`));
  }
  return out;
}

/** Codex `.codex/config.toml`, Gemini, VS Code and Zed settings. */
export function scanOtherSettings(file: string, content: string, make: MakeFinding): Array<ReturnType<MakeFinding>> {
  const out: Array<ReturnType<MakeFinding>> = [];
  if (file.endsWith(".codex/config.toml")) {
    const sandbox = /^\s*sandbox_mode\s*=\s*["']danger-full-access["']/m.exec(content);
    const never = /^\s*approval_policy\s*=\s*["']never["']/m.exec(content);
    if (sandbox && never) out.push(make("SHIELD-PERM-009", file, lineAt(content, sandbox.index), "`sandbox_mode = \"danger-full-access\"` with `approval_policy = \"never\"`."));
    else if (sandbox) out.push(make("SHIELD-PERM-009", file, lineAt(content, sandbox.index), "`sandbox_mode = \"danger-full-access\"` disables Codex's sandbox."));
    return out;
  }
  let json: Record<string, unknown> | undefined;
  try { json = asRecord(JSON.parse(content.replace(/^\s*\/\/.*$/gm, ""))); } catch { return out; }
  if (!json) return out;
  if (file.endsWith(".gemini/settings.json")) {
    const tools = asRecord(json.tools);
    if (json.autoAccept === true || tools?.autoAccept === true || json.yolo === true || json.approvalMode === "yolo") out.push(make("SHIELD-PERM-010", file, lineOfText(content, /autoAccept|yolo/), "Gemini CLI tool calls are auto-accepted."));
  }
  if (file.endsWith(".vscode/settings.json")) {
    for (const key of ["chat.tools.autoApprove", "chat.tools.global.autoApprove", "chat.agent.autoApprove"]) {
      if (json[key] === true) out.push(make("SHIELD-PERM-011", file, lineOfText(content, key), `\`${key}\` is true.`));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

export function mcpServers(json: unknown): Record<string, Record<string, unknown>> {
  const root = asRecord(json);
  const servers = asRecord(root?.mcpServers) ?? asRecord(root?.servers) ?? asRecord(root?.mcp) ?? asRecord(root?.context_servers);
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(servers ?? {})) {
    const server = asRecord(value);
    if (!server) continue;
    // Zed nests the command: { "command": { "path": "...", "args": [...] } }
    const nested = asRecord(server.command);
    out[name] = nested ? { ...server, command: nested.path ?? nested.command, args: nested.args, env: nested.env ?? server.env } : server;
  }
  return out;
}

function serverSignature(server: Record<string, unknown>): string {
  const command = typeof server.command === "string" ? server.command : Array.isArray(server.command) ? server.command.join(" ") : "";
  return JSON.stringify([server.url ?? server.serverUrl ?? server.httpUrl ?? "", command, strings(server.args)]);
}

export function scanMcpExtended(file: string, content: string, json: unknown, make: MakeFinding): Array<ReturnType<MakeFinding>> {
  const out: Array<ReturnType<MakeFinding>> = [];
  const servers = mcpServers(json);
  const names = Object.keys(servers);
  if (names.length > 10) out.push(make("SHIELD-MCP-010", file, 1, `${names.length} MCP servers are configured in this file.`));
  for (const [name, server] of Object.entries(servers)) {
    const line = lineOfText(content, `"${name}"`);
    const url = [server.url, server.serverUrl, server.httpUrl].find((v): v is string => typeof v === "string");
    const command = typeof server.command === "string" ? server.command : Array.isArray(server.command) ? strings(server.command).join(" ") : "";
    const args = strings(server.args);
    const all = [command, ...args].join(" ");
    if (url && /[?&](?:token|api[_-]?key|key|access_token|secret|auth)=[^&\s${]{8,}/i.test(url)) out.push(make("SHIELD-MCP-006", file, line, `Server \`${name}\` carries a credential in its URL. The value is not shown.`));
    if (url && /\.(?:ngrok(?:-free)?\.(?:io|app|dev)|trycloudflare\.com|loca\.lt|localtunnel\.me|serveo\.net)\b|pastebin\.com|gist\.githubusercontent\.com/i.test(url)) out.push(make("SHIELD-MCP-011", file, line, `Server \`${name}\` points at a tunnel or paste host.`));
    if (/\bdocker\b/.test(command) || args[0] === "run") {
      if (args.some(a => a === "--privileged" || a === "--network=host" || a === "--net=host" || a === "--pid=host") || /-v\s+(?:\/|~|\$HOME|\/var\/run\/docker\.sock)(?::|\s)/.test(all) || args.some(a => /^(?:\/|~|\$HOME|\/var\/run\/docker\.sock):/.test(a))) {
        out.push(make("SHIELD-MCP-005", file, line, `Server \`${name}\` runs a container with host-level access.`));
      }
    }
    if (/(?:^|\s)(?:github:|git\+(?:https?|ssh):\/\/|https?:\/\/[^\s]+\.(?:tgz|tar\.gz)\b)/.test(all) && !/#[0-9a-f]{40}\b/.test(all)) out.push(make("SHIELD-MCP-007", file, line, `Server \`${name}\` installs from an unpinned git or tarball source.`));
    if (/^(?:sudo|doas)$/.test(path.basename(command.split(/\s+/)[0] ?? "")) || /^\s*sudo\s/.test(command)) out.push(make("SHIELD-MCP-008", file, line, `Server \`${name}\` is started with sudo.`));
    if (/\.aws\/credentials|\.kube\/config|kubeconfig|service[-_]?account[\w.-]*\.json|application_default_credentials\.json|\.config\/gcloud/i.test(all + JSON.stringify(server.env ?? {}))) out.push(make("SHIELD-SEC-008", file, line, `Server \`${name}\` is given a cloud credential file.`));
  }
  return out;
}

/** Cross-file: the same server name configured differently in two MCP files. */
export function scanMcpShadowing(configs: Array<{ file: string; content: string; json: unknown }>, make: MakeFinding): Array<ReturnType<MakeFinding>> {
  const out: Array<ReturnType<MakeFinding>> = [];
  const seen = new Map<string, { file: string; signature: string }>();
  for (const { file, content, json } of configs) {
    for (const [name, server] of Object.entries(mcpServers(json))) {
      const signature = serverSignature(server);
      const first = seen.get(name);
      if (!first) seen.set(name, { file, signature });
      else if (first.signature !== signature) out.push(make("SHIELD-MCP-009", file, lineOfText(content, `"${name}"`), `Server \`${name}\` is also defined in ${first.file} with a different command or URL.`));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CI
// ---------------------------------------------------------------------------

const AGENT_ACTION = /uses:\s*["']?(?:anthropics\/claude-code-action|anthropics\/claude-code-base-action|openai\/codex-action|google-github-actions\/run-gemini-cli|google-gemini\/gemini-cli-action|github\/copilot[\w-]*|cursor\/[\w-]+-action|sst\/opencode[\w/-]*)@/i;
const UNTRUSTED_TRIGGER = /^\s*(?:issue_comment|issues|pull_request_target|pull_request_review_comment|pull_request_review|discussion_comment|discussion)\s*:?/m;

export function scanWorkflowExtended(file: string, content: string, make: MakeFinding): Array<ReturnType<MakeFinding>> {
  const out: Array<ReturnType<MakeFinding>> = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    const uses = /^\s*-?\s*uses:\s*["']?([\w.-]+\/[\w./-]+)@([\w.-]+)/.exec(line);
    if (uses && uses[1] && uses[2] && !/^(?:actions|github)\//.test(uses[1]) && !/^[0-9a-f]{40}$/.test(uses[2])) out.push(make("SHIELD-CI-004", file, index + 1, `\`${uses[1]}@${uses[2]}\` is referenced by a movable tag.`));
    if (/\b(?:echo|printf)\b[^#\n]*\$\{\{\s*secrets\.(?!GITHUB_TOKEN\b)\w+\s*\}\}|\bcurl\b[^#\n]*\$\{\{\s*secrets\.\w+\s*\}\}/.test(line)) out.push(make("SHIELD-CI-005", file, index + 1, "A secret is expanded into an echo or curl command line."));
    if (REMOTE_EXEC.test(line) && /^\s*(?:-\s*)?(?:run:|[^:]*$)/.test(line)) out.push(make("SHIELD-CI-010", file, index + 1, "A step pipes downloaded content into a shell."));
    if (/--dangerously-skip-permissions|--dangerously-bypass-approvals|allowed_tools:\s*["']?[^"'\n]*\bBash\b(?!\()|--yolo\b/.test(line)) out.push(make("SHIELD-CI-007", file, index + 1, "The agent step disables its permission checks or allows any shell command."));
  });
  const agent = AGENT_ACTION.exec(content);
  if (agent && UNTRUSTED_TRIGGER.test(content) && !/author_association|github\.actor\s*==|contains\(\s*fromJSON\([^)]*\)\s*,\s*github\.actor|github\.event\.sender\.login\s*==|github\.triggering_actor\s*==|labels\.\*\.name|github\.event\.label\.name/.test(content)) {
    out.push(make("SHIELD-CI-006", file, lineAt(content, agent.index), "An AI agent action runs on issue/comment/PR-target events without checking who triggered it."));
  }
  if (/^\s*runs-on:\s*\[?\s*["']?self-hosted/m.test(content) && /^\s*pull_request(?:_target)?\s*:?/m.test(content)) out.push(make("SHIELD-CI-008", file, lineOfText(content, /runs-on:\s*\[?\s*["']?self-hosted/), "Pull request code runs on a self-hosted runner."));
  const reusableOnly = /^\s*workflow_call\s*:/m.test(content) && !/^\s*(?:push|pull_request|pull_request_target|issues|issue_comment|schedule|workflow_dispatch|release)\s*:/m.test(content);
  if (!reusableOnly && !/^permissions\s*:/m.test(content) && !/^\s{2,4}permissions\s*:/m.test(content)) out.push(make("SHIELD-CI-009", file, 1, "No `permissions:` block; GITHUB_TOKEN uses the repository default."));
  return out;
}

// ---------------------------------------------------------------------------
// Repository-level checks
// ---------------------------------------------------------------------------

function globToRegExp(glob: string): RegExp {
  const anchored = glob.startsWith("/") || glob.replace(/\/$/, "").includes("/");
  const body = glob.replace(/^\//, "").replace(/\/$/, "").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, "(?:.*/)?");
  return new RegExp(anchored ? `^${body}(?:/.*)?$` : `(?:^|/)${body}(?:/.*)?$`);
}

/** Minimal .gitignore matcher (patterns, negation, anchoring) — enough for well-known files. */
export function isGitIgnored(gitignore: string, relative: string): boolean {
  let ignored = false;
  for (const raw of gitignore.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    const pattern = negate ? line.slice(1) : line;
    try { if (globToRegExp(pattern).test(relative)) ignored = !negate; } catch { /* ignore bad pattern */ }
  }
  return ignored;
}

async function exists(file: string): Promise<boolean> {
  try { return (await lstat(file)).isFile(); } catch { return false; }
}

export async function scanRepositoryExtended(root: string, make: MakeFinding): Promise<Array<ReturnType<MakeFinding>>> {
  const out: Array<ReturnType<MakeFinding>> = [];
  let gitignore = "";
  try { gitignore = await readFile(path.join(root, ".gitignore"), "utf8"); } catch { /* none */ }
  const isRepo = await lstat(path.join(root, ".git")).then(() => true, () => false);
  if (!isRepo) return out;
  for (const env of [".env", ".env.local", ".env.production"]) {
    if (await exists(path.join(root, env)) && !isGitIgnored(gitignore, env)) out.push(make("SHIELD-SEC-006", ".gitignore", 1, `\`${env}\` exists and is not ignored by git.`));
  }
  for (const local of [".claude/settings.local.json", "CLAUDE.local.md"]) {
    if (await exists(path.join(root, local)) && !isGitIgnored(gitignore, local)) out.push(make("SHIELD-SEC-007", ".gitignore", 1, `\`${local}\` exists and is not ignored by git.`));
  }
  return out;
}
