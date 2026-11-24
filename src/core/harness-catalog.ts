import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * FORGE harness catalog: the FORGE-authored agents, skills, commands and rules
 * that `forge install` writes into agent harnesses (Claude Code, Cursor, Codex,
 * OpenCode, Gemini). Every item is a Markdown file with simple frontmatter.
 */

export type CatalogKind = "agent" | "skill" | "command" | "rule";
export type InstallProfile = "minimal" | "standard" | "full";

export const INSTALL_PROFILES: readonly InstallProfile[] = ["minimal", "standard", "full"];

export interface CatalogItem {
  kind: CatalogKind;
  id: string;
  name: string;
  description: string;
  /** Lowest profile that includes this item. */
  profile: InstallProfile;
  tags: string[];
  /** Rules only: language/framework group, e.g. "common", "typescript". */
  language?: string;
  /** Rules only: file globs the rule applies to (Cursor `globs`). */
  globs?: string[];
  /** Agents only: Claude Code tool allow-list. */
  tools?: string[];
  /**
   * Skills, agents and commands: stacks the item is for (e.g. "python"). Installed only
   * when one of them is detected (or with --profile full), so projects get stack
   * guidance without loading every framework's skills into context.
   */
  languages?: string[];
  /** Commands only: argument hint shown by harnesses that support it. */
  argumentHint?: string;
  body: string;
  sourcePath: string;
}

export interface HarnessCatalog {
  root: string;
  items: CatalogItem[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_ITEM_BYTES = 64 * 1024;
const MAX_ITEMS = 2_000;

export function defaultCatalogRoot(): string {
  // Compiled: dist/core/harness-catalog.js. Source: src/core/harness-catalog.ts.
  // Both sit two levels below the package root, where `catalog/` lives.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "catalog");
}

export function parseFrontmatter(content: string): { metadata: Map<string, string>; body: string } {
  const normalized = content.replace(/^﻿/, "");
  const match = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) return { metadata: new Map(), body: normalized.trim() };
  const metadata = new Map<string, string>();
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const entry = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*?)\s*$/);
    if (!entry) continue;
    let value = (entry[2] ?? "").trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    metadata.set((entry[1] ?? "").toLowerCase(), value);
  }
  return { metadata, body: normalized.slice(match[0].length).trim() };
}

function list(value: string | undefined): string[] {
  return (value ?? "").split(",").map(item => item.trim()).filter(Boolean);
}

function parseProfile(value: string | undefined, sourcePath: string): InstallProfile {
  const profile = (value ?? "standard").trim().toLowerCase();
  if (!INSTALL_PROFILES.includes(profile as InstallProfile)) {
    throw new Error(`Catalog item ${sourcePath} has unknown profile "${profile}".`);
  }
  return profile as InstallProfile;
}

