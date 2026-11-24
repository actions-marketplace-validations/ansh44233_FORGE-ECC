import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

/**
 * One MCP configuration for every harness.
 *
 * Each agent tool keeps MCP servers in its own file and format, and each one
 * writes environment references differently. FORGE keeps a neutral definition,
 * pins packages, refuses to spread literal secrets, and writes each harness's
 * native format. `.forge/mcp-state.json` records what FORGE wrote, so `remove`
 * only touches FORGE's own entries.
 */

export type McpTarget = "claude" | "cursor" | "codex" | "gemini" | "copilot" | "opencode" | "kiro";
export const MCP_TARGETS: readonly McpTarget[] = ["claude", "cursor", "codex", "gemini", "copilot", "opencode", "kiro"];

export const MCP_FILES: Record<McpTarget, string> = {
  claude: ".mcp.json",
  cursor: ".cursor/mcp.json",
  codex: ".codex/config.toml",
  gemini: ".gemini/settings.json",
  copilot: ".vscode/mcp.json",
  opencode: "opencode.json",
  kiro: ".kiro/settings/mcp.json",
};

/** A harness-neutral server definition. Env values are variable names, never literals. */
export interface McpServer {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  /** Environment variables the server needs, passed through by name. */
  env?: string[];
  /** HTTP headers whose value is `Bearer ${VAR}` style: header → variable. */
  headers?: Record<string, string>;
}

export interface McpCatalogEntry extends McpServer { description: string; auth?: "oauth" | "env" | "none"; docs: string }

