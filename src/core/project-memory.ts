import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";

export type ProjectMemoryKind = "decision" | "architecture" | "constraint" | "preference" | "fact" | "lesson" | "handoff";
export type ProjectMemorySource = "cli" | "hook" | "mcp" | "agent" | "import";
export const PROJECT_MEMORY_KINDS: readonly ProjectMemoryKind[] = ["decision", "architecture", "constraint", "preference", "fact", "lesson", "handoff"];

export interface ProjectMemoryEntry {
  id: string;
  kind: ProjectMemoryKind;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  /** Provenance: which surface wrote the entry. Absent on entries written before FORGE v2. */
  source?: ProjectMemorySource;
  /** Provenance: files, commits or URLs that support the entry. */
  evidence?: string[];
}

interface MemoryDocument {
  version: 1;
  entries: ProjectMemoryEntry[];
}

const MAX_ENTRIES = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MEMORY_KINDS = new Set<ProjectMemoryKind>(PROJECT_MEMORY_KINDS);
const MEMORY_SOURCES = new Set<ProjectMemorySource>(["cli", "hook", "mcp", "agent", "import"]);
const MAX_HANDOFFS = 5;
const MAX_CONTENT_LENGTH = 4000;
const SECRET_PATTERN = /(?:api[_-]?key|secret|password|access[_-]?token)\s*[:=]\s*\S+|\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[baprs]-[A-Za-z0-9-]{12,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

function memoryPath(projectPath: string): string {
  return path.join(path.resolve(projectPath), ".forge", "memory.json");
}

async function readDocument(projectPath: string): Promise<MemoryDocument> {
  try {
    const raw = await readFile(memoryPath(projectPath));
    if (raw.byteLength > MAX_FILE_BYTES) throw new Error("Project memory file exceeds the 2 MiB safety limit.");
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || !("version" in parsed) || parsed.version !== 1 || !("entries" in parsed) || !Array.isArray(parsed.entries)) {
      throw new Error("Project memory file has an unsupported format.");
    }
    if (parsed.entries.length > MAX_ENTRIES) throw new Error("Project memory file exceeds the entry limit.");
    const ids = new Set<string>();
    for (const value of parsed.entries) {
      if (!value || typeof value !== "object") throw new Error("Project memory contains an invalid entry.");
      const entry = value as Record<string, unknown>;
      if (typeof entry.id !== "string" || !/^mem-[a-z0-9-]{1,80}$/.test(entry.id) || ids.has(entry.id) ||
          typeof entry.kind !== "string" || !MEMORY_KINDS.has(entry.kind as ProjectMemoryKind) ||
          typeof entry.content !== "string" || !entry.content.trim() || entry.content.length > MAX_CONTENT_LENGTH ||
          !Array.isArray(entry.tags) || entry.tags.length > 12 ||
          !entry.tags.every(tag => typeof tag === "string" && tag.length > 0 && tag.length <= 64) ||
          typeof entry.createdAt !== "string" || !Number.isFinite(Date.parse(entry.createdAt)) ||
          typeof entry.updatedAt !== "string" || !Number.isFinite(Date.parse(entry.updatedAt)) ||
          (entry.source !== undefined && !MEMORY_SOURCES.has(entry.source as ProjectMemorySource)) ||
          (entry.evidence !== undefined && (!Array.isArray(entry.evidence) || entry.evidence.length > 8 || !entry.evidence.every(item => typeof item === "string" && item.length > 0 && item.length <= 300)))) {
        throw new Error("Project memory contains an invalid entry.");
      }
      ids.add(entry.id);
    }
    return parsed as MemoryDocument;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { version: 1, entries: [] };
    }
    throw error;
  }
}

async function withMemoryWriteLock<T>(projectPath: string, action: () => Promise<T>): Promise<T> {
  const directory = path.dirname(memoryPath(projectPath));
  await mkdir(directory, { recursive: true });
  const lock = path.join(directory, ".memory-write.lock");
  const token = randomUUID();
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error("Project memory is being changed by another or interrupted FORGE process. Inspect .forge/.memory-write.lock before manual recovery.");
    }
    throw error;
  }
  try {
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({
      token, pid: process.pid, startedAt: new Date().toISOString(),
    }) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    return await action();
  } finally {
    try {
      const owner: unknown = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8"));
      if (owner && typeof owner === "object" && "token" in owner && owner.token === token) {
        await rm(lock, { recursive: true, force: true });
      }
    } catch {
      // Leave an unverifiable lock in place; manual inspection is safer than deleting another owner's lock.
    }
  }
}

