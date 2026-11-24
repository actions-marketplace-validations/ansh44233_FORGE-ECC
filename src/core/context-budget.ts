import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "./harness-catalog.js";
import { mcpServers } from "./shield-extended.js";

/**
 * `forge context`: what every session pays before the first prompt.
 *
 * Instruction files, always-on rules, skill and agent descriptions and MCP
 * servers are loaded into every session of a harness. FORGE measures them per
 * harness, estimates tokens (about 4 characters per token; an estimate, not a
 * tokenizer count), and points at the specific files to trim.
 */

export type ContextHarness = "claude" | "codex" | "cursor" | "gemini" | "copilot";
export const CONTEXT_HARNESSES: readonly ContextHarness[] = ["claude", "codex", "cursor", "gemini", "copilot"];

export interface ContextItem { file: string; kind: "instructions" | "rule" | "skill-index" | "agent-index" | "command-index" | "import"; tokens: number }
export interface ContextFinding { severity: "high" | "medium" | "low"; id: string; file?: string; message: string; fix: string; savings?: number }
export interface HarnessBudget { harness: ContextHarness; tokens: number; items: ContextItem[]; mcpServers: number }
export interface ContextReport { root: string; harnesses: HarnessBudget[]; findings: ContextFinding[]; grade: "A" | "B" | "C" | "D" | "F"; worst: number }

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

async function readText(file: string): Promise<string | undefined> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) return undefined;
    return await readFile(file, "utf8");
  } catch { return undefined; }
}

async function listFiles(dir: string, pattern: RegExp, depth = 2): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string, level: number) => {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && level < depth) await walk(full, level + 1);
      else if (entry.isFile() && pattern.test(entry.name)) out.push(full);
    }
  };
  await walk(dir, 0);
  return out.sort();
}

const jsonOf = (text: string | undefined): unknown => { try { return JSON.parse(text ?? "{}"); } catch { return {}; } };
const rel = (root: string, file: string) => path.relative(root, file).split(path.sep).join("/");

/** Claude Code `@path` imports in CLAUDE.md, one level deep, inside the project. */
async function claudeImports(root: string, text: string, texts: Map<string, string>): Promise<ContextItem[]> {
  const items: ContextItem[] = [];
  const stripped = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  for (const match of stripped.matchAll(/(?:^|\s)@([\w./-]+\.(?:md|mdc|txt))/g)) {
    const target = path.resolve(root, match[1] as string);
    if (!target.startsWith(root + path.sep)) continue;
    const content = await readText(target);
    if (content !== undefined) { texts.set(rel(root, target), content); items.push({ file: rel(root, target), kind: "import", tokens: estimateTokens(content) }); }
  }
  return items;
}

function indexTokens(content: string): number {
  const { metadata } = parseFrontmatter(content);
  return estimateTokens(`${metadata.get("name") ?? ""}: ${metadata.get("description") ?? ""}`) + 8;
}

async function descriptionsIn(root: string, dir: string, kind: ContextItem["kind"], pattern: RegExp, depth: number): Promise<{ items: ContextItem[]; long: Array<{ file: string; length: number }> }> {
  const items: ContextItem[] = [];
  const long: Array<{ file: string; length: number }> = [];
  for (const file of await listFiles(path.join(root, dir), pattern, depth)) {
    const content = await readText(file);
    if (content === undefined) continue;
    const description = parseFrontmatter(content).metadata.get("description") ?? "";
    if (description.length > 300) long.push({ file: rel(root, file), length: description.length });
    items.push({ file: rel(root, file), kind, tokens: indexTokens(content) });
  }
  return { items, long };
}

function paragraphs(text: string): string[] {
  return text.split(/\n\s*\n/).map(p => p.replace(/\s+/g, " ").trim()).filter(p => p.length >= 120 && !p.startsWith("<!--"));
}

