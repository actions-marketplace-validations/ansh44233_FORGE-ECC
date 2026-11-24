import { appendFile, lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Session cost tracking.
 *
 * Token counts are exact: they are summed from the `usage` blocks Claude Code
 * writes to the session transcript. Dollar amounts are estimates from a rate
 * table (USD per million tokens) that the user can override in
 * `.forge/harness-hooks.json` → `cost.pricing`.
 */

export const COSTS_PATH = ".forge/session/costs.jsonl";
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

export interface ModelRate { input: number; output: number; cacheWrite?: number; cacheRead?: number }

/** Default estimate rates by model family (USD per million tokens). Override per project. */
export const DEFAULT_RATES: Record<string, ModelRate> = {
  opus: { input: 5, output: 25 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
};

export interface TokenUsage { input: number; output: number; cacheWrite: number; cacheRead: number }

export interface SessionCost {
  at: string;
  session: string;
  models: Record<string, TokenUsage>;
  tokens: TokenUsage;
  /** Estimated USD; undefined when no rate matches a model that was used. */
  estimatedUsd?: number;
  turns: number;
}

const zero = (): TokenUsage => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** Sum usage per model from a Claude Code JSONL transcript. Duplicate message ids are counted once. */
export function parseTranscriptUsage(text: string): { models: Record<string, TokenUsage>; turns: number } {
  const models: Record<string, TokenUsage> = {};
  const seen = new Set<string>();
  let turns = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes("usage")) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const message = (row.message && typeof row.message === "object" ? row.message : row) as Record<string, unknown>;
    const usage = message.usage as Record<string, unknown> | undefined;
    if (!usage || typeof usage !== "object") continue;
    const id = typeof message.id === "string" ? message.id : typeof row.uuid === "string" ? row.uuid : undefined;
    if (id) { if (seen.has(id)) continue; seen.add(id); }
    const model = typeof message.model === "string" && message.model.length <= 80 ? message.model : "unknown";
    const totals = models[model] ??= zero();
    totals.input += num(usage.input_tokens);
    totals.output += num(usage.output_tokens);
    totals.cacheWrite += num(usage.cache_creation_input_tokens);
    totals.cacheRead += num(usage.cache_read_input_tokens);
    turns += 1;
  }
  return { models, turns };
}

export function rateFor(model: string, rates: Record<string, ModelRate> = DEFAULT_RATES): ModelRate | undefined {
  const lower = model.toLowerCase();
  if (rates[lower]) return rates[lower];
  // Longest matching family key wins, so "claude-sonnet" beats "sonnet".
  const key = Object.keys(rates).filter(k => lower.includes(k.toLowerCase())).sort((a, b) => b.length - a.length)[0];
  return key ? rates[key] : undefined;
}

export function estimateUsd(models: Record<string, TokenUsage>, rates: Record<string, ModelRate> = DEFAULT_RATES): number | undefined {
  let total = 0;
  for (const [model, usage] of Object.entries(models)) {
    const rate = rateFor(model, rates);
    if (!rate) return undefined;
    total += (usage.input * rate.input + usage.output * rate.output + usage.cacheWrite * (rate.cacheWrite ?? rate.input * 1.25) + usage.cacheRead * (rate.cacheRead ?? rate.input * 0.1)) / 1_000_000;
  }
  return Math.round(total * 10_000) / 10_000;
}

export function sumUsage(models: Record<string, TokenUsage>): TokenUsage {
  const t = zero();
  for (const u of Object.values(models)) { t.input += u.input; t.output += u.output; t.cacheWrite += u.cacheWrite; t.cacheRead += u.cacheRead; }
  return t;
}

/** Parse rate overrides from hook config, ignoring anything malformed. */
export function parseRates(value: unknown): Record<string, ModelRate> {
  const rates: Record<string, ModelRate> = { ...DEFAULT_RATES };
  if (!value || typeof value !== "object" || Array.isArray(value)) return rates;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
    if (!/^[\w.:-]{1,80}$/.test(key) || !raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const ok = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 10_000;
    if (!ok(r.input) || !ok(r.output)) continue;
    rates[key.toLowerCase()] = { input: r.input as number, output: r.output as number, ...(ok(r.cacheWrite) ? { cacheWrite: r.cacheWrite as number } : {}), ...(ok(r.cacheRead) ? { cacheRead: r.cacheRead as number } : {}) };
  }
  return rates;
}

/** Read a transcript the hook was pointed at; refuses symlinks and oversized files. */
export async function readTranscript(transcriptPath: string): Promise<string | undefined> {
  try {
    const info = await lstat(transcriptPath);
    if (!info.isFile() || info.size > MAX_TRANSCRIPT_BYTES) return undefined;
    return await readFile(transcriptPath, "utf8");
  } catch { return undefined; }
}

