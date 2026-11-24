import { constants } from "node:fs";
import { EXTENDED_DIRECTORIES, EXTENDED_INSTRUCTION_FILES, EXTENDED_MCP_FILES, EXTENDED_RULES, EXTENDED_SETTINGS_FILES, mcpServers, scanClaudeSettingsExtended, scanHookCommandExtended, scanInstructionsExtended, scanMcpExtended, scanMcpShadowing, scanOtherSettings, scanRepositoryExtended, scanTextExtended, scanWorkflowExtended, type MakeFinding } from "./shield-extended.js";
import { lstat, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { auditAgentConfiguration } from "./agent-security-audit.js";

/**
 * FORGE Shield: static security review of AI-agent harness configuration.
 *
 * Covers instruction files, Claude Code settings and hooks, MCP server
 * definitions (Claude, Cursor, VS Code, Gemini), installed skills/agents and
 * GitHub workflows. Findings never include matched secret values.
 */

export type ShieldSeverity = "critical" | "high" | "medium" | "low";
export type ShieldCategory = "secrets" | "permissions" | "hooks" | "mcp" | "injection" | "instructions" | "ci";

export interface ShieldRule {
  id: string;
  severity: ShieldSeverity;
  category: ShieldCategory;
  title: string;
  recommendation: string;
  /** Whether `forge shield --fix` can remediate this finding automatically. */
  fixable?: boolean;
}

export interface ShieldFinding {
  ruleId: string;
  severity: ShieldSeverity;
  category: ShieldCategory;
  title: string;
  file: string;
  line: number;
  detail: string;
  recommendation: string;
  fixable: boolean;
}

export interface ShieldReport {
  schemaVersion: 1;
  tool: "forge-shield";
  generatedAt: string;
  filesScanned: number;
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  summary: Record<ShieldSeverity, number>;
  byCategory: Partial<Record<ShieldCategory, number>>;
  findings: ShieldFinding[];
  caveats: string[];
}

export const SHIELD_RULES: Record<string, ShieldRule> = Object.fromEntries(([
  { id: "SHIELD-SEC-001", severity: "critical", category: "secrets", title: "Credential embedded in agent configuration", recommendation: "Remove the value, rotate the credential with its provider, and reference it through an environment variable (e.g. ${API_KEY})." },
  { id: "SHIELD-SEC-002", severity: "critical", category: "secrets", title: "Private key material in agent configuration", recommendation: "Delete the key from the file, revoke it, and load keys from a secret manager or the OS keychain." },
  { id: "SHIELD-SEC-003", severity: "critical", category: "secrets", title: "Literal secret passed to an MCP server environment", recommendation: "Replace the literal with an environment reference such as \"${GITHUB_TOKEN}\" and rotate the exposed value." },
  { id: "SHIELD-PERM-001", severity: "critical", category: "permissions", title: "Agent permission checks are bypassed", recommendation: "Remove `bypassPermissions` / skip-permission settings; use an explicit allow-list with prompts for state-changing tools." },
  { id: "SHIELD-PERM-002", severity: "high", category: "permissions", title: "Unrestricted shell access is pre-approved", recommendation: "Replace blanket `Bash` / `Bash(*)` approval with specific commands such as `Bash(npm test)`." },
  { id: "SHIELD-PERM-003", severity: "high", category: "permissions", title: "All project MCP servers are auto-trusted", recommendation: "Set `enableAllProjectMcpServers` to false and approve servers individually with `enabledMcpjsonServers`." },
  { id: "SHIELD-PERM-004", severity: "medium", category: "permissions", title: "File edits are auto-accepted", recommendation: "Prefer the default permission mode so edits are reviewed, or restrict auto-accept to sandboxed environments." },
  { id: "SHIELD-PERM-005", severity: "medium", category: "permissions", title: "Wildcard tool approval", recommendation: "Approve tools individually; wildcard approval also covers tools added later by plugins or MCP servers." },
  { id: "SHIELD-PERM-006", severity: "low", category: "permissions", title: "Secret files are not denied to the agent", recommendation: "Add deny rules such as `Read(./.env)`, `Read(./.env.*)` and `Read(./secrets/**)` to `permissions.deny`.", fixable: true },
  { id: "SHIELD-HOOK-001", severity: "critical", category: "hooks", title: "Hook downloads and executes remote code", recommendation: "Vendor the script into the repository, pin it by hash, and review it; never pipe network content into a shell." },
  { id: "SHIELD-HOOK-002", severity: "high", category: "hooks", title: "Hook sends data to the network", recommendation: "Hooks run on every tool call with access to prompts and files; remove outbound requests or restrict them to a reviewed, documented endpoint." },
  { id: "SHIELD-HOOK-003", severity: "high", category: "hooks", title: "Hook runs destructive or obfuscated commands", recommendation: "Remove `rm -rf`, `eval`, base64-decoded execution and similar constructs from hooks; keep hooks small, readable and side-effect free." },
  { id: "SHIELD-HOOK-004", severity: "medium", category: "hooks", title: "Hook matches every tool", recommendation: "Narrow the matcher (e.g. `Edit|Write`) so the hook only runs where needed." },
  { id: "SHIELD-MCP-001", severity: "high", category: "mcp", title: "MCP server uses an unencrypted remote URL", recommendation: "Use https:// endpoints for remote MCP servers." },
  { id: "SHIELD-MCP-002", severity: "medium", category: "mcp", title: "MCP server package is not version-pinned", recommendation: "Pin the package (e.g. `npx -y @scope/server@1.2.3`) so a compromised release cannot run automatically." },
  { id: "SHIELD-MCP-003", severity: "high", category: "mcp", title: "MCP server has access to the whole filesystem", recommendation: "Scope filesystem servers to the project directory, never `/` or the home directory." },
  { id: "SHIELD-MCP-004", severity: "medium", category: "mcp", title: "MCP server is launched through a shell", recommendation: "Launch the server binary directly with an argument list instead of `sh -c` / `bash -c` strings." },
  { id: "SHIELD-INJ-001", severity: "high", category: "injection", title: "Invisible or bidirectional Unicode in agent instructions", recommendation: "Remove zero-width, bidi-override and tag characters; they can hide instructions from human reviewers.", fixable: true },
  { id: "SHIELD-INJ-002", severity: "high", category: "injection", title: "Instruction-override phrase in agent configuration", recommendation: "Remove text that tells the model to ignore prior instructions or conceal actions; it is a prompt-injection pattern." },
  { id: "SHIELD-INJ-003", severity: "medium", category: "injection", title: "Hidden HTML comment addresses the AI agent", recommendation: "Move agent guidance into visible text so reviewers see everything the model reads." },
  { id: "SHIELD-CI-001", severity: "high", category: "ci", title: "pull_request_target workflow checks out untrusted code", recommendation: "Do not check out the PR head in `pull_request_target`; use `pull_request` or split privileged steps into a separate workflow." },
  { id: "SHIELD-CI-002", severity: "medium", category: "ci", title: "Workflow grants write-all permissions", recommendation: "Declare least-privilege `permissions:` per job (e.g. `contents: read`)." },
  { id: "SHIELD-CI-003", severity: "medium", category: "ci", title: "Untrusted event text interpolated into a run step", recommendation: "Pass `${{ github.event.* }}` values through `env:` and quote them instead of interpolating into shell code." },
  ...EXTENDED_RULES,
] as ShieldRule[]).map(rule => [rule.id, rule]));

const LEGACY_RULE_MAP: Record<string, string> = {
  "FORGE-AGENT-001": "SHIELD-SEC-001",
  "FORGE-AGENT-002": "SHIELD-AGENT-002",
  "FORGE-AGENT-003": "SHIELD-AGENT-003",
  "FORGE-AGENT-004": "SHIELD-AGENT-004",
  "FORGE-AGENT-005": "SHIELD-AGENT-005",
  "FORGE-AGENT-006": "SHIELD-AGENT-006",
};

const MAX_FILES = 2000;
const MAX_ENTRIES = 30_000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_DEPTH = 6;

const INSTRUCTION_FILES = [...new Set(["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", "GEMINI.md", ".cursorrules", ".windsurfrules", ".github/copilot-instructions.md", ...EXTENDED_INSTRUCTION_FILES])];
const SETTINGS_FILES = [".claude/settings.json", ".claude/settings.local.json"];
const MCP_FILES = [".mcp.json", "mcp.json", ".cursor/mcp.json", ".vscode/mcp.json", ".gemini/settings.json", "opencode.json", ...EXTENDED_MCP_FILES];
const OTHER_SETTINGS_FILES = EXTENDED_SETTINGS_FILES;
const SCANNED_DIRECTORIES = [".claude/agents", ".claude/commands", ".claude/skills", ".claude/hooks", ".claude/rules", ".cursor/rules", ".cursor/commands", ".opencode", ".gemini/commands", ".agents/skills", ".forge/skills", ".forge/hooks", ".forge/harness", ".github/workflows", ...EXTENDED_DIRECTORIES];
const SCANNED_EXTENSIONS = new Set([".md", ".mdc", ".json", ".yaml", ".yml", ".toml", ".sh", ".js", ".mjs", ".cjs", ".ts", ".py"]);

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

async function readText(filePath: string): Promise<string> {
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error(`${filePath} is not a regular file or exceeds ${MAX_FILE_BYTES} bytes.`);
    const buffer = Buffer.alloc(info.size);
    await handle.read(buffer, 0, info.size, 0);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function addFile(root: string, relative: string, files: Set<string>): Promise<void> {
  const candidate = path.join(root, relative);
  try {
    const info = await lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) return;
    const actual = await realpath(candidate);
    if (isInside(root, actual)) files.add(actual);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function walk(root: string, directory: string, depth: number, files: Set<string>, visited: { count: number }): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) return;
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    visited.count += 1;
    if (visited.count > MAX_ENTRIES) throw new Error(`Shield scan exceeded ${MAX_ENTRIES} directory entries.`);
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(root, candidate, depth + 1, files, visited);
    else if (entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      await addFile(root, path.relative(root, candidate), files);
      if (files.size > MAX_FILES) throw new Error(`Shield scan exceeded ${MAX_FILES} files.`);
    }
  }
}

