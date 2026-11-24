import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { globalMemoryRoot } from "./project-memory.js";

/**
 * Instincts: small, evidence-backed behaviours FORGE learns from a project.
 *
 * Sources are deterministic — git co-change history, commit conventions, FORGE
 * Guard denials and verification failures recorded by the runtime hooks — so
 * the same history always yields the same instincts.
 *
 * Trust boundary: learned and imported instincts always start as `candidate`.
 * Only a human (`forge instinct promote`) makes one `active`, and only active
 * instincts are injected into sessions or compiled into skills by `forge evolve`.
 */

const execFileAsync = promisify(execFile);

export const INSTINCTS_PATH = ".forge/instincts.json";
export const OBSERVATIONS_PATH = ".forge/session/observations.jsonl";
const DOCUMENT_VERSION = 1;
const MAX_INSTINCTS = 300;
const MAX_TEXT = 400;
const MAX_FILE_BYTES = 1024 * 1024;
const SECRET = /(?:api[_-]?key|secret|password|access[_-]?token)\s*[:=]\s*\S+|\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

export type InstinctStatus = "candidate" | "active" | "rejected";
export type InstinctSource = "git-cochange" | "git-convention" | "guard" | "verification" | "manual" | "import";
export type InstinctScope = "project" | "global";
export const INSTINCT_STATUSES: readonly InstinctStatus[] = ["candidate", "active", "rejected"];

export interface Instinct {
  id: string;
  /** When this applies, e.g. "editing src/api/**". */
  trigger: string;
  /** What to do, e.g. "also update tests/api.test.ts". */
  action: string;
  domain: string;
  source: InstinctSource;
  status: InstinctStatus;
  /** 0..1; derived from how often the evidence was observed. */
  confidence: number;
  occurrences: number;
  evidence: string[];
  createdAt: string;
  updatedAt: string;
}

interface InstinctDocument { version: typeof DOCUMENT_VERSION; instincts: Instinct[] }

export function instinctId(trigger: string, action: string): string {
  return "inst-" + createHash("sha256").update(`${trigger.trim().toLowerCase()}\u0000${action.trim().toLowerCase()}`).digest("hex").slice(0, 10);
}

function clampConfidence(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}

/** Evidence-count confidence: 2 sightings ≈ 0.5, 5 ≈ 0.8, capped at 0.95. */
export function confidenceFor(occurrences: number): number {
  return clampConfidence(Math.min(0.95, 1 - Math.pow(0.7, Math.max(1, occurrences))));
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TEXT && !SECRET.test(value);
}

function sanitize(raw: unknown, now: string): Instinct | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;
  if (!validText(v.trigger) || !validText(v.action)) return undefined;
  const status = INSTINCT_STATUSES.includes(v.status as InstinctStatus) ? v.status as InstinctStatus : "candidate";
  const sources: InstinctSource[] = ["git-cochange", "git-convention", "guard", "verification", "manual", "import"];
  const occurrences = typeof v.occurrences === "number" && Number.isFinite(v.occurrences) ? Math.max(1, Math.min(10_000, Math.floor(v.occurrences))) : 1;
  return {
    id: instinctId(v.trigger, v.action),
    trigger: v.trigger.trim(),
    action: v.action.trim(),
    domain: typeof v.domain === "string" && /^[a-z0-9-]{1,32}$/.test(v.domain) ? v.domain : "general",
    source: sources.includes(v.source as InstinctSource) ? v.source as InstinctSource : "import",
    status,
    confidence: typeof v.confidence === "number" && Number.isFinite(v.confidence) ? clampConfidence(v.confidence) : confidenceFor(occurrences),
    occurrences,
    evidence: Array.isArray(v.evidence) ? v.evidence.filter(validText).slice(0, 10) : [],
    createdAt: typeof v.createdAt === "string" && Number.isFinite(Date.parse(v.createdAt)) ? v.createdAt : now,
    updatedAt: typeof v.updatedAt === "string" && Number.isFinite(Date.parse(v.updatedAt)) ? v.updatedAt : now,
  };
}