export function parseCatalogItem(kind: CatalogKind, id: string, content: string, sourcePath: string, language?: string): CatalogItem {
  if (!ID_PATTERN.test(id)) throw new Error(`Catalog item ${sourcePath} has an invalid id "${id}".`);
  if (language !== undefined && !ID_PATTERN.test(language)) throw new Error(`Catalog rule ${sourcePath} has an invalid language "${language}".`);
  const { metadata, body } = parseFrontmatter(content);
  const declaredId = metadata.get("id") ?? metadata.get("name-id");
  if (declaredId && declaredId !== id) throw new Error(`Catalog item ${sourcePath} declares id "${declaredId}" but its path implies "${id}".`);
  const description = metadata.get("description")?.trim();
  if (!description) throw new Error(`Catalog item ${sourcePath} is missing a description.`);
  if (!body) throw new Error(`Catalog item ${sourcePath} has no instructions.`);
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const item: CatalogItem = {
    kind,
    id,
    name: metadata.get("title") ?? heading ?? id,
    description,
    profile: parseProfile(metadata.get("profile"), sourcePath),
    tags: list(metadata.get("tags")).map(tag => tag.toLowerCase()),
    body,
    sourcePath,
  };
  if (language !== undefined) item.language = language;
  const globs = list(metadata.get("globs"));
  if (globs.length) item.globs = globs;
  const tools = list(metadata.get("tools"));
  if (tools.length) item.tools = tools;
  const languages = list(metadata.get("languages")).map(value => value.toLowerCase());
  if (languages.length) {
    if (kind === "rule") throw new Error(`Catalog rule ${sourcePath} uses "languages"; rules take their language from their folder.`);
    for (const value of languages) if (!ID_PATTERN.test(value)) throw new Error(`Catalog item ${sourcePath} has an invalid language "${value}".`);
    item.languages = languages;
  }
  const argumentHint = metadata.get("argument-hint");
  if (argumentHint) item.argumentHint = argumentHint;
  return item;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    const info = await lstat(target);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function readItem(file: string): Promise<string> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Catalog entry ${file} must be a regular file.`);
  if (info.size > MAX_ITEM_BYTES) throw new Error(`Catalog entry ${file} exceeds ${MAX_ITEM_BYTES} bytes.`);
  return readFile(file, "utf8");
}

async function markdownFiles(directory: string): Promise<string[]> {
  if (!(await isDirectory(directory))) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith(".md") && entry.name.toLowerCase() !== "readme.md")
    .map(entry => entry.name)
    .sort();
}

export async function loadHarnessCatalog(root = defaultCatalogRoot()): Promise<HarnessCatalog> {
  const items: CatalogItem[] = [];
  const relative = (file: string) => path.relative(root, file).split(path.sep).join("/");

  for (const name of await markdownFiles(path.join(root, "agents"))) {
    const file = path.join(root, "agents", name);
    items.push(parseCatalogItem("agent", name.slice(0, -3), await readItem(file), relative(file)));
  }
  for (const name of await markdownFiles(path.join(root, "commands"))) {
    const file = path.join(root, "commands", name);
    items.push(parseCatalogItem("command", name.slice(0, -3), await readItem(file), relative(file)));
  }
  const skillsRoot = path.join(root, "skills");
  if (await isDirectory(skillsRoot)) {
    for (const entry of (await readdir(skillsRoot, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort()) {
      const file = path.join(skillsRoot, entry, "SKILL.md");
      try {
        items.push(parseCatalogItem("skill", entry, await readItem(file), relative(file)));
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") throw new Error(`Catalog skill ${entry} is missing SKILL.md.`);
        throw error;
      }
    }
  }
  const rulesRoot = path.join(root, "rules");
  if (await isDirectory(rulesRoot)) {
    for (const language of (await readdir(rulesRoot, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort()) {
      for (const name of await markdownFiles(path.join(rulesRoot, language))) {
        const file = path.join(rulesRoot, language, name);
        items.push(parseCatalogItem("rule", name.slice(0, -3), await readItem(file), relative(file), language));
      }
    }
  }

  if (items.length > MAX_ITEMS) throw new Error(`Catalog has more than ${MAX_ITEMS} items.`);
  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.kind}:${item.language ?? ""}:${item.id}`;
    if (seen.has(key)) throw new Error(`Duplicate catalog item ${key}.`);
    seen.add(key);
  }
  return { root, items };
}

const PROFILE_RANK: Record<InstallProfile, number> = { minimal: 0, standard: 1, full: 2 };

export interface CatalogSelection {
  profile: InstallProfile;
  /** Rule languages to include besides "common". Undefined = all languages. */
  languages?: string[];
  kinds?: CatalogKind[];
}

export function selectCatalogItems(catalog: HarnessCatalog, selection: CatalogSelection): CatalogItem[] {
  const languages = selection.languages ? new Set(["common", ...selection.languages]) : undefined;
  return catalog.items.filter(item => {
    if (PROFILE_RANK[item.profile] > PROFILE_RANK[selection.profile]) return false;
    if (selection.kinds && !selection.kinds.includes(item.kind)) return false;
    if (item.kind === "rule" && languages && !languages.has(item.language ?? "common")) return false;
    if (item.languages && languages && !item.languages.some(language => languages.has(language))) return false;
    return true;
  });
}

/** Detect rule languages from well-known project marker files. */
export async function detectProjectLanguages(projectRoot: string): Promise<string[]> {
  const markers: Array<[string, string[]]> = [
    ["typescript", ["tsconfig.json", "package.json"]],
    ["python", ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"]],
    ["golang", ["go.mod"]],
    ["rust", ["Cargo.toml"]],
    ["java", ["pom.xml", "build.gradle", "build.gradle.kts"]],
    ["php", ["composer.json"]],
    ["ruby", ["Gemfile"]],
    ["swift", ["Package.swift"]],
  ];
  const found: string[] = [];
  for (const [language, files] of markers) {
    for (const file of files) {
      try {
        const info = await lstat(path.join(projectRoot, file));
        if (info.isFile()) { found.push(language); break; }
      } catch {
        // Marker absent.
      }
    }
  }
  try {
    const entries = await readdir(projectRoot);
    if (entries.some(name => /\.(?:csproj|sln|fsproj)$/i.test(name))) found.push("csharp");
    if (entries.some(name => name.endsWith(".xcodeproj"))) found.includes("swift") || found.push("swift");
  } catch {
    // Unreadable root: keep marker results.
  }
  try {
    const pkgInfo = await lstat(path.join(projectRoot, "package.json"));
    if (pkgInfo.isFile() && pkgInfo.size < 512 * 1024) {
      const pkg = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      if ("react" in deps || "next" in deps || "react-native" in deps) found.push("react");
    }
  } catch {
    // No or invalid package.json.
  }
  return [...new Set(found)];
}