async function writeDocument(projectPath: string, document: MemoryDocument): Promise<void> {
  const destination = memoryPath(projectPath);
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, ".memory-" + randomUUID() + ".tmp");
  try {
    await writeFile(temporary, JSON.stringify(document, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function validateContent(content: string): string {
  const value = content.trim();
  if (!value) throw new Error("Memory content cannot be empty.");
  if (value.length > MAX_CONTENT_LENGTH) throw new Error(`Memory content must be at most ${MAX_CONTENT_LENGTH} characters.`);
  if (SECRET_PATTERN.test(value)) throw new Error("Memory appears to contain a credential. Store a reference to a secret name, never the secret value.");
  return value;
}

function validateEvidence(evidence: string[] | undefined): string[] | undefined {
  if (evidence === undefined) return undefined;
  if (!Array.isArray(evidence) || evidence.some(item => typeof item !== "string" || !item.trim() || item.length > 300)) throw new Error("Memory evidence must be up to 8 non-empty strings of at most 300 characters.");
  const values = [...new Set(evidence.map(item => item.trim()))].slice(0, 8);
  if (values.some(item => SECRET_PATTERN.test(item))) throw new Error("Memory evidence appears to contain a credential.");
  return values.length ? values : undefined;
}

export async function addProjectMemory(
  projectPath: string,
  input: { kind: ProjectMemoryKind; content: string; tags?: string[]; source?: ProjectMemorySource; evidence?: string[] },
): Promise<ProjectMemoryEntry> {
  if (!input || !MEMORY_KINDS.has(input.kind)) throw new Error("Memory kind is not supported.");
  if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.some(tag => typeof tag !== "string" || tag.trim().length > 64))) {
    throw new Error("Memory tags must be strings of at most 64 characters.");
  }
  const content = validateContent(input.content);
  if (input.source !== undefined && !MEMORY_SOURCES.has(input.source)) throw new Error("Memory source is not supported.");
  const evidence = validateEvidence(input.evidence);
  return withMemoryWriteLock(projectPath, async () => {
    const document = await readDocument(projectPath);
    if (input.kind === "handoff") {
      const handoffs = document.entries.filter(entry => entry.kind === "handoff").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const drop = new Set(handoffs.slice(MAX_HANDOFFS - 1).map(entry => entry.id));
      document.entries = document.entries.filter(entry => !drop.has(entry.id));
    }
    if (document.entries.length >= MAX_ENTRIES) throw new Error(`Project memory is limited to ${MAX_ENTRIES} entries. Remove old entries first.`);
    const now = new Date().toISOString();
    const entry: ProjectMemoryEntry = {
      id: "mem-" + randomUUID(),
      kind: input.kind,
      content,
      tags: [...new Set((input.tags ?? []).map(tag => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 12),
      createdAt: now,
      updatedAt: now,
      ...(input.source ? { source: input.source } : {}),
      ...(evidence ? { evidence } : {}),
    };
    document.entries.push(entry);
    await writeDocument(projectPath, document);
    return entry;
  });
}

export async function listProjectMemory(projectPath: string): Promise<ProjectMemoryEntry[]> {
  const document = await readDocument(projectPath);
  return [...document.entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function removeProjectMemory(projectPath: string, id: string): Promise<boolean> {
  return withMemoryWriteLock(projectPath, async () => {
    const document = await readDocument(projectPath);
    const remaining = document.entries.filter(entry => entry.id !== id);
    if (remaining.length === document.entries.length) return false;
    document.entries = remaining;
    await writeDocument(projectPath, document);
    return true;
  });
}

/** Select relevant notes with a conservative character budget (~4 chars/token). */
export async function buildProjectMemoryContext(
  projectPath: string,
  query: string,
  maxTokens = 1800,
): Promise<{ text: string; includedIds: string[]; estimatedTokens: number }> {
  const safeBudget = Math.max(100, Math.min(8000, Math.floor(maxTokens)));
  const terms = new Set(query.toLowerCase().split(/[^a-z0-9_-]+/).filter(term => term.length > 2));
  const entries = (await listProjectMemory(projectPath)).filter(entry => entry.kind !== "handoff");
  const ranked = entries.map(entry => {
    const haystack = (entry.content + " " + entry.tags.join(" ")).toLowerCase();
    const score = entry.tags.reduce((sum, tag) => sum + (terms.has(tag) ? 4 : 0), 0)
      + [...terms].reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
    return { entry, score };
  }).sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt));

  const lines: string[] = [];
  const includedIds: string[] = [];
  let chars = 0;
  for (const { entry } of ranked) {
    const line = `[${entry.kind}] ${entry.content}`;
    const next = chars + line.length + 1;
    if (next > safeBudget * 4) continue;
    lines.push(line);
    includedIds.push(entry.id);
    chars = next;
  }
  return {
    text: lines.length ? "Relevant project memory (local notes; verify against current code):\n" + lines.join("\n") : "",
    includedIds,
    estimatedTokens: Math.ceil(chars / 4),
  };
}


export interface MemorySearchHit { entry: ProjectMemoryEntry; score: number; layer: "project" | "global" }

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9_]+/).filter(term => term.length > 2);
}