export async function recordSessionCost(root: string, session: string, transcriptPath: string, options: { now: Date; rates?: Record<string, ModelRate> }): Promise<SessionCost | undefined> {
  const text = await readTranscript(transcriptPath);
  if (text === undefined) return undefined;
  const { models, turns } = parseTranscriptUsage(text);
  if (!turns) return undefined;
  const estimatedUsd = estimateUsd(models, options.rates);
  const row: SessionCost = { at: options.now.toISOString(), session: session.slice(0, 120), models, tokens: sumUsage(models), turns, ...(estimatedUsd !== undefined ? { estimatedUsd } : {}) };
  try {
    const file = path.join(root, COSTS_PATH);
    await mkdir(path.dirname(file), { recursive: true });
    try { if ((await lstat(file)).size > 8 * 1024 * 1024) return row; } catch { /* new file */ }
    await appendFile(file, JSON.stringify(row) + "\n", "utf8");
  } catch { /* cost logging never breaks a hook */ }
  return row;
}

export interface CostReport {
  sessions: number;
  since?: string;
  tokens: TokenUsage;
  estimatedUsd?: number;
  unpricedSessions: number;
  byModel: Record<string, TokenUsage>;
  byDay: Array<{ day: string; sessions: number; tokens: number; estimatedUsd: number }>;
  top: SessionCost[];
}

/** Latest row per session wins: each Stop records the session's cumulative totals. */
export async function buildCostReport(root: string, options: { since?: Date } = {}): Promise<CostReport> {
  let text = "";
  try { text = await readFile(path.join(root, COSTS_PATH), "utf8"); } catch { /* no data yet */ }
  const latest = new Map<string, SessionCost>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as SessionCost;
      if (typeof row.session !== "string" || typeof row.at !== "string" || !row.tokens) continue;
      if (options.since && Date.parse(row.at) < options.since.getTime()) continue;
      const prev = latest.get(row.session);
      if (!prev || Date.parse(prev.at) <= Date.parse(row.at)) latest.set(row.session, row);
    } catch { /* skip malformed */ }
  }
  const rows = [...latest.values()];
  const byModel: Record<string, TokenUsage> = {};
  const days = new Map<string, { sessions: number; tokens: number; estimatedUsd: number }>();
  let usd = 0;
  let unpriced = 0;
  for (const row of rows) {
    for (const [model, u] of Object.entries(row.models ?? {})) {
      const t = byModel[model] ??= zero();
      t.input += num(u.input); t.output += num(u.output); t.cacheWrite += num(u.cacheWrite); t.cacheRead += num(u.cacheRead);
    }
    if (typeof row.estimatedUsd === "number") usd += row.estimatedUsd; else unpriced += 1;
    const day = row.at.slice(0, 10);
    const d = days.get(day) ?? { sessions: 0, tokens: 0, estimatedUsd: 0 };
    d.sessions += 1;
    d.tokens += num(row.tokens.input) + num(row.tokens.output) + num(row.tokens.cacheWrite) + num(row.tokens.cacheRead);
    d.estimatedUsd = Math.round((d.estimatedUsd + (row.estimatedUsd ?? 0)) * 10_000) / 10_000;
    days.set(day, d);
  }
  return {
    sessions: rows.length,
    ...(options.since ? { since: options.since.toISOString() } : {}),
    tokens: sumUsage(byModel),
    ...(rows.length && unpriced < rows.length ? { estimatedUsd: Math.round(usd * 10_000) / 10_000 } : {}),
    unpricedSessions: unpriced,
    byModel,
    byDay: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, d]) => ({ day, ...d })),
    top: rows.sort((a, b) => (b.estimatedUsd ?? 0) - (a.estimatedUsd ?? 0)).slice(0, 5),
  };
}

const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

export function formatCostReport(report: CostReport): string {
  if (!report.sessions) return "No session costs recorded yet. Install hooks with `forge install --hooks`; costs are recorded when a Claude Code session stops.";
  const t = report.tokens;
  const lines = [
    `FORGE cost report — ${report.sessions} session(s)${report.since ? ` since ${report.since.slice(0, 10)}` : ""}`,
    "",
    `  tokens   input ${fmt(t.input)} · output ${fmt(t.output)} · cache write ${fmt(t.cacheWrite)} · cache read ${fmt(t.cacheRead)}`,
    `  estimate ${report.estimatedUsd !== undefined ? `$${report.estimatedUsd.toFixed(2)}` : "n/a"}${report.unpricedSessions ? ` (${report.unpricedSessions} session(s) used a model without a rate)` : ""}`,
    "",
    "  by model",
  ];
  for (const [model, u] of Object.entries(report.byModel).sort(([, a], [, b]) => (b.input + b.output) - (a.input + a.output))) lines.push(`    ${model.padEnd(34)} in ${fmt(u.input).padStart(7)}  out ${fmt(u.output).padStart(7)}  cache ${fmt(u.cacheRead + u.cacheWrite).padStart(7)}`);
  if (report.byDay.length > 1) {
    lines.push("", "  by day");
    for (const d of report.byDay.slice(-14)) lines.push(`    ${d.day}  ${String(d.sessions).padStart(3)} session(s)  ${fmt(d.tokens).padStart(7)} tokens  $${d.estimatedUsd.toFixed(2)}`);
  }
  lines.push("", "Dollar figures are estimates from default rates; set exact rates in .forge/harness-hooks.json → cost.pricing.");
  return lines.join("\n");
}