export async function discoverShieldFiles(projectPath: string): Promise<{ root: string; files: string[] }> {
  const root = await realpath(path.resolve(projectPath));
  const files = new Set<string>();
  for (const relative of [...INSTRUCTION_FILES, ...SETTINGS_FILES, ...MCP_FILES, ...OTHER_SETTINGS_FILES, ".forge/permissions.json", ".forge/policy.json"]) await addFile(root, relative, files);
  const visited = { count: 0 };
  for (const relative of SCANNED_DIRECTORIES) await walk(root, path.join(root, relative), 0, files, visited);
  return { root, files: [...files].sort() };
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
];
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY( BLOCK)?-----/;
// Zero-width, bidi controls/overrides/isolates, Unicode tag characters.
const INVISIBLE = /[​-‍⁠⁢-⁤‪-‮⁦-⁩﻿]|\uDB40[\uDC00-\uDC7F]/;
const INVISIBLE_GLOBAL = /[​-‍⁠⁢-⁤‪-‮⁦-⁩]|\uDB40[\uDC00-\uDC7F]|(?<!^)﻿/g;
const OVERRIDE_PHRASES = /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions|prompts|rules|messages)\b|\bdo\s+not\s+(?:tell|inform|reveal\s+to)\s+the\s+user\b|\bwithout\s+(?:telling|informing|notifying)\s+the\s+user\b/i;
const AGENT_COMMENT = /<!--(?:(?!-->)[\s\S]){0,400}?\b(?:AI|assistant|agent|LLM|Claude|model)\b(?:(?!-->)[\s\S]){0,400}?-->/i;