/**
 * Rank entries with BM25-style term weighting, tag boosts, kind boosts and recency decay.
 * Pure function so ranking can be tested without the filesystem.
 */
export function rankMemory(entries: readonly ProjectMemoryEntry[], query: string, options: { now?: Date; layer?: "project" | "global" } = {}): MemorySearchHit[] {
  const terms = [...new Set(tokenize(query))];
  const now = (options.now ?? new Date()).getTime();
  const documents = entries.map(entry => tokenize(entry.content + " " + entry.tags.join(" ")));
  const averageLength = documents.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, documents.length) || 1;
  const documentFrequency = new Map(terms.map(term => [term, documents.filter(doc => doc.includes(term)).length]));
  return entries.map((entry, index) => {
    const doc = documents[index] ?? [];
    let score = 0;
    for (const term of terms) {
      const frequency = doc.filter(word => word === term).length;
      if (!frequency) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (entries.length - df + 0.5) / (df + 0.5));
      score += idf * (frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * doc.length / averageLength));
      if (entry.tags.includes(term)) score += 1.5;
    }
    if (entry.kind === "constraint" || entry.kind === "decision") score *= 1.15;
    const ageDays = Math.max(0, (now - Date.parse(entry.updatedAt)) / 86_400_000);
    const recency = 1 / (1 + ageDays / 90);
    const total = terms.length ? score * (0.7 + 0.3 * recency) : recency;
    return { entry, score: Number(total.toFixed(4)), layer: options.layer ?? "project" };
  }).filter(hit => !terms.length || hit.score > 0).sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt));
}

/** Global (cross-project) memory lives in FORGE_HOME (default: the user's home directory) /.forge/memory.json. */
export function globalMemoryRoot(): string {
  return path.resolve(process.env.FORGE_HOME ?? homedir());
}

export async function searchMemory(projectPath: string, query: string, options: { limit?: number; includeGlobal?: boolean; kinds?: ProjectMemoryKind[] } = {}): Promise<MemorySearchHit[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 10)));
  const filter = (entries: ProjectMemoryEntry[]) => options.kinds?.length ? entries.filter(entry => options.kinds?.includes(entry.kind)) : entries;
  const hits = rankMemory(filter(await listProjectMemory(projectPath)), query, { layer: "project" });
  if (options.includeGlobal) {
    const globalRoot = globalMemoryRoot();
    if (path.resolve(projectPath) !== globalRoot) {
      // Project memory outranks global memory on ties; global entries are discounted slightly.
      hits.push(...rankMemory(filter(await listProjectMemory(globalRoot)), query, { layer: "global" }).map(hit => ({ ...hit, score: Number((hit.score * 0.85).toFixed(4)) })));
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function latestHandoff(projectPath: string): Promise<ProjectMemoryEntry | undefined> {
  return (await listProjectMemory(projectPath)).find(entry => entry.kind === "handoff");
}