export async function analyzeContext(projectPath: string): Promise<ContextReport> {
  const root = path.resolve(projectPath);
  const findings: ContextFinding[] = [];
  const harnesses: HarnessBudget[] = [];
  const instructionTexts = new Map<string, string>();

  const instructions = async (file: string): Promise<ContextItem | undefined> => {
    const content = await readText(path.join(root, file));
    if (content === undefined) return undefined;
    instructionTexts.set(file, content);
    const tokens = estimateTokens(content);
    if (tokens > 6000) findings.push({ severity: "high", id: "CTX-INSTRUCTIONS-HUGE", file, message: `${file} is about ${tokens.toLocaleString("en-US")} tokens and loads into every session.`, fix: "Keep the always-loaded file to project facts and hard rules; move procedures into skills (loaded on demand) or path-scoped rules.", savings: tokens - 2500 });
    else if (tokens > 2500) findings.push({ severity: "medium", id: "CTX-INSTRUCTIONS-LARGE", file, message: `${file} is about ${tokens.toLocaleString("en-US")} tokens and loads into every session.`, fix: "Move long how-to sections into skills and keep this file under about 2,500 tokens.", savings: tokens - 2500 });
    return { file, kind: "instructions", tokens };
  };

  // Claude Code ---------------------------------------------------------------
  {
    const items: ContextItem[] = [];
    for (const file of ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"]) {
      const item = await instructions(file);
      if (item) { items.push(item); items.push(...await claudeImports(root, instructionTexts.get(file) ?? "", instructionTexts)); }
    }
    let conditional = 0;
    for (const file of await listFiles(path.join(root, ".claude/rules"), /\.md$/, 3)) {
      const content = await readText(file);
      if (content === undefined) continue;
      if (parseFrontmatter(content).metadata.has("paths")) { conditional += 1; continue; }
      instructionTexts.set(rel(root, file), content);
      items.push({ file: rel(root, file), kind: "rule", tokens: estimateTokens(content) });
    }
    const skills = await descriptionsIn(root, ".claude/skills", "skill-index", /^SKILL\.md$/, 2);
    const agents = await descriptionsIn(root, ".claude/agents", "agent-index", /\.md$/, 2);
    const commands = await descriptionsIn(root, ".claude/commands", "command-index", /\.md$/, 3);
    items.push(...skills.items, ...agents.items, ...commands.items);
    for (const entry of [...skills.long, ...agents.long]) findings.push({ severity: "low", id: "CTX-LONG-DESCRIPTION", file: entry.file, message: `Description is ${entry.length} characters; every session loads it to decide when to use the item.`, fix: "Shorten the description to one or two sentences about when to use it; keep detail in the body.", savings: Math.round((entry.length - 200) / 4) });
    const rules = items.filter(i => i.kind === "rule");
    const ruleTokens = rules.reduce((sum, i) => sum + i.tokens, 0);
    if (ruleTokens > 4000) findings.push({ severity: "medium", id: "CTX-RULES-ALWAYS", file: ".claude/rules", message: `${rules.length} always-on rules cost about ${ruleTokens.toLocaleString("en-US")} tokens per session${conditional ? ` (${conditional} are already path-scoped)` : ""}.`, fix: "Add `paths:` frontmatter to language and framework rules so they only load for matching files.", savings: Math.round(ruleTokens * 0.6) });
    if (skills.items.length > 80) findings.push({ severity: "medium", id: "CTX-SKILL-SPRAWL", file: ".claude/skills", message: `${skills.items.length} skills are indexed in every session.`, fix: "Remove skills for stacks this repo does not use (`forge install` only installs detected stacks).", savings: Math.round(skills.items.reduce((s, i) => s + i.tokens, 0) / 2) });
    const servers = Object.keys(mcpServers(jsonOf(await readText(path.join(root, ".mcp.json")))));
    harnesses.push({ harness: "claude", tokens: items.reduce((s, i) => s + i.tokens, 0), items, mcpServers: servers.length });
  }

  // Codex ---------------------------------------------------------------------
  {
    const items: ContextItem[] = [];
    const agentsMd = await instructions("AGENTS.md");
    if (agentsMd) items.push(agentsMd);
    const override = await instructions("AGENTS.override.md");
    if (override) items.push(override);
    const skills = await descriptionsIn(root, ".agents/skills", "skill-index", /^SKILL\.md$/, 2);
    items.push(...skills.items);
    const toml = await readText(path.join(root, ".codex/config.toml")) ?? "";
    harnesses.push({ harness: "codex", tokens: items.reduce((s, i) => s + i.tokens, 0), items, mcpServers: [...toml.matchAll(/^\[mcp_servers\.[^\].]+\]\s*$/gm)].length });
  }

  // Cursor --------------------------------------------------------------------
  {
    const items: ContextItem[] = [];
    const legacy = await instructions(".cursorrules");
    if (legacy) items.push(legacy);
    for (const file of await listFiles(path.join(root, ".cursor/rules"), /\.mdc?$/, 3)) {
      const content = await readText(file);
      if (content === undefined) continue;
      if (parseFrontmatter(content).metadata.get("alwaysapply") === "true") items.push({ file: rel(root, file), kind: "rule", tokens: estimateTokens(content) });
    }
    const always = items.filter(i => i.kind === "rule");
    const alwaysTokens = always.reduce((s, i) => s + i.tokens, 0);
    if (alwaysTokens > 4000) findings.push({ severity: "medium", id: "CTX-CURSOR-ALWAYS", file: ".cursor/rules", message: `${always.length} Cursor rules use alwaysApply: true (about ${alwaysTokens.toLocaleString("en-US")} tokens per request).`, fix: "Switch rules that only matter for some files to `globs:` instead of alwaysApply.", savings: Math.round(alwaysTokens * 0.6) });
    const mcp = Object.keys(mcpServers(jsonOf(await readText(path.join(root, ".cursor/mcp.json")))));
    harnesses.push({ harness: "cursor", tokens: items.reduce((s, i) => s + i.tokens, 0), items, mcpServers: mcp.length });
  }

  // Gemini and Copilot ----------------------------------------------------------
  for (const [harness, file, mcpFile] of [["gemini", "GEMINI.md", ".gemini/settings.json"], ["copilot", ".github/copilot-instructions.md", ".vscode/mcp.json"]] as const) {
    const items: ContextItem[] = [];
    const item = await instructions(file);
    if (item) items.push(item);
    let servers = 0;
    servers = Object.keys(mcpServers(jsonOf(await readText(path.join(root, mcpFile))))).length;
    harnesses.push({ harness, tokens: items.reduce((s, i) => s + i.tokens, 0), items, mcpServers: servers });
  }

  // MCP servers: each one's tool definitions load into context.
  for (const h of harnesses) {
    if (h.mcpServers > 8) findings.push({ severity: "medium", id: "CTX-MCP-MANY", message: `${h.harness} has ${h.mcpServers} MCP servers; their tool definitions load into every session.`, fix: "Disable servers you do not use in this repo (`forge mcp remove NAME --target " + h.harness + "`)." });
  }

  // Text a single harness loads twice (e.g. CLAUDE.md repeating an imported AGENTS.md).
  for (const h of harnesses) {
    const seen = new Map<string, string>();
    const duplicates = new Map<string, number>();
    for (const item of h.items) {
      const text = instructionTexts.get(item.file);
      if (text === undefined) continue;
      for (const paragraph of new Set(paragraphs(text))) {
        const first = seen.get(paragraph);
        if (first && first !== item.file) {
          const key = `${first} and ${item.file}`;
          duplicates.set(key, (duplicates.get(key) ?? 0) + estimateTokens(paragraph));
        } else if (!first) seen.set(paragraph, item.file);
      }
    }
    for (const [files, tokens] of duplicates) {
      if (tokens < 100) continue;
      findings.push({ severity: "low", id: "CTX-DUPLICATE", file: files, message: `${h.harness} loads about ${tokens.toLocaleString("en-US")} tokens twice: the same text is in ${files}.`, fix: "Keep each instruction in one file; import shared guidance (`@AGENTS.md` in CLAUDE.md) instead of copying it.", savings: tokens });
    }
  }

  const worst = Math.max(0, ...harnesses.map(h => h.tokens));
  const grade = worst <= 4000 ? "A" : worst <= 8000 ? "B" : worst <= 14000 ? "C" : worst <= 22000 ? "D" : "F";
  const rank = { high: 0, medium: 1, low: 2 } as const;
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.savings ?? 0) - (a.savings ?? 0));
  return { root, harnesses, findings, grade, worst };
}