/** Curated servers with pinned packages (checked against the npm registry when FORGE 4.0 shipped). */
export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  { name: "context7", transport: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp@4.7.3"], description: "Current, version-specific library docs for the agent", auth: "none", docs: "https://github.com/upstash/context7" },
  { name: "playwright", transport: "stdio", command: "npx", args: ["-y", "@playwright/mcp@0.0.86"], description: "Drive a real browser for E2E checks and UI debugging", auth: "none", docs: "https://github.com/microsoft/playwright-mcp" },
  { name: "sequential-thinking", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking@2.0.0"], description: "Structured step-by-step reasoning for hard problems", auth: "none", docs: "https://github.com/modelcontextprotocol/servers" },
  { name: "memory", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory@2.1.1"], description: "Knowledge-graph memory (FORGE's own memory is also exposed by `forge mcp-server`)", auth: "none", docs: "https://github.com/modelcontextprotocol/servers" },
  { name: "filesystem", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem@2.4.0", "."], description: "File access limited to this project directory", auth: "none", docs: "https://github.com/modelcontextprotocol/servers" },
  { name: "supabase", transport: "stdio", command: "npx", args: ["-y", "@supabase/mcp-server-supabase@0.19.0", "--read-only"], env: ["SUPABASE_ACCESS_TOKEN"], description: "Supabase projects, read-only by default", auth: "env", docs: "https://github.com/supabase-community/supabase-mcp" },
  { name: "github", transport: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "GITHUB_PAT" }, description: "GitHub's official remote server: issues, PRs, code search, Actions", auth: "env", docs: "https://github.com/github/github-mcp-server" },
  { name: "sentry", transport: "http", url: "https://mcp.sentry.dev/mcp", description: "Sentry issues, traces and releases", auth: "oauth", docs: "https://docs.sentry.io/product/sentry-mcp/" },
  { name: "linear", transport: "http", url: "https://mcp.linear.app/mcp", description: "Linear issues and projects", auth: "oauth", docs: "https://linear.app/docs/mcp" },
  { name: "vercel", transport: "http", url: "https://mcp.vercel.com", description: "Vercel deployments, logs and projects", auth: "oauth", docs: "https://vercel.com/docs/mcp/vercel-mcp" },
  { name: "notion", transport: "http", url: "https://mcp.notion.com/mcp", description: "Notion pages and databases", auth: "oauth", docs: "https://developers.notion.com/docs/mcp" },
  { name: "cloudflare-docs", transport: "http", url: "https://docs.mcp.cloudflare.com/mcp", description: "Cloudflare documentation search", auth: "none", docs: "https://github.com/cloudflare/mcp-server-cloudflare" },
];

type Json = Record<string, unknown>;
const asRecord = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? v as Json : undefined);
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const VAR = /^[A-Z_][A-Z0-9_]*$/;

// ---------------------------------------------------------------------------
// Reading a server back into the neutral form (from Claude's .mcp.json)
// ---------------------------------------------------------------------------

const ENV_REF = /^\$\{(?:env:)?([A-Z_][A-Z0-9_]*)\}$|^\$([A-Z_][A-Z0-9_]*)$|^\{env:([A-Z_][A-Z0-9_]*)\}$/;

export interface ImportProblem { name: string; problem: string }

/** Convert an existing config entry to the neutral form. Literal env values are rejected, not copied. */
export function toNeutral(name: string, value: unknown): { server?: McpServer; problem?: string } {
  const entry = asRecord(value);
  if (!entry) return { problem: "not an object" };
  if (!NAME.test(name)) return { problem: "invalid server name" };
  const url = typeof entry.url === "string" ? entry.url : typeof entry.httpUrl === "string" ? entry.httpUrl : typeof entry.serverUrl === "string" ? entry.serverUrl : undefined;
  const env: string[] = [];
  for (const [key, raw] of Object.entries(asRecord(entry.env) ?? asRecord(entry.environment) ?? {})) {
    if (!VAR.test(key)) return { problem: `invalid environment variable name ${key}` };
    const ref = typeof raw === "string" ? ENV_REF.exec(raw) : null;
    const refName = ref ? ref[1] ?? ref[2] ?? ref[3] : undefined;
    if (!ref || refName !== key) return { problem: `env.${key} holds a literal value; use "\${${key}}" so FORGE never copies a secret into more files` };
    env.push(key);
  }
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(asRecord(entry.headers) ?? {})) {
    const match = typeof raw === "string" ? /^(?:Bearer\s+)?\$\{(?:env:)?([A-Z_][A-Z0-9_]*)\}$/.exec(raw) : null;
    if (!match) return { problem: `header ${key} holds a literal value; reference an environment variable instead` };
    headers[key] = match[1] as string;
  }
  if (url) {
    if (!/^https:\/\//.test(url) && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/.test(url)) return { problem: "remote servers must use https" };
    return { server: { name, transport: "http", url, ...(env.length ? { env } : {}), ...(Object.keys(headers).length ? { headers } : {}) } };
  }
  const commandValue = entry.command;
  const argv = Array.isArray(commandValue) ? commandValue.filter((v): v is string => typeof v === "string") : typeof commandValue === "string" ? [commandValue] : [];
  if (!argv.length) return { problem: "no command or url" };
  const args = [...argv.slice(1), ...(Array.isArray(entry.args) ? entry.args.filter((v): v is string => typeof v === "string") : [])];
  return { server: { name, transport: "stdio", command: argv[0] as string, ...(args.length ? { args } : {}), ...(env.length ? { env } : {}) } };
}

// ---------------------------------------------------------------------------
// Rendering per harness
// ---------------------------------------------------------------------------

export function renderJsonEntry(target: Exclude<McpTarget, "codex">, server: McpServer): Json {
  const ref = (name: string) => target === "cursor" || target === "copilot" ? `\${env:${name}}` : target === "gemini" ? `$${name}` : target === "opencode" ? `{env:${name}}` : `\${${name}}`;
  const env = Object.fromEntries((server.env ?? []).map(name => [name, ref(name)]));
  const headers = Object.fromEntries(Object.entries(server.headers ?? {}).map(([header, name]) => [header, header.toLowerCase() === "authorization" ? `Bearer ${ref(name)}` : ref(name)]));
  const hasEnv = Object.keys(env).length > 0;
  const hasHeaders = Object.keys(headers).length > 0;
  if (target === "opencode") {
    return server.transport === "http"
      ? { type: "remote", url: server.url, enabled: true, ...(hasHeaders ? { headers } : {}) }
      : { type: "local", command: [server.command, ...(server.args ?? [])], enabled: true, ...(hasEnv ? { environment: env } : {}) };
  }
  if (server.transport === "http") {
    if (target === "gemini") return { httpUrl: server.url, ...(hasHeaders ? { headers } : {}) };
    if (target === "claude" || target === "copilot") return { type: "http", url: server.url, ...(hasHeaders ? { headers } : {}) };
    return { url: server.url, ...(hasHeaders ? { headers } : {}) };
  }
  return { ...(target === "copilot" ? { type: "stdio" } : {}), command: server.command, args: server.args ?? [], ...(hasEnv ? { env } : {}) };
}

const toml = (value: string) => JSON.stringify(value);

export function renderCodexTable(server: McpServer): string {
  const lines = [`[mcp_servers.${server.name}]`];
  if (server.transport === "http") {
    lines.push(`url = ${toml(server.url ?? "")}`);
    const auth = Object.entries(server.headers ?? {}).find(([header]) => header.toLowerCase() === "authorization");
    if (auth) lines.push(`bearer_token_env_var = ${toml(auth[1])}`);
    const others = Object.entries(server.headers ?? {}).filter(([header]) => header.toLowerCase() !== "authorization");
    if (others.length) lines.push(`env_http_headers = { ${others.map(([header, name]) => `${toml(header)} = ${toml(name)}`).join(", ")} }`);
  } else {
    lines.push(`command = ${toml(server.command ?? "")}`, `args = [${(server.args ?? []).map(toml).join(", ")}]`);
    if (server.env?.length) lines.push(`env_vars = [${server.env.map(toml).join(", ")}]`);
  }
  return lines.join("\n");
}

const CODEX_BEGIN = "# forge:mcp:begin (managed by `forge mcp`; edit with forge mcp add/remove)";
const CODEX_END = "# forge:mcp:end";

function codexBlock(text: string): { before: string; block: string; after: string } | undefined {
  const start = text.indexOf(CODEX_BEGIN);
  if (start < 0) return undefined;
  const end = text.indexOf(CODEX_END, start);
  if (end < 0) throw new Error(".codex/config.toml has a FORGE MCP block without its end marker; fix it by hand.");
  return { before: text.slice(0, start), block: text.slice(start + CODEX_BEGIN.length, end), after: text.slice(end + CODEX_END.length) };
}

export function codexServerNames(text: string): { all: string[]; managed: string[] } {
  const names = (chunk: string) => [...chunk.matchAll(/^\[mcp_servers\.("?)([A-Za-z0-9_-]+)\1\]\s*$/gm)].map(m => m[2] as string);
  const block = codexBlock(text);
  return { all: names(text), managed: block ? names(block.block) : [] };
}

/** Rewrite the managed Codex block with the given tables (empty list removes the block). */
export function writeCodexBlock(text: string, tables: Map<string, string>): string {
  const block = codexBlock(text);
  const base = block ? (block.before.replace(/\n+$/, "") + (block.after.trim() ? "\n\n" + block.after.replace(/^\n+/, "") : "")) : text;
  const trimmed = base.replace(/\s+$/, "");
  if (!tables.size) return trimmed ? trimmed + "\n" : "";
  const body = [...tables.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, table]) => table).join("\n\n");
  return `${trimmed ? trimmed + "\n\n" : ""}${CODEX_BEGIN}\n${body}\n${CODEX_END}\n`;
}

// ---------------------------------------------------------------------------
// State and file IO
// ---------------------------------------------------------------------------

export const MCP_STATE_PATH = ".forge/mcp-state.json";
export interface McpState { schemaVersion: 1; servers: Record<string, { targets: McpTarget[]; source: "catalog" | "sync" }> }

async function readText(file: string): Promise<string | undefined> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${file} must be a regular file.`);
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicWrite(file: string, content: string | null): Promise<void> {
  if (content === null) { await rm(file, { force: true }); return; }
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, content, "utf8");
  try { await rename(temporary, file); } catch (error) { await rm(temporary, { force: true }); throw error; }
}

async function readState(root: string): Promise<McpState> {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, MCP_STATE_PATH), "utf8")) as McpState;
    if (parsed && parsed.schemaVersion === 1 && asRecord(parsed.servers)) return parsed;
  } catch { /* fresh */ }
  return { schemaVersion: 1, servers: {} };
}

function jsonKey(target: Exclude<McpTarget, "codex">): string {
  return target === "copilot" ? "servers" : target === "opencode" ? "mcp" : "mcpServers";
}

function parseJsonDoc(text: string | undefined, file: string): Json {
  if (text === undefined || !text.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error(`${file} is not plain JSON (comments or trailing commas?); FORGE will not rewrite it.`); }
  const doc = asRecord(parsed);
  if (!doc) throw new Error(`${file} must contain a JSON object.`);
  return doc;
}

/** Server names configured in a target's file (any source). */
export async function configuredServers(root: string, target: McpTarget): Promise<string[]> {
  const text = await readText(path.join(root, MCP_FILES[target])).catch(() => undefined);
  if (text === undefined) return [];
  if (target === "codex") return codexServerNames(text).all;
  try { return Object.keys(asRecord(asRecord(JSON.parse(text))?.[jsonKey(target)]) ?? {}); } catch { return []; }
}

export interface McpChange { target: McpTarget; file: string; server: string; action: "add" | "update" | "unchanged" | "remove" | "skip"; detail?: string }

export interface McpApplyOptions { projectPath: string; targets: McpTarget[]; dryRun?: boolean; force?: boolean; source?: "catalog" | "sync" }

/** Write servers into every target. User-owned entries with the same name are kept unless --force. */
export async function addMcpServers(servers: McpServer[], options: McpApplyOptions): Promise<McpChange[]> {
  const root = await realpath(path.resolve(options.projectPath));
  const state = await readState(root);
  const changes: McpChange[] = [];
  for (const target of options.targets) {
    const file = MCP_FILES[target];
    const absolute = path.join(root, file);
    let text: string | undefined;
    try { text = await readText(absolute); } catch (error) { for (const s of servers) changes.push({ target, file, server: s.name, action: "skip", detail: String((error as Error).message) }); continue; }
    if (target === "codex") {
      const current = text ?? "";
      let names: { all: string[]; managed: string[] };
      try { names = codexServerNames(current); codexBlock(current); } catch (error) { for (const s of servers) changes.push({ target, file, server: s.name, action: "skip", detail: (error as Error).message }); continue; }
      const block = codexBlock(current);
      const tables = new Map<string, string>();
      for (const chunk of (block?.block ?? "").split(/\n(?=\[mcp_servers\.)/)) {
        const match = /^\[mcp_servers\.("?)([A-Za-z0-9_-]+)\1\]/m.exec(chunk.trim());
        if (match) tables.set(match[2] as string, chunk.trim());
      }
      for (const server of servers) {
        const userOwned = names.all.includes(server.name) && !names.managed.includes(server.name);
        if (userOwned) { changes.push({ target, file, server: server.name, action: "skip", detail: "already defined outside FORGE's block" }); continue; }
        const table = renderCodexTable(server);
        changes.push({ target, file, server: server.name, action: tables.get(server.name) === table ? "unchanged" : tables.has(server.name) ? "update" : "add" });
        tables.set(server.name, table);
      }
      const next = writeCodexBlock(current, tables);
      if (!options.dryRun && next !== current) await atomicWrite(absolute, next);
    } else {
      let doc: Json;
      try { doc = parseJsonDoc(text, file); } catch (error) { for (const s of servers) changes.push({ target, file, server: s.name, action: "skip", detail: (error as Error).message }); continue; }
      const key = jsonKey(target);
      const section = { ...(asRecord(doc[key]) ?? {}) };
      for (const server of servers) {
        const rendered = renderJsonEntry(target, server);
        const existing = section[server.name];
        const ours = state.servers[server.name]?.targets.includes(target) ?? false;
        if (existing !== undefined && !ours && !options.force) {
          changes.push({ target, file, server: server.name, action: JSON.stringify(existing) === JSON.stringify(rendered) ? "unchanged" : "skip", ...(JSON.stringify(existing) === JSON.stringify(rendered) ? {} : { detail: "you already configured this server; kept yours (--force replaces it)" }) });
          continue;
        }
        changes.push({ target, file, server: server.name, action: existing === undefined ? "add" : JSON.stringify(existing) === JSON.stringify(rendered) ? "unchanged" : "update" });
        section[server.name] = rendered;
      }
      const next = { ...doc, ...(target === "opencode" && doc.$schema === undefined && text === undefined ? { $schema: "https://opencode.ai/config.json" } : {}), [key]: section };
      const content = JSON.stringify(next, null, 2) + "\n";
      if (!options.dryRun && content !== text) await atomicWrite(absolute, content);
    }
  }
  if (!options.dryRun) {
    for (const change of changes) {
      if (change.action !== "add" && change.action !== "update" && !(change.action === "unchanged" && state.servers[change.server]?.targets.includes(change.target))) continue;
      const entry = state.servers[change.server] ?? { targets: [], source: options.source ?? "catalog" };
      if (!entry.targets.includes(change.target)) entry.targets.push(change.target);
      state.servers[change.server] = entry;
    }
    await atomicWrite(path.join(root, MCP_STATE_PATH), JSON.stringify(state, null, 2) + "\n");
  }
  return changes;
}

/** Remove servers FORGE wrote (or any entry with --force) from every target. */
export async function removeMcpServers(names: string[], options: Omit<McpApplyOptions, "source">): Promise<McpChange[]> {
  const root = await realpath(path.resolve(options.projectPath));
  const state = await readState(root);
  const changes: McpChange[] = [];
  for (const target of options.targets) {
    const file = MCP_FILES[target];
    const absolute = path.join(root, file);
    const text = await readText(absolute).catch(() => undefined);
    if (text === undefined) continue;
    const removable = names.filter(name => options.force || state.servers[name]?.targets.includes(target));
    if (!removable.length) continue;
    if (target === "codex") {
      const block = codexBlock(text);
      if (!block) continue;
      const tables = new Map<string, string>();
      for (const chunk of block.block.split(/\n(?=\[mcp_servers\.)/)) {
        const match = /^\[mcp_servers\.("?)([A-Za-z0-9_-]+)\1\]/m.exec(chunk.trim());
        if (match) tables.set(match[2] as string, chunk.trim());
      }
      for (const name of removable) if (tables.delete(name)) changes.push({ target, file, server: name, action: "remove" });
      const next = writeCodexBlock(text, tables);
      if (!options.dryRun && next !== text) await atomicWrite(absolute, next.trim() ? next : null);
    } else {
      let doc: Json;
      try { doc = parseJsonDoc(text, file); } catch { continue; }
      const key = jsonKey(target);
      const section = { ...(asRecord(doc[key]) ?? {}) };
      for (const name of removable) if (name in section) { delete section[name]; changes.push({ target, file, server: name, action: "remove" }); }
      const next: Json = { ...doc };
      if (Object.keys(section).length) next[key] = section; else delete next[key];
      const empty = Object.keys(next).filter(k => k !== "$schema").length === 0;
      if (!options.dryRun) await atomicWrite(absolute, empty ? null : JSON.stringify(next, null, 2) + "\n");
    }
  }
  if (!options.dryRun) {
    for (const change of changes) {
      const entry = state.servers[change.server];
      if (!entry) continue;
      entry.targets = entry.targets.filter(t => t !== change.target);
      if (!entry.targets.length) delete state.servers[change.server];
    }
    await atomicWrite(path.join(root, MCP_STATE_PATH), JSON.stringify(state, null, 2) + "\n");
  }
  return changes;
}

/** Read the servers in `.mcp.json` (Claude Code) so they can be copied to every other harness. */
export async function readSyncSource(projectPath: string, from: McpTarget = "claude"): Promise<{ servers: McpServer[]; problems: ImportProblem[] }> {
  if (from === "codex") throw new Error("Sync from Codex is not supported; use .mcp.json, .cursor/mcp.json or .gemini/settings.json as the source.");
  const root = await realpath(path.resolve(projectPath));
  const text = await readText(path.join(root, MCP_FILES[from]));
  if (text === undefined) throw new Error(`${MCP_FILES[from]} does not exist. Add servers there first, or use \`forge mcp add <name>\`.`);
  const doc = parseJsonDoc(text, MCP_FILES[from]);
  const section = asRecord(doc[jsonKey(from)]) ?? {};
  const servers: McpServer[] = [];
  const problems: ImportProblem[] = [];
  for (const [name, value] of Object.entries(section)) {
    const { server, problem } = toNeutral(name, value);
    if (server) servers.push(server); else problems.push({ name, problem: problem ?? "unsupported" });
  }
  return { servers, problems };
}

const TARGET_HINTS: Record<McpTarget, string[]> = {
  claude: [".mcp.json", ".claude", "CLAUDE.md"],
  cursor: [".cursor", ".cursorrules"],
  codex: [".codex", "AGENTS.md"],
  gemini: [".gemini", "GEMINI.md"],
  copilot: [".vscode/mcp.json", ".github/copilot-instructions.md"],
  opencode: ["opencode.json", ".opencode"],
  kiro: [".kiro"],
};

/** Harnesses this project appears to use. Claude Code is always included as the source of truth. */
export async function detectMcpTargets(projectPath: string): Promise<McpTarget[]> {
  const root = path.resolve(projectPath);
  const found: McpTarget[] = [];
  for (const target of MCP_TARGETS) {
    for (const hint of TARGET_HINTS[target]) {
      if (await lstat(path.join(root, hint)).then(() => true, () => false)) { found.push(target); break; }
    }
  }
  return found.includes("claude") ? found : ["claude", ...found];
}

export interface McpMatrixRow { name: string; managed: boolean; targets: Record<McpTarget, boolean> }

export async function mcpMatrix(projectPath: string): Promise<McpMatrixRow[]> {
  const root = await realpath(path.resolve(projectPath));
  const state = await readState(root);
  const present = new Map<McpTarget, string[]>();
  for (const target of MCP_TARGETS) present.set(target, await configuredServers(root, target));
  const names = new Set<string>([...present.values()].flat());
  return [...names].sort().map(name => ({
    name,
    managed: Boolean(state.servers[name]),
    targets: Object.fromEntries(MCP_TARGETS.map(t => [t, present.get(t)?.includes(name) ?? false])) as Record<McpTarget, boolean>,
  }));
}

export function formatMatrix(rows: McpMatrixRow[], targets?: readonly McpTarget[]): string {
  if (!rows.length) return "No MCP servers configured. Try: forge mcp add context7 playwright";
  const columns = targets ?? MCP_TARGETS.filter(t => rows.some(r => r.targets[t]));
  const width = Math.max(...rows.map(r => r.name.length), 6);
  const header = `  ${"server".padEnd(width)}  ${columns.map(t => t.padEnd(10)).join("")}`;
  const body = rows.map(r => `  ${r.name.padEnd(width)}  ${columns.map(t => (r.targets[t] ? "✓" : "·").padEnd(10)).join("")}${r.managed ? "" : "(yours)"}`);
  const gaps = rows.filter(r => columns.some(t => !r.targets[t])).length;
  return [header, ...body, "", gaps ? `${gaps} server(s) are missing from some harnesses. Run \`forge mcp sync\` to copy .mcp.json everywhere.` : `Every server is available in ${columns.length === 1 ? columns[0] : "all " + columns.length + " harnesses"}.`].join("\n");
}

export function formatChanges(changes: McpChange[]): string {
  if (!changes.length) return "Nothing to change.";
  return changes.map(c => `  ${c.action.padEnd(9)} ${c.server.padEnd(20)} ${c.file}${c.detail ? `  (${c.detail})` : ""}`).join("\n");
}
