import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Claude Code status line: `forge statusline` reads the status JSON on stdin
 * and prints one line. It reads a few small files only (no git or Shield
 * processes), so it is safe to run on every refresh.
 *
 *   FORGE ▸ Opus │ ⎇ feat/x │ ✎ 3 unverified │ ✓ tests passed │ ⛨ 1 blocked │ ★ 4 instincts │ $0.42
 */

export interface StatusInput {
  session_id?: string;
  cwd?: string;
  model?: { id?: string; display_name?: string };
  workspace?: { current_dir?: string; project_dir?: string };
  cost?: { total_cost_usd?: number };
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    const text = await readFile(file, "utf8");
    return text.length > 1024 * 1024 ? undefined : JSON.parse(text) as T;
  } catch { return undefined; }
}

async function branch(root: string): Promise<string | undefined> {
  try {
    const head = (await readFile(path.join(root, ".git", "HEAD"), "utf8")).trim();
    const match = /^ref: refs\/heads\/(.+)$/.exec(head);
    return match ? match[1] : head.slice(0, 7);
  } catch { return undefined; }
}

async function guardBlocks(root: string, session: string | undefined): Promise<number> {
  if (!session) return 0;
  try {
    const text = await readFile(path.join(root, ".forge/session/guard.jsonl"), "utf8");
    return text.split("\n").slice(-500).filter(line => line.includes(`"session":${JSON.stringify(session)}`) && line.includes('"decision":"deny"')).length;
  } catch { return 0; }
}

export interface StatusParts { model?: string; branch?: string; unverified: number; verification?: string; blocked: number; instincts: number; costUsd?: number }

export async function collectStatus(input: StatusInput, fallbackCwd: string): Promise<StatusParts> {
  const candidate = path.resolve(input.workspace?.project_dir ?? input.workspace?.current_dir ?? input.cwd ?? fallbackCwd);
  const root = await realpath(candidate).catch(() => candidate);
  const edits = await readJson<{ files?: unknown[] }>(path.join(root, ".forge/session/edits.json"));
  const last = await readJson<{ results?: Array<{ script?: string; status?: string }> }>(path.join(root, ".forge/session/last-verification.json"));
  const instincts = await readJson<{ instincts?: Array<{ status?: string }> }>(path.join(root, ".forge/instincts.json"));
  const results = Array.isArray(last?.results) ? last.results : [];
  const failed = results.find(r => r.status !== "passed");
  const parts: StatusParts = {
    unverified: Array.isArray(edits?.files) ? edits.files.length : 0,
    blocked: await guardBlocks(root, input.session_id),
    instincts: Array.isArray(instincts?.instincts) ? instincts.instincts.filter(i => i.status === "active").length : 0,
  };
  const model = input.model?.display_name ?? input.model?.id;
  if (model) parts.model = model.slice(0, 40);
  const b = await branch(root);
  if (b) parts.branch = b.slice(0, 40);
  if (results.length) parts.verification = failed ? `✗ ${failed.script ?? "check"} ${failed.status ?? "failed"}` : `✓ ${results.map(r => r.script).join("+")} passed`;
  if (typeof input.cost?.total_cost_usd === "number" && Number.isFinite(input.cost.total_cost_usd)) parts.costUsd = input.cost.total_cost_usd;
  return parts;
}

export function formatStatusLine(parts: StatusParts): string {
  const segments = [`FORGE${parts.model ? ` ▸ ${parts.model}` : ""}`];
  if (parts.branch) segments.push(`⎇ ${parts.branch}`);
  segments.push(parts.unverified ? `✎ ${parts.unverified} unverified` : "✎ clean");
  if (parts.verification) segments.push(parts.verification);
  if (parts.blocked) segments.push(`⛨ ${parts.blocked} blocked`);
  if (parts.instincts) segments.push(`★ ${parts.instincts} instinct${parts.instincts === 1 ? "" : "s"}`);
  if (parts.costUsd !== undefined) segments.push(`$${parts.costUsd.toFixed(2)}`);
  return segments.join(" │ ");
}

export async function renderStatusLine(raw: string, fallbackCwd: string): Promise<string> {
  let input: StatusInput = {};
  try { if (raw.trim()) input = JSON.parse(raw) as StatusInput; } catch { /* render with defaults */ }
  return formatStatusLine(await collectStatus(input, fallbackCwd));
}