const DEFENSIVE_CONTEXT = /\b(?:not|never|don't|do\s+not|must\s+not|refuse|reject|such\s+as|e\.g\.|for\s+example|like|detect|flag|block|warn)\b[^.]{0,80}$/i;

/** True when a risky phrase is quoted or framed defensively ("do not follow…", "text such as '…'"). */
export function isDefensiveMention(line: string, matchIndex: number): boolean {
  const before = line.slice(0, matchIndex);
  const quotes = (before.match(/["“”'`]/g) ?? []).length;
  if (quotes % 2 === 1) return true;
  return DEFENSIVE_CONTEXT.test(before);
}

function lineOf(content: string, needle: string | RegExp, from = 0): number {
  const start = Math.max(0, from);
  const relative = typeof needle === "string" ? content.indexOf(needle, start) - start : content.slice(start).search(needle);
  if (relative < 0) return 1;
  const index = start + relative;
  return content.slice(0, index).split("\n").length;
}

function finding(ruleId: string, file: string, line: number, detail: string): ShieldFinding {
  const rule = SHIELD_RULES[ruleId];
  if (!rule) throw new Error(`Unknown shield rule ${ruleId}`);
  return { ruleId, severity: rule.severity, category: rule.category, title: rule.title, file, line, detail, recommendation: rule.recommendation, fixable: Boolean(rule.fixable) };
}

function scanSecrets(file: string, content: string): ShieldFinding[] {
  const findings: ShieldFinding[] = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (PRIVATE_KEY.test(line)) findings.push(finding("SHIELD-SEC-002", file, index + 1, "A private key header is present. The value is not shown."));
    else if (SECRET_PATTERNS.some(pattern => pattern.test(line))) findings.push(finding("SHIELD-SEC-001", file, index + 1, "A token matching a known credential format is present. The value is not shown."));
  });
  return findings;
}

function scanInjection(file: string, content: string): ShieldFinding[] {
  const findings: ShieldFinding[] = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    const body = index === 0 ? line.replace(/^﻿/, "") : line;
    if (INVISIBLE.test(body)) findings.push(finding("SHIELD-INJ-001", file, index + 1, "Invisible or direction-changing Unicode characters were found on this line."));
    const override = line.match(OVERRIDE_PHRASES);
    if (override && !isDefensiveMention(line, override.index ?? 0)) findings.push(finding("SHIELD-INJ-002", file, index + 1, "Text instructs the model to ignore earlier instructions or hide actions from the user."));
  });
  if (/\.(md|mdc)$/i.test(file)) {
    const pattern = new RegExp(AGENT_COMMENT.source, "gi");
    for (const match of content.matchAll(pattern)) {
      if (match[0].includes("forge:begin") || match[0].includes("Generated by FORGE")) continue;
      findings.push(finding("SHIELD-INJ-003", file, lineOf(content, match[0]), "An HTML comment (invisible when rendered) contains text addressed to an AI agent."));
    }
  }
  return findings;
}