function storeRoot(projectPath: string, scope: InstinctScope): string {
  return scope === "global" ? globalMemoryRoot() : path.resolve(projectPath);
}

export async function loadInstincts(projectPath: string, scope: InstinctScope = "project"): Promise<Instinct[]> {
  const file = path.join(storeRoot(projectPath, scope), INSTINCTS_PATH);
  let raw: Buffer;
  try { raw = await readFile(file); } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
  if (raw.byteLength > MAX_FILE_BYTES) throw new Error(`${INSTINCTS_PATH} exceeds the 1 MiB safety limit.`);
  const parsed = JSON.parse(raw.toString("utf8")) as Partial<InstinctDocument>;
  if (parsed.version !== DOCUMENT_VERSION || !Array.isArray(parsed.instincts)) throw new Error(`${INSTINCTS_PATH} has an unsupported format.`);
  const now = new Date().toISOString();
  const byId = new Map<string, Instinct>();
  for (const value of parsed.instincts.slice(0, MAX_INSTINCTS)) {
    const instinct = sanitize(value, now);
    if (instinct && !byId.has(instinct.id)) byId.set(instinct.id, instinct);
  }
  return [...byId.values()];
}

export async function saveInstincts(projectPath: string, instincts: Instinct[], scope: InstinctScope = "project"): Promise<void> {
  const file = path.join(storeRoot(projectPath, scope), INSTINCTS_PATH);
  await mkdir(path.dirname(file), { recursive: true });
  const sorted = [...instincts].sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id)).slice(0, MAX_INSTINCTS);
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: DOCUMENT_VERSION, instincts: sorted }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  try { await rename(temporary, file); } catch (error) { await rm(temporary, { force: true }); throw error; }
}

// ---------------------------------------------------------------------------
// Observations (written by the runtime hooks)
// ---------------------------------------------------------------------------

export type Observation =
  | { at: string; kind: "edit"; session?: string; file: string }
  | { at: string; kind: "verify"; session?: string; script: string; status: string; files: string[] };

export async function recordObservation(root: string, observation: Observation): Promise<void> {
  try {
    const file = path.join(root, OBSERVATIONS_PATH);
    await mkdir(path.dirname(file), { recursive: true });
    try { if ((await lstat(file)).size > 4 * 1024 * 1024) return; } catch { /* new file */ }
    await appendFile(file, JSON.stringify(observation) + "\n", "utf8");
  } catch {
    // Observation logging must never break a hook.
  }
}

async function readJsonLines(file: string): Promise<Record<string, unknown>[]> {
  let text: string;
  try { text = await readFile(file, "utf8"); } catch { return []; }
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/).slice(-20_000)) {
    if (!line.trim()) continue;
    try { const v = JSON.parse(line) as unknown; if (v && typeof v === "object") rows.push(v as Record<string, unknown>); } catch { /* skip */ }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------

export interface LearnedCandidate { trigger: string; action: string; domain: string; source: InstinctSource; occurrences: number; confidence: number; evidence: string[] }

const NOISE = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|go\.sum|poetry\.lock|CHANGELOG\.md|\.forge\/|dist\/|build\/|node_modules\/)/;

