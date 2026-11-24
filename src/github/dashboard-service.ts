import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeRepository, type RepoProfile } from "./repo-analysis.js";
import { computeRemoteDoctor, readRepository, remoteShield, runRemoteSetup, type AppContext, type RemoteDoctor } from "./app-handlers.js";
import { assessPullRequestRisk, type PullRequestRisk } from "./pr-risk.js";
import type { ShieldReport } from "../core/forge-shield.js";
import type { GitHubClient } from "./github-client.js";
import { HARNESS_CAPABILITIES, type CapabilitySupport } from "../core/harness-capabilities.js";
import type { DoctorReport } from "../core/harness-installer.js";
import { buildScorecard, type Scorecard } from "../core/harness-scorecard.js";
import { analyzeContext, type ContextReport } from "../core/context-budget.js";
import { mcpMatrix, type McpMatrixRow } from "../core/mcp-sync.js";

/**
 * Data for the hosted FORGE dashboard (forge-ecc.vercel.app/app).
 * Every function takes an installation client already scoped to one repository.
 */

export interface DashboardEvent { at: string; event: string; action: string; detail?: string; url?: string }

export interface RepoOverview {
  repository: { fullName: string; defaultBranch: string; private: boolean };
  generatedAt: string;
  profile: RepoProfile;
  setup: RemoteDoctor;
  shield: Pick<ShieldReport, "score" | "grade" | "summary" | "filesScanned" | "findings">;
  pulls: Array<{ number: number; title: string; url: string; author: string; draft: boolean; risk: Pick<PullRequestRisk, "score" | "level" | "reasons" | "stats" | "suggestedReviewers"> }>;
  history: DashboardEvent[];
  scorecard?: Pick<Scorecard, "total" | "max" | "percent" | "grade" | "categories" | "topActions">;
  memory: { committed: boolean; entries: MemoryCard[] };
  instincts: { committed: boolean; items: InstinctCard[] };
  loops: LoopCard[];
  harnesses: HarnessCard[];
  /** Context budget per harness, from committed instruction, rule, skill and MCP files. */
  context?: ContextCard;
  /** MCP servers per harness config committed to the repo. */
  mcp?: McpMatrixRow[];
}

export interface ContextCard { grade: ContextReport["grade"]; worst: number; harnesses: Array<{ harness: string; tokens: number; mcpServers: number; items: number; top: Array<{ file: string; tokens: number }> }>; findings: ContextReport["findings"]; partial: boolean }

/** Files that make up what agents load at session start (fetched for the Context tab). */
const CONTEXT_FILE = /^(?:CLAUDE\.md|\.claude\/CLAUDE\.md|AGENTS(?:\.override)?\.md|GEMINI\.md|\.github\/copilot-instructions\.md|\.cursorrules|\.mcp\.json|\.cursor\/mcp\.json|\.codex\/config\.toml|\.gemini\/settings\.json|\.vscode\/mcp\.json|opencode\.json|\.kiro\/settings\/mcp\.json|\.claude\/rules\/.+\.md|\.cursor\/rules\/.+\.mdc?|\.claude\/(?:agents|commands)\/.+\.md|\.claude\/skills\/[^/]+\/SKILL\.md|\.agents\/skills\/[^/]+\/SKILL\.md)$/;
const CONTEXT_PRIORITY = (file: string) => /^(?:CLAUDE|AGENTS|GEMINI)|copilot-instructions|cursorrules|mcp|config\.toml|settings\.json|opencode/.test(file) ? 0 : /rules\//.test(file) ? 1 : 2;
const MAX_CONTEXT_FILES = 120;