function scanHookCommand(file: string, content: string, command: string, matcher: string | undefined): ShieldFinding[] {
  const findings: ShieldFinding[] = [];
  const line = lineOf(content, command.slice(0, 60));
  if (/\b(?:curl|wget|iwr|Invoke-WebRequest)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\b(?:bash|sh)\s+<\(\s*(?:curl|wget)|\bnpx\s+(?:-y\s+)?https?:\/\//i.test(command)) {
    findings.push(finding("SHIELD-HOOK-001", file, line, "The hook pipes downloaded content into an interpreter."));
  } else if (/\b(?:curl|wget|nc|ncat|netcat|Invoke-WebRequest|iwr)\b|\bfetch\(|https?:\/\//i.test(command)) {
    findings.push(finding("SHIELD-HOOK-002", file, line, "The hook command contacts a network endpoint."));
  }
  if (/\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r|\beval\b|base64\s+(?:-d|--decode)[^|]*\|\s*(?:ba)?sh|\bchmod\s+777\b|\bgit\s+push\s+(?:-f|--force)\b/i.test(command)) {
    findings.push(finding("SHIELD-HOOK-003", file, line, "The hook command contains destructive or obfuscated shell constructs."));
  }
  if (matcher !== undefined && (matcher === "*" || matcher === ".*" || matcher === "")) {
    findings.push(finding("SHIELD-HOOK-004", file, line, "The hook runs for every tool invocation."));
  }
  return findings;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function scanClaudeSettings(file: string, content: string, json: unknown): ShieldFinding[] {
  const findings: ShieldFinding[] = [];
  const settings = asRecord(json);
  if (!settings) return findings;
  const permissions = asRecord(settings.permissions);
  const mode = permissions?.defaultMode ?? settings.defaultMode;
  if (mode === "bypassPermissions") findings.push(finding("SHIELD-PERM-001", file, lineOf(content, "bypassPermissions"), "`defaultMode` is `bypassPermissions`: every tool call runs without approval."));
  if (settings.dangerouslySkipPermissions === true || settings.skipDangerousModePermissionPrompt === true) findings.push(finding("SHIELD-PERM-001", file, lineOf(content, /dangerouslySkipPermissions|skipDangerousModePermissionPrompt/), "Permission prompts are disabled."));
  if (mode === "acceptEdits") findings.push(finding("SHIELD-PERM-004", file, lineOf(content, "acceptEdits"), "`defaultMode` is `acceptEdits`."));
  const allow = Array.isArray(permissions?.allow) ? permissions.allow.filter((v): v is string => typeof v === "string") : [];
  for (const rule of allow) {
    const normalized = rule.replace(/\s+/g, "");
    if (["Bash", "Bash(*)", "Bash(:*)", "Bash(**)", "PowerShell", "PowerShell(*)"].includes(normalized)) findings.push(finding("SHIELD-PERM-002", file, lineOf(content, `"${rule}"`), `\`${rule}\` pre-approves any shell command.`));
    else if (normalized === "*" || normalized === "mcp__*" || normalized === "mcp__*__*") findings.push(finding("SHIELD-PERM-005", file, lineOf(content, `"${rule}"`), `\`${rule}\` approves a wildcard set of tools.`));
  }
  findings.push(...scanClaudeSettingsExtended(file, content, settings, finding as MakeFinding) as ShieldFinding[]);
  if (settings.enableAllProjectMcpServers === true) findings.push(finding("SHIELD-PERM-003", file, lineOf(content, "enableAllProjectMcpServers"), "Any MCP server added to `.mcp.json` starts without review."));
  const deny = Array.isArray(permissions?.deny) ? permissions.deny.filter((v): v is string => typeof v === "string") : [];
  if (file.endsWith("settings.json") && !deny.some(rule => /\.env/.test(rule))) findings.push(finding("SHIELD-PERM-006", file, 1, "No deny rule protects `.env` files from being read by the agent."));

  const env = asRecord(settings.env);
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value === "string" && (SECRET_PATTERNS.some(pattern => pattern.test(value)) || (/(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)$/i.test(key) && value.length >= 16 && !/^\$\{?[A-Z_][A-Z0-9_]*\}?$/.test(value)))) {
      findings.push(finding("SHIELD-SEC-001", file, lineOf(content, `"${key}"`), `\`env.${key}\` holds a literal secret. The value is not shown.`));
    }
  }

  const hooks = asRecord(settings.hooks);
  for (const groups of Object.values(hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const record = asRecord(group);
      const matcher = typeof record?.matcher === "string" ? record.matcher : undefined;
      const commands = Array.isArray(record?.hooks) ? record.hooks : [];
      for (const hook of commands) {
        const command = asRecord(hook)?.command;
        if (typeof command === "string") findings.push(...scanHookCommand(file, content, command, matcher), ...scanHookCommandExtended(file, content, command, finding as MakeFinding) as ShieldFinding[]);
      }
    }
  }
  return findings;
}

function scanMcpConfig(file: string, content: string, json: unknown): ShieldFinding[] {
  const findings: ShieldFinding[] = [];
  const servers = mcpServers(json);
  for (const [name, value] of Object.entries(servers)) {
    const server = asRecord(value);
    if (!server) continue;
    const line = lineOf(content, `"${name}"`);
    const url = typeof server.url === "string" ? server.url : typeof server.serverUrl === "string" ? server.serverUrl : typeof server.httpUrl === "string" ? server.httpUrl : undefined;
    if (url && /^http:\/\//i.test(url) && !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(url)) findings.push(finding("SHIELD-MCP-001", file, line, `Server \`${name}\` connects over plain HTTP.`));
    const commandValue = server.command;
    const command = typeof commandValue === "string" ? commandValue : Array.isArray(commandValue) ? commandValue.filter((v): v is string => typeof v === "string").join(" ") : "";
    const args = Array.isArray(server.args) ? server.args.filter((v): v is string => typeof v === "string") : Array.isArray(commandValue) ? commandValue.slice(1).filter((v): v is string => typeof v === "string") : [];
    const commandName = path.basename(command.split(/\s+/)[0] ?? "");
    if (["sh", "bash", "zsh", "cmd", "cmd.exe", "powershell", "pwsh"].includes(commandName) && args.some(arg => arg === "-c" || arg === "/c" || arg === "-Command")) findings.push(finding("SHIELD-MCP-004", file, line, `Server \`${name}\` is started through a shell string.`));
    if (["npx", "bunx", "pnpx", "uvx", "pipx"].includes(commandName) || /\b(?:npm|pnpm)\s+(?:exec|dlx)\b/.test(command)) {
      const pkg = args.find(arg => !arg.startsWith("-") && arg !== "run" && arg !== "exec");
      if (pkg && !/^\.{0,2}\//.test(pkg)) {
        const versioned = pkg.startsWith("@") ? pkg.slice(1).includes("@") : pkg.includes("@") || pkg.includes("==");
        if (!versioned || /@latest$/.test(pkg)) findings.push(finding("SHIELD-MCP-002", file, line, `Server \`${name}\` runs \`${pkg}\` without a pinned version.`));
      }
    }
    if (args.some(arg => /server-filesystem|filesystem/.test(arg)) && args.some(arg => arg === "/" || arg === "~" || arg === "$HOME" || arg === "${HOME}" || /^\/(?:Users|home)\/[^/]+\/?$/.test(arg) || /^[A-Za-z]:\\?$/.test(arg))) {
      findings.push(finding("SHIELD-MCP-003", file, line, `Server \`${name}\` is rooted at a system or home directory.`));
    }
    const env = asRecord(server.env) ?? asRecord(server.environment);
    for (const [key, raw] of Object.entries(env ?? {})) {
      if (typeof raw !== "string") continue;
      const reference = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$|^\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$|^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(raw);
      if (!reference && (SECRET_PATTERNS.some(pattern => pattern.test(raw)) || (/(TOKEN|SECRET|PASSWORD|KEY)$/i.test(key) && raw.length >= 16))) {
        findings.push(finding("SHIELD-SEC-003", file, lineOf(content, `"${key}"`, content.indexOf(`"${name}"`)), `Server \`${name}\` receives a literal value for \`${key}\`. The value is not shown.`));
      }
    }
    const headers = asRecord(server.headers);
    for (const [key, raw] of Object.entries(headers ?? {})) {
      if (typeof raw === "string" && /authorization|token|key/i.test(key) && !/\$\{?[A-Za-z_]/.test(raw) && raw.length >= 16) {
        findings.push(finding("SHIELD-SEC-003", file, lineOf(content, `"${key}"`, content.indexOf(`"${name}"`)), `Server \`${name}\` sends a literal \`${key}\` header. The value is not shown.`));
      }
    }
  }
  return findings;
}

function scanWorkflow(file: string, content: string): ShieldFinding[] {
  const findings: ShieldFinding[] = [];
  if (/^\s*pull_request_target\s*:?/m.test(content) && /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.(?:sha|ref)\s*\}\}|github\.head_ref/.test(content)) {
    findings.push(finding("SHIELD-CI-001", file, lineOf(content, /github\.event\.pull_request\.head|github\.head_ref/), "The workflow has write-capable context and checks out pull request code."));
  }
  const writeAll = content.search(/^\s*permissions\s*:\s*write-all\s*$/m);
  if (writeAll >= 0) findings.push(finding("SHIELD-CI-002", file, content.slice(0, writeAll).split("\n").length + 1, "`permissions: write-all` grants every scope to GITHUB_TOKEN."));
  const lines = content.split(/\r?\n/);
  let inRun = false;
  let runIndent = 0;
  lines.forEach((line, index) => {
    const runStart = line.match(/^(\s*)(?:-\s+)?run\s*:\s*(.*)$/);
    if (runStart) { inRun = true; runIndent = (runStart[1] ?? "").length; }
    else if (inRun && line.trim() && line.search(/\S/) <= runIndent) inRun = false;
    if ((runStart || inRun) && /\$\{\{\s*github\.event\.(?:issue\.(?:title|body)|comment\.body|pull_request\.(?:title|body|head\.ref)|review\.body|head_commit\.message|discussion\.(?:title|body))/.test(line)) {
      findings.push(finding("SHIELD-CI-003", file, index + 1, "Attacker-controlled event text is expanded directly inside a shell script."));
    }
  });
  return findings;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<ShieldSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_WEIGHT: Record<ShieldSeverity, number> = { critical: 25, high: 10, medium: 4, low: 1 };

export function scoreFindings(findings: ShieldFinding[]): { score: number; grade: ShieldReport["grade"] } {
  const penalty = findings.reduce((sum, item) => sum + SEVERITY_WEIGHT[item.severity], 0);
  const score = Math.max(0, 100 - penalty);
  const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
  return { score, grade };
}

export async function runShield(projectPath: string, options: { now?: () => Date } = {}): Promise<ShieldReport> {
  const { root, files } = await discoverShieldFiles(projectPath);
  const findings: ShieldFinding[] = [];
  const contents = new Map<string, string>();
  const mcpConfigs: Array<{ file: string; content: string; json: unknown }> = [];
  for (const absolute of files) {
    const file = path.relative(root, absolute).split(path.sep).join("/");
    const content = await readText(absolute);
    contents.set(file, content);
    const make = finding as MakeFinding;
    findings.push(...scanSecrets(file, content), ...scanTextExtended(file, content, make) as ShieldFinding[]);
    const isWorkflow = file.startsWith(".github/workflows/");
    if (!isWorkflow) findings.push(...scanInjection(file, content), ...scanInstructionsExtended(file, content, make, { generated: content.includes("Generated by FORGE") }) as ShieldFinding[]);
    if (isWorkflow && /\.ya?ml$/.test(file)) findings.push(...scanWorkflow(file, content), ...scanWorkflowExtended(file, content, make) as ShieldFinding[]);
    if (/^(?:\.claude|\.forge)\/hooks\/.+\.(?:sh|js|mjs|cjs|ts|py)$/.test(file)) findings.push(...scanHookCommand(file, content, content, undefined), ...scanHookCommandExtended(file, content, content, make) as ShieldFinding[]);
    if (OTHER_SETTINGS_FILES.includes(file)) findings.push(...scanOtherSettings(file, content, make) as ShieldFinding[]);
    if (file.endsWith(".json")) {
      let json: unknown;
      try { json = JSON.parse(content); } catch { json = undefined; }
      if (json !== undefined) {
        if (SETTINGS_FILES.includes(file)) findings.push(...scanClaudeSettings(file, content, json));
        if (MCP_FILES.includes(file)) {
          findings.push(...scanMcpConfig(file, content, json), ...scanMcpExtended(file, content, json, finding as MakeFinding) as ShieldFinding[]);
          mcpConfigs.push({ file, content, json });
        }
      }
    }
  }

  findings.push(...scanMcpShadowing(mcpConfigs, finding as MakeFinding) as ShieldFinding[], ...await scanRepositoryExtended(root, finding as MakeFinding) as ShieldFinding[]);

  // Reuse the established FORGE instruction rules (broad permissions, review bypass, untrusted content).
  let legacyFindings: Awaited<ReturnType<typeof auditAgentConfiguration>>["findings"] = [];
  const extraCaveats: string[] = [];
  try {
    legacyFindings = (await auditAgentConfiguration(root)).findings;
  } catch (error) {
    extraCaveats.push(`Instruction wording rules were skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const item of legacyFindings) {
    const mapped = LEGACY_RULE_MAP[item.id] ?? item.id;
    if (mapped === "SHIELD-SEC-001" && findings.some(f => f.file === item.file && f.line === item.line && f.category === "secrets")) continue;
    if (mapped !== "SHIELD-SEC-001") {
      const text = (contents.get(item.file) ?? "").split(/\r?\n/)[item.line - 1] ?? "";
      const firstVerb = text.search(/\b(?:follow|obey|execute|run|trust|treat|allow|invoke|without|skip|bypass|unrestricted|unlimited|full|any|all)\b/i);
      if (firstVerb >= 0 && isDefensiveMention(text, firstVerb)) continue;
    }
    findings.push({ ruleId: mapped, severity: item.severity, category: mapped.startsWith("SHIELD-SEC") ? "secrets" : "instructions", title: item.title, file: item.file, line: item.line, detail: item.detail, recommendation: item.recommendation, fixable: false });
  }

  const unique = new Map<string, ShieldFinding>();
  for (const item of findings) unique.set(`${item.ruleId}|${item.file}|${item.line}`, item);
  const sorted = [...unique.values()].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.file.localeCompare(b.file) || a.line - b.line || a.ruleId.localeCompare(b.ruleId));
  const summary: Record<ShieldSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  const byCategory: Partial<Record<ShieldCategory, number>> = {};
  for (const item of sorted) {
    summary[item.severity] += 1;
    byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
  }
  return {
    schemaVersion: 1,
    tool: "forge-shield",
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    filesScanned: files.length,
    ...scoreFindings(sorted),
    summary,
    byCategory,
    findings: sorted,
    caveats: [
      "Static analysis of known harness configuration locations; it does not prove an agent setup is safe.",
      "Secret values and matched lines are never included in reports.",
      "Runtime behavior of hooks, MCP servers and remote endpoints is not executed or observed.",
      ...extraCaveats,
    ],
  };
}

export function severityAtLeast(severity: ShieldSeverity, threshold: ShieldSeverity): boolean {
  return SEVERITY_RANK[severity] <= SEVERITY_RANK[threshold];
}

export function parseSeverity(value: string | undefined): ShieldSeverity {
  const normalized = (value ?? "").toLowerCase();
  if (!(normalized in SEVERITY_RANK)) throw new Error("Severity must be critical, high, medium or low.");
  return normalized as ShieldSeverity;
}

export function formatShieldReport(report: ShieldReport): string {
  const lines = [
    "FORGE Shield — agent harness security review",
    `Score ${report.score}/100 · Grade ${report.grade} · ${report.filesScanned} files scanned`,
    `Findings: ${report.summary.critical} critical · ${report.summary.high} high · ${report.summary.medium} medium · ${report.summary.low} low`,
    "",
  ];
  if (!report.findings.length) lines.push(report.filesScanned ? "No findings matched the Shield rules." : "No agent harness configuration files were found.");
  for (const item of report.findings) {
    lines.push(`[${item.severity.toUpperCase()}] ${item.ruleId} · ${item.title}${item.fixable ? "  (auto-fixable)" : ""}`);
    lines.push(`  ${item.file}:${item.line}  ${item.detail}`);
    lines.push(`  → ${item.recommendation}`);
  }
  if (report.findings.some(item => item.fixable)) lines.push("", "Run `forge shield --fix` to apply safe automatic fixes.");
  lines.push("", ...report.caveats.map(item => `  · ${item}`));
  return lines.join("\n");
}

export function formatShieldMarkdown(report: ShieldReport): string {
  const lines = [
    `## 🛡️ FORGE Shield — score ${report.score}/100 (grade ${report.grade})`,
    "",
    `| Critical | High | Medium | Low | Files |`,
    `|---:|---:|---:|---:|---:|`,
    `| ${report.summary.critical} | ${report.summary.high} | ${report.summary.medium} | ${report.summary.low} | ${report.filesScanned} |`,
    "",
  ];
  if (!report.findings.length) lines.push("No findings matched the Shield rules.");
  else {
    lines.push("| Severity | Rule | Location | Finding |", "|---|---|---|---|");
    for (const item of report.findings.slice(0, 100)) lines.push(`| ${item.severity} | \`${item.ruleId}\` | \`${item.file}:${item.line}\` | ${item.title}. ${item.recommendation.replace(/\|/g, "\\|")} |`);
    if (report.findings.length > 100) lines.push("", `…and ${report.findings.length - 100} more.`);
  }
  return lines.join("\n");
}

export function toSarif(report: ShieldReport, version: string): Record<string, unknown> {
  const usedRules = [...new Set(report.findings.map(item => item.ruleId))].sort();
  const ruleFor = (id: string) => SHIELD_RULES[id] ?? report.findings.find(item => item.ruleId === id);
  const level = (severity: ShieldSeverity) => (severity === "critical" || severity === "high" ? "error" : severity === "medium" ? "warning" : "note");
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: {
        driver: {
          name: "FORGE Shield",
          version,
          informationUri: "https://github.com/ansh44233/FORGE-ECC",
          rules: usedRules.map(id => {
            const rule = ruleFor(id);
            const severity = rule && "severity" in rule ? rule.severity : "medium";
            return {
              id,
              name: id.replace(/[^A-Za-z0-9]/g, ""),
              shortDescription: { text: rule?.title ?? id },
              help: { text: rule?.recommendation ?? "" },
              defaultConfiguration: { level: level(severity) },
              properties: { "security-severity": String({ critical: 9.5, high: 7.5, medium: 5.0, low: 2.0 }[severity]), tags: ["security", "ai-agent"] },
            };
          }),
        },
      },
      results: report.findings.map(item => ({
        ruleId: item.ruleId,
        level: level(item.severity),
        message: { text: `${item.title}. ${item.detail}` },
        locations: [{ physicalLocation: { artifactLocation: { uri: item.file }, region: { startLine: Math.max(1, item.line) } } }],
      })),
    }],
  };
}

// ---------------------------------------------------------------------------
// Safe automatic fixes
// ---------------------------------------------------------------------------

export interface ShieldFixResult { file: string; ruleId: string; description: string }

const SECRET_DENY_RULES = ["Read(./.env)", "Read(./.env.*)", "Read(./secrets/**)", "Read(./**/*.pem)", "Read(./**/*.key)"];

async function atomicWrite(file: string, content: string): Promise<void> {
  const temporary = `${file}.forge-${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  try { await rename(temporary, file); } catch (error) { await rm(temporary, { force: true }); throw error; }
}

export async function applyShieldFixes(projectPath: string, report: ShieldReport, options: { dryRun?: boolean } = {}): Promise<ShieldFixResult[]> {
  const root = await realpath(path.resolve(projectPath));
  const results: ShieldFixResult[] = [];
  const targets = new Map<string, Set<string>>();
  for (const item of report.findings.filter(f => f.fixable)) {
    const set = targets.get(item.file) ?? new Set<string>();
    set.add(item.ruleId);
    targets.set(item.file, set);
  }
  for (const [relative, rules] of targets) {
    const absolute = path.join(root, ...relative.split("/"));
    const actual = await realpath(absolute);
    if (!isInside(root, actual)) continue;
    let content = await readText(actual);
    const original = content;
    if (rules.has("SHIELD-INJ-001")) {
      const count = content.match(INVISIBLE_GLOBAL)?.length ?? 0;
      content = content.replace(INVISIBLE_GLOBAL, "");
      if (count) results.push({ file: relative, ruleId: "SHIELD-INJ-001", description: `Removed ${count} invisible/bidi character(s).` });
    }
    if (rules.has("SHIELD-PERM-006")) {
      const settings = asRecord(JSON.parse(content));
      if (settings) {
        const permissions = asRecord(settings.permissions) ?? {};
        const deny = Array.isArray(permissions.deny) ? permissions.deny.filter((v): v is string => typeof v === "string") : [];
        const added = SECRET_DENY_RULES.filter(rule => !deny.includes(rule));
        if (added.length) {
          settings.permissions = { ...permissions, deny: [...deny, ...added] };
          const indent = content.match(/^\{\s*\n(\s+)"/)?.[1] ?? "  ";
          content = `${JSON.stringify(settings, null, indent)}\n`;
          results.push({ file: relative, ruleId: "SHIELD-PERM-006", description: `Added deny rules: ${added.join(", ")}.` });
        }
      }
    }
    if (content !== original && !options.dryRun) await atomicWrite(actual, content);
  }
  return results;
}