function domainOf(file: string): string {
  if (/(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[a-z]+$/.test(file)) return "testing";
  if (/^\.github\//.test(file)) return "ci";
  if (/\.(?:md|mdx)$/.test(file)) return "docs";
  if (/(?:^|\/)(?:api|server|routes)\//.test(file)) return "api";
  if (/\.(?:css|scss|html|tsx|jsx|vue|svelte)$/.test(file)) return "frontend";
  return "code";
}

export async function readGitCommits(root: string, limit = 400): Promise<Array<{ subject: string; files: string[] }>> {
  try {
    const { stdout } = await execFileAsync("git", ["log", "-n", String(limit), "--no-merges", "--name-only", "--format=%x1e%s"], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
    return stdout.split("\x1e").filter(Boolean).map(chunk => {
      const [subject = "", ...files] = chunk.split("\n");
      return { subject: subject.trim(), files: files.map(f => f.trim()).filter(Boolean) };
    });
  } catch {
    return [];
  }
}

/** Files that change together often enough to be worth remembering. */
export function mineCoChange(commits: Array<{ files: string[] }>, options: { minTogether?: number; minRatio?: number; maxPairs?: number } = {}): LearnedCandidate[] {
  const minTogether = options.minTogether ?? 4;
  const minRatio = options.minRatio ?? 0.6;
  const counts = new Map<string, number>();
  const pairs = new Map<string, number>();
  for (const commit of commits) {
    const files = [...new Set(commit.files.filter(f => !NOISE.test(f)))].sort();
    if (files.length < 2 || files.length > 12) continue; // sweeping commits say nothing about coupling
    for (const f of files) counts.set(f, (counts.get(f) ?? 0) + 1);
    for (let i = 0; i < files.length; i++) for (let j = i + 1; j < files.length; j++) {
      const key = `${files[i]}\u0000${files[j]}`;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
  }
  const out: LearnedCandidate[] = [];
  for (const [key, together] of pairs) {
    if (together < minTogether) continue;
    const [a, b] = key.split("\u0000") as [string, string];
    const ratioA = together / (counts.get(a) ?? together);
    const ratioB = together / (counts.get(b) ?? together);
    // Direction: the file whose changes almost always pull in the other is the trigger.
    const [from, to, ratio] = ratioA >= ratioB ? [a, b, ratioA] : [b, a, ratioB];
    if (ratio < minRatio) continue;
    out.push({
      trigger: `editing ${from}`,
      action: `also review ${to} — they changed together in ${together} of ${counts.get(from)} commits`,
      domain: domainOf(to),
      source: "git-cochange",
      occurrences: together,
      confidence: clampConfidence(Math.min(0.95, ratio * confidenceFor(together))),
      evidence: [`git log: ${together} commits touched both ${from} and ${to}`],
    });
  }
  return out.sort((x, y) => y.confidence - x.confidence || x.trigger.localeCompare(y.trigger)).slice(0, options.maxPairs ?? 25);
}

const CONVENTIONAL = /^(feat|fix|docs|chore|refactor|test|perf|ci|build|style|revert|release)(\([^)]+\))?!?: \S/;

export function mineCommitConvention(commits: Array<{ subject: string }>): LearnedCandidate[] {
  const subjects = commits.map(c => c.subject).filter(Boolean);
  if (subjects.length < 10) return [];
  const conventional = subjects.filter(s => CONVENTIONAL.test(s));
  const ratio = conventional.length / subjects.length;
  if (ratio < 0.7) return [];
  const scoped = conventional.filter(s => /^\w+\([^)]+\)/.test(s)).length / conventional.length >= 0.5;
  return [{
    trigger: "writing a commit message",
    action: scoped ? "use Conventional Commits with a scope, e.g. `fix(api): handle empty body`" : "use Conventional Commits, e.g. `fix: handle empty body`",
    domain: "git",
    source: "git-convention",
    occurrences: conventional.length,
    confidence: clampConfidence(ratio),
    evidence: [`${conventional.length} of ${subjects.length} recent commits follow Conventional Commits`],
  }];
}

export function mineGuard(rows: Record<string, unknown>[]): LearnedCandidate[] {
  const byRule = new Map<string, number>();
  for (const row of rows) if (typeof row.rule === "string" && /^[A-Z0-9-]{2,40}$/.test(row.rule)) byRule.set(row.rule, (byRule.get(row.rule) ?? 0) + 1);
  const out: LearnedCandidate[] = [];
  for (const [rule, n] of byRule) {
    if (n < 2) continue;
    out.push({
      trigger: `about to run a command matching FORGE Guard ${rule}`,
      action: `don't — FORGE Guard stopped this ${n} times; ask the user or find a safer command`,
      domain: "safety",
      source: "guard",
      occurrences: n,
      confidence: confidenceFor(n),
      evidence: [`.forge/session/guard.jsonl: ${rule} fired ${n} times`],
    });
  }
  return out;
}

function areaOf(file: string): string {
  const parts = file.split("/");
  return parts.length > 1 ? `${parts[0]}/**` : file;
}

export function mineVerification(rows: Record<string, unknown>[]): LearnedCandidate[] {
  const failures = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "verify" || row.status === "passed" || typeof row.script !== "string" || !/^[a-zA-Z0-9:_-]{1,64}$/.test(row.script) || !Array.isArray(row.files)) continue;
    for (const area of new Set(row.files.filter((f): f is string => typeof f === "string").map(areaOf))) {
      const key = `${area}\u0000${row.script}`;
      failures.set(key, (failures.get(key) ?? 0) + 1);
    }
  }
  const out: LearnedCandidate[] = [];
  for (const [key, n] of failures) {
    if (n < 2) continue;
    const [area, script] = key.split("\u0000") as [string, string];
    out.push({
      trigger: `editing ${area}`,
      action: `run \`npm run ${script}\` before finishing — it failed ${n} times after edits here`,
      domain: "testing",
      source: "verification",
      occurrences: n,
      confidence: confidenceFor(n),
      evidence: [`${OBSERVATIONS_PATH}: ${script} failed ${n} times after editing ${area}`],
    });
  }
  return out;
}

export interface LearnResult { added: Instinct[]; updated: Instinct[]; total: number }

/** Merge candidates into the store. Status (active/rejected) chosen by a human is never changed. */
export function mergeCandidates(existing: Instinct[], candidates: LearnedCandidate[], now: string): LearnResult & { instincts: Instinct[] } {
  const byId = new Map(existing.map(i => [i.id, { ...i }]));
  const added: Instinct[] = [];
  const updated: Instinct[] = [];
  for (const c of candidates) {
    if (!validText(c.trigger) || !validText(c.action)) continue;
    const id = instinctId(c.trigger, c.action);
    const current = byId.get(id);
    if (current) {
      if (current.occurrences === c.occurrences && current.confidence === c.confidence) continue;
      Object.assign(current, { occurrences: c.occurrences, confidence: c.confidence, evidence: c.evidence.slice(0, 10), updatedAt: now });
      updated.push(current);
    } else {
      const instinct: Instinct = { id, trigger: c.trigger, action: c.action, domain: c.domain, source: c.source, status: "candidate", confidence: c.confidence, occurrences: c.occurrences, evidence: c.evidence.slice(0, 10), createdAt: now, updatedAt: now };
      byId.set(id, instinct);
      added.push(instinct);
    }
  }
  return { instincts: [...byId.values()], added, updated, total: byId.size };
}

export async function learnInstincts(projectPath: string, options: { now?: () => Date; dryRun?: boolean; commits?: Array<{ subject: string; files: string[] }> } = {}): Promise<LearnResult> {
  const root = path.resolve(projectPath);
  const now = (options.now ?? (() => new Date()))().toISOString();
  const commits = options.commits ?? await readGitCommits(root);
  const candidates = [
    ...mineCoChange(commits),
    ...mineCommitConvention(commits),
    ...mineGuard(await readJsonLines(path.join(root, ".forge/session/guard.jsonl"))),
    ...mineVerification(await readJsonLines(path.join(root, OBSERVATIONS_PATH))),
  ];
  const result = mergeCandidates(await loadInstincts(root), candidates, now);
  if (!options.dryRun && (result.added.length || result.updated.length)) await saveInstincts(root, result.instincts);
  return { added: result.added, updated: result.updated, total: result.total };
}

export async function addManualInstinct(projectPath: string, trigger: string, action: string, options: { domain?: string; scope?: InstinctScope; now?: () => Date } = {}): Promise<Instinct> {
  if (!validText(trigger) || !validText(action)) throw new Error(`Trigger and action must be 1-${MAX_TEXT} characters and must not contain secrets.`);
  const scope = options.scope ?? "project";
  const now = (options.now ?? (() => new Date()))().toISOString();
  const instincts = await loadInstincts(projectPath, scope);
  const id = instinctId(trigger, action);
  const existing = instincts.find(i => i.id === id);
  if (existing) return existing;
  // A human wrote it, so it is active immediately.
  const instinct: Instinct = { id, trigger: trigger.trim(), action: action.trim(), domain: options.domain && /^[a-z0-9-]{1,32}$/.test(options.domain) ? options.domain : "general", source: "manual", status: "active", confidence: 0.9, occurrences: 1, evidence: ["added by the user"], createdAt: now, updatedAt: now };
  await saveInstincts(projectPath, [...instincts, instinct], scope);
  return instinct;
}

export async function setInstinctStatus(projectPath: string, ids: string[], status: InstinctStatus, options: { scope?: InstinctScope; now?: () => Date } = {}): Promise<Instinct[]> {
  const scope = options.scope ?? "project";
  const instincts = await loadInstincts(projectPath, scope);
  const now = (options.now ?? (() => new Date()))().toISOString();
  const changed: Instinct[] = [];
  for (const id of ids) {
    const instinct = instincts.find(i => i.id === id);
    if (!instinct) throw new Error(`No instinct "${id}" in the ${scope} store. List them with \`forge instinct list\`.`);
    if (instinct.status !== status) { instinct.status = status; instinct.updatedAt = now; changed.push(instinct); }
  }
  if (changed.length) await saveInstincts(projectPath, instincts, scope);
  return changed;
}

export async function removeInstinct(projectPath: string, id: string, scope: InstinctScope = "project"): Promise<boolean> {
  const instincts = await loadInstincts(projectPath, scope);
  const next = instincts.filter(i => i.id !== id);
  if (next.length === instincts.length) return false;
  await saveInstincts(projectPath, next, scope);
  return true;
}

export interface InstinctExport { tool: "forge-instincts"; version: 1; exportedAt: string; instincts: Instinct[] }

export async function exportInstincts(projectPath: string, options: { scope?: InstinctScope; status?: InstinctStatus; now?: () => Date } = {}): Promise<InstinctExport> {
  const instincts = (await loadInstincts(projectPath, options.scope ?? "project")).filter(i => !options.status || i.status === options.status);
  return { tool: "forge-instincts", version: 1, exportedAt: (options.now ?? (() => new Date()))().toISOString(), instincts };
}

/** Import from another project or teammate. Imported instincts are always candidates with capped confidence. */
export async function importInstincts(projectPath: string, payload: unknown, options: { scope?: InstinctScope; now?: () => Date } = {}): Promise<LearnResult> {
  const body = payload as Partial<InstinctExport> | null;
  if (!body || body.tool !== "forge-instincts" || body.version !== 1 || !Array.isArray(body.instincts)) throw new Error("Not a FORGE instinct export (expected tool \"forge-instincts\", version 1).");
  const now = (options.now ?? (() => new Date()))().toISOString();
  const candidates: LearnedCandidate[] = [];
  for (const raw of body.instincts.slice(0, MAX_INSTINCTS)) {
    const i = sanitize(raw, now);
    if (!i || i.status === "rejected") continue;
    candidates.push({ trigger: i.trigger, action: i.action, domain: i.domain, source: "import", occurrences: i.occurrences, confidence: Math.min(i.confidence, 0.6), evidence: [`imported ${now.slice(0, 10)}`, ...i.evidence.slice(0, 4)] });
  }
  const scope = options.scope ?? "project";
  const existing = await loadInstincts(projectPath, scope);
  const known = new Set(existing.map(i => i.id));
  // Never let an import change the trust or numbers of instincts that already exist locally.
  const result = mergeCandidates(existing, candidates.filter(c => !known.has(instinctId(c.trigger, c.action))), now);
  if (result.added.length) await saveInstincts(projectPath, result.instincts, scope);
  return { added: result.added, updated: [], total: result.total };
}

// ---------------------------------------------------------------------------
// Using instincts
// ---------------------------------------------------------------------------

export async function activeInstincts(projectPath: string, options: { includeGlobal?: boolean } = {}): Promise<Array<Instinct & { scope: InstinctScope }>> {
  const project = (await loadInstincts(projectPath).catch(() => [])).filter(i => i.status === "active").map(i => ({ ...i, scope: "project" as const }));
  if (!options.includeGlobal || path.resolve(projectPath) === globalMemoryRoot()) return project;
  const ids = new Set(project.map(i => i.id));
  const global = (await loadInstincts(projectPath, "global").catch(() => [])).filter(i => i.status === "active" && !ids.has(i.id)).map(i => ({ ...i, scope: "global" as const }));
  return [...project, ...global];
}

export function formatInstinctContext(instincts: Instinct[], limit = 15): string {
  if (!instincts.length) return "";
  const lines = ["Learned project instincts (approved by the user):"];
  for (const i of [...instincts].sort((a, b) => b.confidence - a.confidence).slice(0, limit)) lines.push(`- When ${i.trigger}: ${i.action}`);
  return lines.join("\n");
}

export function formatInstinctList(instincts: Instinct[]): string {
  if (!instincts.length) return "No instincts yet. Run `forge instinct learn` to mine git history and session observations.";
  const order: Record<InstinctStatus, number> = { active: 0, candidate: 1, rejected: 2 };
  const lines: string[] = [];
  for (const i of [...instincts].sort((a, b) => order[a.status] - order[b.status] || b.confidence - a.confidence)) {
    lines.push(`${i.id}  ${i.status.padEnd(9)} ${Math.round(i.confidence * 100).toString().padStart(3)}%  [${i.domain}/${i.source}]`);
    lines.push(`    When ${i.trigger}: ${i.action}`);
  }
  return lines.join("\n");
}

export const LEARNED_SKILL_MARKER = "<!-- Generated by `forge evolve` from approved instincts. -->";

export function renderLearnedSkill(instincts: Instinct[]): string {
  const byDomain = new Map<string, Instinct[]>();
  for (const i of instincts) byDomain.set(i.domain, [...(byDomain.get(i.domain) ?? []), i]);
  const lines = [
    "---",
    "name: forge-learned",
    "description: Project-specific habits learned from this repository's history and approved by the team. Use when editing, testing or committing in this project.",
    "---",
    "",
    LEARNED_SKILL_MARKER,
    "",
    "# Learned project instincts",
    "",
    "These behaviours were mined from this repository (git history, FORGE Guard and verification results) and approved with `forge instinct promote`. Verify each against the current code before relying on it.",
    "",
  ];
  for (const [domain, items] of [...byDomain].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## ${domain}`, "");
    for (const i of items.sort((a, b) => b.confidence - a.confidence)) lines.push(`- **When ${i.trigger}:** ${i.action} _(confidence ${Math.round(i.confidence * 100)}%, ${i.source})_`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

export interface EvolveResult { instincts: number; files: Array<{ path: string; action: "create" | "update" | "unchanged" | "skipped-user-edited" }> }

export const LEARNED_SKILL_PATHS = [".claude/skills/forge-learned/SKILL.md", ".agents/skills/forge-learned/SKILL.md"];

/** Compile active instincts into a skill for Claude Code and the shared .agents layout. */
export async function evolveInstincts(projectPath: string, options: { write?: boolean; force?: boolean; includeGlobal?: boolean } = {}): Promise<EvolveResult & { content: string }> {
  const root = path.resolve(projectPath);
  const active = await activeInstincts(root, { includeGlobal: options.includeGlobal ?? false });
  const content = renderLearnedSkill(active);
  const files: EvolveResult["files"] = [];
  for (const relative of LEARNED_SKILL_PATHS) {
    const absolute = path.join(root, relative);
    let current: string | undefined;
    try {
      if ((await lstat(absolute)).isSymbolicLink()) { files.push({ path: relative, action: "skipped-user-edited" }); continue; }
      current = await readFile(absolute, "utf8");
    } catch { current = undefined; }
    if (current === content) { files.push({ path: relative, action: "unchanged" }); continue; }
    if (current !== undefined && !current.includes(LEARNED_SKILL_MARKER) && !options.force) { files.push({ path: relative, action: "skipped-user-edited" }); continue; }
    files.push({ path: relative, action: current === undefined ? "create" : "update" });
    if (options.write && active.length) {
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");
    }
  }
  return { instincts: active.length, files, content };
}