export async function remoteContext(client: GitHubClient, owner: string, repo: string, ref: string, entries: TreeEntry[]): Promise<{ context: ContextCard; mcp: McpMatrixRow[] }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-context-"));
  try {
    const candidates = entries.filter(e => e.type === "blob" && (e.size ?? 0) <= 256 * 1024 && CONTEXT_FILE.test(e.path)).sort((a, b) => CONTEXT_PRIORITY(a.path) - CONTEXT_PRIORITY(b.path) || a.path.localeCompare(b.path));
    const chosen = candidates.slice(0, MAX_CONTEXT_FILES);
    const texts = await Promise.all(chosen.map(async e => [e.path, await client.getFileText(owner, repo, e.path, ref).catch(() => undefined)] as const));
    for (const [file, body] of texts) {
      if (typeof body !== "string") continue;
      const target = path.join(root, ...file.split("/"));
      if (!target.startsWith(root + path.sep)) continue;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body, "utf8");
    }
    const report = await analyzeContext(root);
    const context: ContextCard = {
      grade: report.grade,
      worst: report.worst,
      harnesses: report.harnesses.filter(h => h.tokens > 0 || h.mcpServers > 0).map(h => ({ harness: h.harness, tokens: h.tokens, mcpServers: h.mcpServers, items: h.items.length, top: [...h.items].sort((a, b) => b.tokens - a.tokens).slice(0, 5).map(i => ({ file: i.file, tokens: i.tokens })) })),
      findings: report.findings.slice(0, 12),
      partial: candidates.length > chosen.length,
    };
    return { context, mcp: await mcpMatrix(root) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export interface MemoryCard { id: string; kind: string; content: string; source?: string; evidence: string[]; tags: string[]; updatedAt: string }
export interface InstinctCard { id: string; trigger: string; action: string; status: string; confidence: number; source: string; domain: string; occurrences: number }
export interface LoopCard { id: string; status: string; goal: string; agent: string; checks: string[]; iterations: number; lastChecks: Array<{ command: string; passed: boolean }>; integrity: string[]; createdAt: string; finishedAt?: string; reason: string }
export interface HarnessCard { target: string; name: string; detected: boolean; installed: boolean; guarded: boolean; capabilities: Record<string, CapabilitySupport> }

type TreeEntry = { path: string; type: string; sha?: string; size?: number };

const HARNESS_MARKERS: Record<string, RegExp> = {
  claude: /^(?:\.claude\/|CLAUDE\.md$)/,
  cursor: /^(?:\.cursor\/|\.cursorrules$)/,
  codex: /^(?:\.codex\/|AGENTS\.md$)/,
  opencode: /^(?:\.opencode\/|opencode\.json$)/,
  gemini: /^(?:\.gemini\/|GEMINI\.md$)/,
  copilot: /^\.github\/(?:copilot-instructions\.md$|instructions\/|prompts\/|agents\/)/,
  windsurf: /^(?:\.windsurf\/|\.windsurfrules$)/,
  kiro: /^\.kiro\//,
  cline: /^\.clinerules(?:\/|$)/,
  zed: /^(?:\.zed\/|\.rules$)/,
};

export function harnessCoverage(paths: string[], installedTargets: string[], hookTargets: string[] = []): HarnessCard[] {
  return HARNESS_CAPABILITIES.map(cap => ({
    target: cap.target,
    name: cap.displayName,
    detected: paths.some(p => HARNESS_MARKERS[cap.target]?.test(p) ?? false),
    installed: installedTargets.includes(cap.target),
    guarded: hookTargets.includes(cap.target),
    capabilities: { ...cap.capabilities },
  }));
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

export function parseMemoryCards(raw: string | undefined): MemoryCard[] {
  if (!raw) return [];
  try {
    const doc = JSON.parse(raw) as { entries?: unknown[] };
    if (!Array.isArray(doc.entries)) return [];
    return doc.entries.flatMap(value => {
      const e = value as Record<string, unknown>;
      if (!e || typeof e !== "object" || typeof e.id !== "string" || typeof e.kind !== "string" || typeof e.content !== "string") return [];
      return [{ id: e.id.slice(0, 80), kind: e.kind.slice(0, 20), content: text(e.content, 1200), ...(typeof e.source === "string" ? { source: e.source.slice(0, 20) } : {}), evidence: Array.isArray(e.evidence) ? e.evidence.filter((x): x is string => typeof x === "string").slice(0, 6).map(x => x.slice(0, 200)) : [], tags: Array.isArray(e.tags) ? e.tags.filter((x): x is string => typeof x === "string").slice(0, 8) : [], updatedAt: text(e.updatedAt, 40) || text(e.createdAt, 40) }];
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 40);
  } catch { return []; }
}

export function parseInstinctCards(raw: string | undefined): InstinctCard[] {
  if (!raw) return [];
  try {
    const doc = JSON.parse(raw) as { instincts?: unknown[] };
    if (!Array.isArray(doc.instincts)) return [];
    return doc.instincts.flatMap(value => {
      const i = value as Record<string, unknown>;
      if (!i || typeof i !== "object" || typeof i.id !== "string" || typeof i.trigger !== "string" || typeof i.action !== "string") return [];
      return [{ id: i.id.slice(0, 40), trigger: text(i.trigger, 400), action: text(i.action, 400), status: text(i.status, 12) || "candidate", confidence: typeof i.confidence === "number" ? Math.max(0, Math.min(1, i.confidence)) : 0, source: text(i.source, 20), domain: text(i.domain, 32), occurrences: typeof i.occurrences === "number" ? i.occurrences : 1 }];
    }).slice(0, 100);
  } catch { return []; }
}

export function parseLoopCard(raw: string | undefined): LoopCard | undefined {
  if (!raw) return undefined;
  try {
    const l = JSON.parse(raw) as Record<string, unknown>;
    if (typeof l.id !== "string" || typeof l.status !== "string") return undefined;
    const iterations = Array.isArray(l.iterations) ? l.iterations as Array<Record<string, unknown>> : [];
    const last = iterations.at(-1);
    const lastChecks = (Array.isArray(last?.checks) ? last.checks : Array.isArray((l.baseline as Record<string, unknown> | undefined)?.checks) ? (l.baseline as { checks: unknown[] }).checks : []) as Array<Record<string, unknown>>;
    return {
      id: l.id.slice(0, 60), status: l.status.slice(0, 20), goal: text(l.goal, 300), agent: text(l.agent, 20),
      checks: Array.isArray(l.checks) ? l.checks.filter((c): c is string => typeof c === "string").slice(0, 10).map(c => c.slice(0, 160)) : [],
      iterations: iterations.length,
      lastChecks: lastChecks.slice(0, 10).map(c => ({ command: text(c.command, 160), passed: c.passed === true })),
      integrity: [...new Set(iterations.flatMap(it => Array.isArray(it.integrity) ? (it.integrity as Array<Record<string, unknown>>).map(i => text(i.kind, 30)) : []))].filter(Boolean),
      createdAt: text(l.createdAt, 40), ...(typeof l.finishedAt === "string" ? { finishedAt: l.finishedAt.slice(0, 40) } : {}), reason: text(l.reason, 300),
    };
  } catch { return undefined; }
}

/** Files the scorecard reads for content; everything else only needs to exist. */
const SCORECARD_CONTENT = /^(?:package\.json|pyproject\.toml|\.claude\/settings\.json|\.forge\/memory\.json|\.forge\/instincts\.json|\.github\/workflows\/[^/]+\.ya?ml)$/;
const SCORECARD_EXISTS = /^(?:[^/]+|\.github\/(?:dependabot\.yml|renovate\.json|copilot-instructions\.md)|\.(?:claude|agents)\/skills\/forge-(?:project|learned)\/SKILL\.md|\.(?:windsurf|kiro|zed|cursor|codex|opencode|gemini|clinerules)\/[^/]+)$/;

export function doctorFromRemote(setup: RemoteDoctor, forgeVersion: string): DoctorReport {
  return {
    installed: setup.installed,
    healthy: setup.healthy,
    currentVersion: forgeVersion,
    ...(setup.state ? { forgeVersion: setup.state.forgeVersion, profile: setup.state.profile, targets: setup.state.targets, ...(setup.state.languages ? { languages: setup.state.languages } : {}), hooks: Boolean(setup.state.hooks), ...(setup.state.hookTargets ? { hookTargets: setup.state.hookTargets as NonNullable<DoctorReport["hookTargets"]> } : {}) } : {}),
    entries: [],
    summary: { ok: 0, missing: setup.missing.length, modified: 0, outdated: setup.outdated.length },
    recommendations: [],
  };
}

async function remoteScorecard(client: GitHubClient, owner: string, repo: string, ref: string, entries: TreeEntry[], doctor: DoctorReport, shield: ShieldReport, now: () => Date): Promise<Scorecard> {
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-score-"));
  try {
    const blobs = entries.filter(e => e.type === "blob" && (e.size ?? 0) <= 512 * 1024);
    const content = blobs.filter(e => SCORECARD_CONTENT.test(e.path)).slice(0, 40);
    const present = blobs.filter(e => !SCORECARD_CONTENT.test(e.path) && SCORECARD_EXISTS.test(e.path)).slice(0, 400);
    const texts = await Promise.all(content.map(async e => [e.path, await client.getFileText(owner, repo, e.path, ref).catch(() => undefined)] as const));
    const write = async (file: string, body: string) => {
      const target = path.join(root, ...file.split("/"));
      if (!target.startsWith(root + path.sep)) return;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body, "utf8");
    };
    for (const e of present) await write(e.path, "");
    for (const [file, body] of texts) if (typeof body === "string") await write(file, body);
    return await buildScorecard({ projectPath: root, forgeVersion: doctor.currentVersion, now, doctor, shield });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

interface PullSummary { number: number; title: string; html_url: string; draft?: boolean; user?: { login?: string } }

export async function buildRepoOverview(context: AppContext, owner: string, repo: string, history: DashboardEvent[] = []): Promise<RepoOverview> {
  const { client } = context;
  const repository = await client.getRepository(owner, repo);
  const ref = repository.default_branch;
  const data = await readRepository(client, owner, repo, ref);
  const files = data.entries.filter(entry => entry.type === "blob").map(entry => entry.path).filter(file => !/^\.forge\/|(?:^|\/)forge-[\w.-]+(?:\/SKILL)?\.(?:md|mdc|toml)$/.test(file));
  const profile = analyzeRepository({ name: `${owner}/${repo}`, files, manifests: data.manifests, commits: data.commits.map(commit => commit.message) });
  const blobPaths = new Set(data.entries.filter(entry => entry.type === "blob").map(entry => entry.path));
  const read = (file: string) => blobPaths.has(file) ? client.getFileText(owner, repo, file, ref).catch(() => undefined) : Promise.resolve(undefined);
  const loopFiles = [...blobPaths].filter(file => /^\.forge\/loops\/loop-[\w-]+\.json$/.test(file)).sort().reverse().slice(0, 8);
  const [setup, shield, pulls, memoryRaw, instinctsRaw, loopRaws] = await Promise.all([
    computeRemoteDoctor(context, owner, repo, { ref, entries: data.entries }),
    remoteShield(client, owner, repo, ref, data.entries),
    client.request<PullSummary[]>("GET", `${client.repo(owner, repo)}/pulls?state=open&per_page=6&sort=updated`).catch(() => [] as PullSummary[]),
    read(".forge/memory.json"),
    read(".forge/instincts.json"),
    Promise.all(loopFiles.map(read)),
  ]);
  const now = context.now ?? (() => new Date());
  const [scorecard, contextBudget] = await Promise.all([
    remoteScorecard(client, owner, repo, ref, data.entries, doctorFromRemote(setup, context.forgeVersion), shield, now).catch(() => undefined),
    remoteContext(client, owner, repo, ref, data.entries).catch(() => undefined),
  ]);
  const scoredPulls = await Promise.all(pulls.slice(0, 6).map(async pull => {
    const risk = assessPullRequestRisk(await client.listPullFiles(owner, repo, pull.number, 1).catch(() => []));
    return { number: pull.number, title: pull.title, url: pull.html_url, author: pull.user?.login ?? "", draft: Boolean(pull.draft), risk: { score: risk.score, level: risk.level, reasons: risk.reasons.slice(0, 5), stats: risk.stats, suggestedReviewers: risk.suggestedReviewers } };
  }));
  return {
    repository: { fullName: repository.full_name, defaultBranch: ref, private: repository.private },
    generatedAt: (context.now ?? (() => new Date()))().toISOString(),
    profile,
    setup,
    shield: { score: shield.score, grade: shield.grade, summary: shield.summary, filesScanned: shield.filesScanned, findings: shield.findings.slice(0, 50) },
    pulls: scoredPulls,
    history: history.slice(0, 25),
    ...(scorecard ? { scorecard: { total: scorecard.total, max: scorecard.max, percent: scorecard.percent, grade: scorecard.grade, categories: scorecard.categories, topActions: scorecard.topActions } } : {}),
    memory: { committed: blobPaths.has(".forge/memory.json"), entries: parseMemoryCards(memoryRaw) },
    instincts: { committed: blobPaths.has(".forge/instincts.json"), items: parseInstinctCards(instinctsRaw) },
    loops: loopRaws.map(parseLoopCard).filter((l): l is LoopCard => Boolean(l)),
    harnesses: harnessCoverage([...blobPaths], setup.state?.targets ?? [], setup.state?.hookTargets ?? []),
    ...(contextBudget ? { context: contextBudget.context, mcp: contextBudget.mcp } : {}),
  };
}

export type DashboardAction = "analyze" | "repair";

export async function runDashboardAction(context: AppContext, owner: string, repo: string, action: DashboardAction, login: string): Promise<{ url?: string; upToDate: boolean; created: number; updated: number; shieldScore: number }> {
  const permission = await context.client.getCollaboratorPermission(owner, repo, login);
  if (!["admin", "maintain", "write"].includes(permission)) throw new Error("You need write access to this repository to open FORGE pull requests.");
  const outcome = await runRemoteSetup(context, owner, repo, action);
  return { ...(outcome.pull ? { url: outcome.pull.html_url } : {}), upToDate: !outcome.pull, created: outcome.setup.created.length, updated: outcome.setup.updated.length, shieldScore: outcome.shield.score };
}

export function parseRepoFullName(value: unknown): { owner: string; repo: string } | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/);
  if (!match || match[2] === "." || match[2] === "..") return undefined;
  return { owner: match[1] as string, repo: match[2] as string };
}