export function formatContextReport(report: ContextReport, options: { verbose?: boolean } = {}): string {
  const used = report.harnesses.filter(h => h.tokens > 0 || h.mcpServers > 0);
  const lines = [`FORGE context budget · grade ${report.grade} · heaviest harness ≈ ${report.worst.toLocaleString("en-US")} tokens before your first prompt`, ""];
  if (!used.length) lines.push("  No agent instructions, rules, skills or MCP servers found.");
  for (const h of used) {
    const bar = "█".repeat(Math.min(30, Math.round(h.tokens / 800))) || "▏";
    lines.push(`  ${h.harness.padEnd(8)} ${bar.padEnd(30)} ≈${h.tokens.toLocaleString("en-US").padStart(7)} tok · ${h.items.length} item(s)${h.mcpServers ? ` · ${h.mcpServers} MCP server(s)` : ""}`);
    const top = [...h.items].sort((a, b) => b.tokens - a.tokens).slice(0, options.verbose ? 12 : 3);
    for (const item of top) lines.push(`             ${String(item.tokens).padStart(6)}  ${item.file}${item.kind === "import" ? "  (imported)" : ""}`);
  }
  lines.push("");
  if (!report.findings.length) lines.push("No context waste found.");
  else {
    const total = report.findings.reduce((s, f) => s + (f.savings ?? 0), 0);
    lines.push(`Findings${total ? ` · up to ≈${total.toLocaleString("en-US")} tokens per session to save` : ""}:`);
    for (const f of report.findings.slice(0, options.verbose ? 50 : 8)) lines.push(`  [${f.severity}] ${f.message}`, `         → ${f.fix}`);
    if (!options.verbose && report.findings.length > 8) lines.push(`  …${report.findings.length - 8} more (use --verbose)`);
  }
  lines.push("", "Token counts are estimates (about 4 characters per token). MCP tool definitions are counted as servers, not tokens.");
  return lines.join("\n");
}
