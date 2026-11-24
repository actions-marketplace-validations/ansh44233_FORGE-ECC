import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { addClaudeHooks, claudeHookEntries, readSettingsFile, removeClaudeHooks, statusLineCommand } from "./harness-hooks.js";
import { HARNESS_CAPABILITIES } from "./harness-capabilities.js";
import {
  detectProjectLanguages,
  INSTALL_PROFILES,
  loadHarnessCatalog,
  selectCatalogItems,
  type CatalogItem,
  type HarnessCatalog,
  type InstallProfile,
} from "./harness-catalog.js";

/**
 * Universal harness installer. Renders the FORGE catalog into the native
 * formats of supported agent harnesses, tracks every written file by hash and
 * never overwrites or deletes content the user has changed.
 */

export type HarnessTarget = "claude" | "cursor" | "codex" | "opencode" | "gemini" | "copilot" | "windsurf" | "kiro" | "cline" | "zed";
/** Installer targets are derived from the versioned capability manifest. */
export const HARNESS_TARGETS: readonly HarnessTarget[] = HARNESS_CAPABILITIES.map(item => item.target);
/** Targets installed when none are requested; harnesses detected in the project are added by the CLI. */
export const DEFAULT_TARGETS: readonly HarnessTarget[] = ["claude", "cursor", "codex", "opencode", "gemini"];

/** Project markers that show a harness is in use, so `forge install` can include it automatically. */
const TARGET_MARKERS: Array<[HarnessTarget, string[]]> = [
  ["copilot", [".github/copilot-instructions.md", ".github/instructions", ".github/prompts"]],
  ["windsurf", [".windsurf", ".windsurfrules"]],
  ["kiro", [".kiro"]],
  ["cline", [".clinerules"]],
  ["zed", [".zed", ".rules"]],
];

/** Harnesses beyond the defaults that the project already uses. */
export async function detectHarnessTargets(projectPath: string): Promise<HarnessTarget[]> {
  const found: HarnessTarget[] = [];
  for (const [target, markers] of TARGET_MARKERS) {
    for (const marker of markers) {
      try { await lstat(path.join(projectPath, marker)); found.push(target); break; } catch { /* not present */ }
    }
  }
  return found;
}

function normalizeHarnessTargets(targets: readonly string[]): HarnessTarget[] {
  const supported = new Set<string>(HARNESS_TARGETS);
  for (const target of targets) {
    if (!supported.has(target)) {
      throw new Error(`Unknown target "${target}". Supported: ${HARNESS_TARGETS.join(", ")}, default, all.`);
    }
  }
  return [...new Set(targets)] as HarnessTarget[];
}

export const STATE_SCHEMA = 2;
export const INSTALL_STATE_PATH = ".forge/install-state.json";
const LEGACY_STATE_SCHEMA_VERSION = 1;
const STATE_SCHEMA_VERSION = STATE_SCHEMA;
const BLOCK_BEGIN = "<!-- forge:begin (managed by `forge install`; edit outside this block) -->";
const BLOCK_END = "<!-- forge:end -->";

export interface PlannedFile {
  path: string;
  content: string;
  targets: HarnessTarget[];
  item?: string;
}

export interface PlannedBlock {
  path: string;
  content: string;
  targets: HarnessTarget[];
}

export interface InstallPlan {
  profile: InstallProfile;
  targets: HarnessTarget[];
  languages: string[];
  files: PlannedFile[];
  blocks: PlannedBlock[];
  itemCount: number;
}

export interface InstallStateFile { path: string; sha256: string; targets: HarnessTarget[]; item?: string }
export interface InstallStateBlock { path: string; sha256: string; targets: HarnessTarget[]; createdFile: boolean }

export interface InstallStateSettings { path: string; commands: string[]; addedDeny: string[]; createdFile: boolean }

export interface InstallState {
  schemaVersion: number;
  forgeVersion: string;
  installedAt: string;
  profile: InstallProfile;
  targets: HarnessTarget[];
  languages: string[];
  files: InstallStateFile[];
  blocks: InstallStateBlock[];
  /** Claude Code hook commands merged into .claude/settings.json by `--hooks`. */
  settings?: InstallStateSettings;
}

export type FileAction = "create" | "update" | "unchanged" | "conflict" | "remove" | "keep-modified" | "overwrite";

export interface InstallChange { path: string; action: FileAction; detail?: string }

export interface InstallResult {
  dryRun: boolean;
  plan: InstallPlan;
  changes: InstallChange[];
  conflicts: number;
  statePath: string;
}

export interface InstallOptions {
  projectPath: string;
  targets?: HarnessTarget[];
  profile?: InstallProfile;
  /** Rule languages. Undefined = auto-detect from project markers. */
  languages?: string[];
  dryRun?: boolean;
  force?: boolean;
  forgeVersion: string;
  catalog?: HarnessCatalog;
  now?: () => Date;
  /** Merge FORGE runtime hooks (guard, config guard, verify, session memory) into Claude Code settings. */
  hooks?: boolean;
  /** Also set FORGE as the Claude Code status line (never replaces an existing one). Requires hooks. */
  statusLine?: boolean;
  /** Executable used in hook commands. Default "forge". */
  hookCommand?: string;
}

const CLAUDE_SETTINGS_PATH = ".claude/settings.json";

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function parseTargets(value: string | undefined): HarnessTarget[] {
  if (!value || value === "all") return [...HARNESS_TARGETS];
  if (value === "default") return [...DEFAULT_TARGETS];
  const targets = value.split(",").map(item => item.trim().toLowerCase()).filter(Boolean);
  return normalizeHarnessTargets(targets);
}

export function parseProfile(value: string | undefined): InstallProfile {
  const profile = (value ?? "standard").toLowerCase();
  if (!INSTALL_PROFILES.includes(profile as InstallProfile)) throw new Error(`Unknown profile "${profile}". Supported: ${INSTALL_PROFILES.join(", ")}.`);
  return profile as InstallProfile;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function yamlValue(value: string): string {
  return /^[\w .,()/'-]*$/.test(value) && !value.includes(": ") ? value : JSON.stringify(value);
}

function frontmatter(entries: Array<[string, string | undefined]>): string {
  const lines = entries.filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => `${key}: ${yamlValue(value as string)}`);
  return `---\n${lines.join("\n")}\n---\n\n`;
}

const GENERATED_NOTE = (item: CatalogItem) => `<!-- Generated by FORGE from catalog/${item.sourcePath}. Re-run \`forge install\` to update. -->\n\n`;

function claudeFiles(item: CatalogItem): PlannedFile[] {
  const note = GENERATED_NOTE(item);
  switch (item.kind) {
    case "agent":
      return [{ path: `.claude/agents/forge-${item.id}.md`, content: frontmatter([["name", `forge-${item.id}`], ["description", item.description], ["tools", item.tools?.join(", ")]]) + note + item.body + "\n", targets: ["claude"] }];
    case "skill":
      return [{ path: `.claude/skills/forge-${item.id}/SKILL.md`, content: frontmatter([["name", `forge-${item.id}`], ["description", item.description]]) + note + item.body + "\n", targets: ["claude"] }];
    case "command":
      return [{ path: `.claude/commands/forge/${item.id}.md`, content: frontmatter([["description", item.description], ["argument-hint", item.argumentHint]]) + note + item.body + "\n", targets: ["claude"] }];
    case "rule":
      return [{ path: `.claude/rules/forge/${item.language ?? "common"}/${item.id}.md`, content: (item.globs ? frontmatter([["paths", item.globs.join(", ")]]) : "") + note + item.body + "\n", targets: ["claude"] }];
  }
}

function cursorFiles(item: CatalogItem): PlannedFile[] {
  const note = GENERATED_NOTE(item);
  if (item.kind === "command") {
    return [{ path: `.cursor/commands/forge-${item.id}.md`, content: note + item.body + "\n", targets: ["cursor"] }];
  }
  const prefix = item.kind === "rule" ? `forge-${item.language ?? "common"}` : `forge-${item.kind}`;
  const alwaysApply = item.kind === "rule" && (item.language ?? "common") === "common" && !item.globs;
  const description = item.kind === "agent" ? `Act as the FORGE ${item.name}: ${item.description}` : item.description;
  return [{
    path: `.cursor/rules/${prefix}-${item.id}.mdc`,
    content: frontmatter([["description", description], ["globs", item.globs?.join(",")], ["alwaysApply", alwaysApply ? "true" : "false"]]) + note + item.body + "\n",
    targets: ["cursor"],
  }];
}

/** Shared Markdown copies referenced from AGENTS.md / GEMINI.md. */
function sharedFile(item: CatalogItem, target: HarnessTarget): PlannedFile | undefined {
  const folder = item.kind === "rule" ? `rules/${item.language ?? "common"}` : `${item.kind}s`;
  if (item.kind === "skill") return undefined;
  return { path: `.forge/harness/${folder}/${item.id}.md`, content: GENERATED_NOTE(item) + item.body + "\n", targets: [target] };
}

function sharedSkill(item: CatalogItem, target: HarnessTarget): PlannedFile {
  return { path: `.agents/skills/forge-${item.id}/SKILL.md`, content: frontmatter([["name", `forge-${item.id}`], ["description", item.description]]) + GENERATED_NOTE(item) + item.body + "\n", targets: [target] };
}

function opencodeFiles(item: CatalogItem): PlannedFile[] {
  const note = GENERATED_NOTE(item);
  if (item.kind === "agent") return [{ path: `.opencode/agent/forge-${item.id}.md`, content: frontmatter([["description", item.description], ["mode", "subagent"]]) + note + item.body + "\n", targets: ["opencode"] }];
  if (item.kind === "command") return [{ path: `.opencode/command/forge-${item.id}.md`, content: frontmatter([["description", item.description]]) + note + item.body + "\n", targets: ["opencode"] }];
  return [];
}

function geminiFiles(item: CatalogItem): PlannedFile[] {
  if (item.kind !== "command") return [];
  // JSON string escapes are a subset of TOML basic-string escapes.
  // Gemini CLI substitutes `{{args}}` where Claude Code and OpenCode use `$ARGUMENTS`.
  const prompt = item.body.replaceAll("$ARGUMENTS", "{{args}}");
  return [{ path: `.gemini/commands/forge/${item.id}.toml`, content: `# Generated by FORGE from catalog/${item.sourcePath}\ndescription = ${JSON.stringify(item.description)}\nprompt = ${JSON.stringify(prompt)}\n`, targets: ["gemini"] }];
}

function sharedFiles(item: CatalogItem, target: HarnessTarget): PlannedFile[] {
  const shared = sharedFile(item, target);
  return [...(shared ? [shared] : []), ...(item.kind === "skill" ? [sharedSkill(item, target)] : [])];
}

/** Markdown frontmatter-free body with a generated note. */
const body = (item: CatalogItem) => GENERATED_NOTE(item) + item.body + "\n";

function copilotFiles(item: CatalogItem): PlannedFile[] {
  switch (item.kind) {
    case "rule": {
      const language = item.language ?? "common";
      return [{ path: `.github/instructions/forge-${language}-${item.id}.instructions.md`, content: frontmatter([["description", item.description], ["applyTo", item.globs?.join(",") ?? (language === "common" ? "**" : undefined)]]) + body(item), targets: ["copilot"] }];
    }
    case "command":
      return [{ path: `.github/prompts/forge-${item.id}.prompt.md`, content: frontmatter([["description", item.description], ["mode", "agent"]]) + body(item).replaceAll("$ARGUMENTS", "${input:args}"), targets: ["copilot"] }];
    case "agent":
      return [{ path: `.github/agents/forge-${item.id}.agent.md`, content: frontmatter([["name", `forge-${item.id}`], ["description", item.description]]) + body(item), targets: ["copilot"] }];
    case "skill":
      return [];
  }
}

function windsurfFiles(item: CatalogItem): PlannedFile[] {
  if (item.kind === "command") return [{ path: `.windsurf/workflows/forge-${item.id}.md`, content: frontmatter([["description", item.description]]) + body(item), targets: ["windsurf"] }];
  if (item.kind !== "rule") return [];
  const language = item.language ?? "common";
  const trigger = item.globs ? "glob" : language === "common" ? "always_on" : "model_decision";
  return [{ path: `.windsurf/rules/forge-${language}-${item.id}.md`, content: frontmatter([["trigger", trigger], ["description", item.description], ["globs", item.globs?.join(",")]]) + body(item), targets: ["windsurf"] }];
}

function kiroFiles(item: CatalogItem): PlannedFile[] {
  if (item.kind === "rule") {
    const language = item.language ?? "common";
    const inclusion = item.globs ? "fileMatch" : language === "common" ? "always" : "manual";
    return [{ path: `.kiro/steering/forge-${language}-${item.id}.md`, content: frontmatter([["inclusion", inclusion], ["fileMatchPattern", item.globs?.join(",")]]) + body(item), targets: ["kiro"] }];
  }
  if (item.kind === "skill") return [];
  // Agents and workflows become manual steering files the user pulls in with `#forge-<kind>-<id>`.
  return [{ path: `.kiro/steering/forge-${item.kind}-${item.id}.md`, content: frontmatter([["inclusion", "manual"]]) + `# ${item.name}\n\n${item.description}\n\n` + body(item), targets: ["kiro"] }];
}

function clineFiles(item: CatalogItem): PlannedFile[] {
  if (item.kind === "command") return [{ path: `.clinerules/workflows/forge-${item.id}.md`, content: body(item), targets: ["cline"] }];
  if (item.kind !== "rule") return [];
  const language = item.language ?? "common";
  return [{ path: `.clinerules/forge-${language}-${item.id}.md`, content: (item.globs ? frontmatter([["paths", item.globs.join(", ")]]) : "") + body(item), targets: ["cline"] }];
}

/** Files for each target: native formats plus the shared copies the instruction blocks point at. */
function renderTarget(target: HarnessTarget, item: CatalogItem): PlannedFile[] {
  switch (target) {
    case "claude": return claudeFiles(item);
    case "cursor": return cursorFiles(item);
    case "opencode": return [...opencodeFiles(item), ...sharedFiles(item, target)];
    case "codex": return sharedFiles(item, target);
    case "gemini": return [...geminiFiles(item), ...sharedFiles(item, target)];
    case "copilot": return [...copilotFiles(item), ...sharedFiles(item, target)];
    case "windsurf": return [...windsurfFiles(item), ...sharedFiles(item, target)];
    case "kiro": return [...kiroFiles(item), ...sharedFiles(item, target)];
    case "cline": return [...clineFiles(item), ...sharedFiles(item, target)];
    case "zed": return sharedFiles(item, target);
  }
}

/** Managed instruction blocks each target reads. */
const TARGET_BLOCK_FILES: Partial<Record<HarnessTarget, string[]>> = {
  codex: ["AGENTS.md"],
  opencode: ["AGENTS.md"],
  gemini: ["GEMINI.md"],
  copilot: [".github/copilot-instructions.md"],
  windsurf: ["AGENTS.md"],
  kiro: [".kiro/steering/forge-harness.md"],
  cline: [".clinerules/forge-harness.md"],
  zed: ["AGENTS.md"],
};

function instructionsBlock(items: CatalogItem[], skillsPath: string): string {
  const agents = items.filter(i => i.kind === "agent");
  const commands = items.filter(i => i.kind === "command");
  const skills = items.filter(i => i.kind === "skill");
  const commonRules = items.filter(i => i.kind === "rule" && (i.language ?? "common") === "common");
  const languageRules = items.filter(i => i.kind === "rule" && (i.language ?? "common") !== "common");
  const lines: string[] = ["## FORGE engineering harness", "", "FORGE installed these project instructions. Prefer evidence over assumption: never claim a check passed unless it was run.", ""];
  if (commonRules.length) {
    lines.push("### Always-on rules", "");
    for (const rule of commonRules) lines.push(`- **${rule.name}** — ${rule.description} (\`.forge/harness/rules/common/${rule.id}.md\`)`);
    lines.push("");
  }
  if (languageRules.length) {
    lines.push("### Language rules (read before editing matching files)", "");
    for (const rule of languageRules) lines.push(`- ${rule.language}: **${rule.name}**${rule.globs ? ` [${rule.globs.join(", ")}]` : ""} — \`.forge/harness/rules/${rule.language}/${rule.id}.md\``);
    lines.push("");
  }
  if (agents.length) {
    lines.push("### Specialist roles", "", "When a task matches a role, read its file and follow it.", "");
    for (const agent of agents) lines.push(`- **${agent.name}** — ${agent.description} (\`.forge/harness/agents/${agent.id}.md\`)`);
    lines.push("");
  }
  if (commands.length) {
    lines.push("### Workflows", "");
    for (const command of commands) lines.push(`- **${command.id}** — ${command.description} (\`.forge/harness/commands/${command.id}.md\`)`);
    lines.push("");
  }
  if (skills.length) {
    lines.push(`### Skills (in \`${skillsPath}\`)`, "");
    for (const skill of skills) lines.push(`- **forge-${skill.id}** — ${skill.description}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export async function buildInstallPlan(options: InstallOptions): Promise<InstallPlan> {
  const projectRoot = path.resolve(options.projectPath);
  const catalog = options.catalog ?? await loadHarnessCatalog();
  const profile = options.profile ?? "standard";
  const targets = options.targets?.length ? normalizeHarnessTargets(options.targets) : [...DEFAULT_TARGETS];
  const languages = options.languages ?? (profile === "full" ? undefined : await detectProjectLanguages(projectRoot));
  const items = selectCatalogItems(catalog, languages ? { profile, languages } : { profile });
  const resolvedLanguages = languages ?? [...new Set(items.filter(i => i.kind === "rule" && i.language && i.language !== "common").map(i => i.language as string))].sort();

  const files = new Map<string, PlannedFile>();
  const add = (file: PlannedFile, item: CatalogItem) => {
    const existing = files.get(file.path);
    if (existing) {
      if (existing.content !== file.content) throw new Error(`Install plan has conflicting content for ${file.path}.`);
      for (const target of file.targets) if (!existing.targets.includes(target)) existing.targets.push(target);
      return;
    }
    files.set(file.path, { ...file, item: `${item.kind}:${item.language ? item.language + "/" : ""}${item.id}` });
  };

  const blocks = new Map<string, PlannedBlock>();
  for (const target of targets) {
    for (const item of items) for (const file of renderTarget(target, item)) add(file, item);
    for (const blockPath of TARGET_BLOCK_FILES[target] ?? []) {
      const existing = blocks.get(blockPath);
      if (existing) existing.targets.push(target);
      else blocks.set(blockPath, { path: blockPath, content: instructionsBlock(items, ".agents/skills"), targets: [target] });
    }
  }

  return {
    profile,
    targets,
    languages: resolvedLanguages,
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    blocks: [...blocks.values()].sort((a, b) => a.path.localeCompare(b.path)),
    itemCount: items.length,
  };
}

// ---------------------------------------------------------------------------
// Filesystem safety helpers
// ---------------------------------------------------------------------------

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function assertRelativeSafe(relativePath: string): void {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).some(part => part === ".." || part === "")) {
    throw new Error(`Refusing unsafe install path "${relativePath}".`);
  }
}

/** Resolve a project-relative path, refusing symlinked ancestors that could escape the project. */
async function resolveInside(root: string, relativePath: string): Promise<string> {
  assertRelativeSafe(relativePath);
  const parts = relativePath.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Refusing to install through non-directory or symlink "${path.relative(root, current)}".`);
    } catch (error) {
      if (isMissing(error)) return path.join(root, ...parts);
      throw error;
    }
  }
  const target = path.join(root, ...parts);
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing to replace non-regular file "${relativePath}".`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return target;
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.forge-${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

interface FileTransactionOperation { path: string; content: string | null }

/** Apply file mutations with snapshots and reverse-order rollback on failure. */
export async function applyFileTransaction(operations: FileTransactionOperation[]): Promise<void> {
  const snapshots = new Map<string, string | undefined>();
  const applied: string[] = [];
  try {
    for (const operation of operations) {
      if (!snapshots.has(operation.path)) snapshots.set(operation.path, await readIfExists(operation.path));
      if (operation.content === null) await rm(operation.path, { force: true });
      else await atomicWrite(operation.path, operation.content);
      applied.push(operation.path);
    }
  } catch (cause) {
    const rollbackErrors: string[] = [];
    for (const file of [...new Set(applied)].reverse()) {
      try {
        const previous = snapshots.get(file);
        if (previous === undefined) await rm(file, { force: true });
        else await atomicWrite(file, previous);
      } catch (error) { rollbackErrors.push(file + ': ' + (error instanceof Error ? error.message : String(error))); }
    }
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error('FORGE install transaction failed: ' + detail + (rollbackErrors.length ? '. Rollback also failed: ' + rollbackErrors.join('; ') : '. All applied changes were rolled back.'));
  }
}

const TRANSACTION_JOURNAL_PATH = ".forge/transaction-journal.json";
interface TransactionJournal {
  schemaVersion: 1;
  snapshots: Array<{ path: string; contentBase64: string | null }>;
}

async function restoreJournal(root: string, journal: TransactionJournal): Promise<void> {
  for (const snapshot of [...journal.snapshots].reverse()) {
    assertRelativeSafe(snapshot.path);
    const absolute = await resolveInside(root, snapshot.path);
    if (snapshot.contentBase64 === null) await rm(absolute, { force: true });
    else await atomicWrite(absolute, Buffer.from(snapshot.contentBase64, "base64").toString("utf8"));
  }
}

/** Recover an interrupted install/uninstall by restoring durable pre-transaction snapshots. */
export async function recoverFileTransaction(projectPath: string): Promise<boolean> {
  const root = await realpath(path.resolve(projectPath));
  const journalPath = path.join(root, TRANSACTION_JOURNAL_PATH);
  const raw = await readIfExists(journalPath);
  if (raw === undefined) return false;
  let journal: TransactionJournal;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || (parsed as TransactionJournal).schemaVersion !== 1 ||
        !Array.isArray((parsed as TransactionJournal).snapshots)) throw new Error("invalid journal shape");
    journal = parsed as TransactionJournal;
    const seenPaths = new Set<string>();
    for (const item of journal.snapshots) {
      if (!item || typeof item.path !== "string" ||
          !(item.contentBase64 === null || typeof item.contentBase64 === "string")) throw new Error("invalid snapshot entry");
      assertRelativeSafe(item.path);
      if (seenPaths.has(item.path)) throw new Error("duplicate snapshot path");
      seenPaths.add(item.path);
      if (item.contentBase64 !== null) {
        // Buffer.from(..., "base64") silently accepts malformed input; journals must be canonical.
        const encoded = item.contentBase64;
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded) ||
            Buffer.from(encoded, "base64").toString("base64") !== encoded) {
          throw new Error("invalid snapshot base64");
        }
      }
    }
  } catch (error) {
    throw new Error("FORGE transaction recovery journal is invalid; it was left untouched: " + (error instanceof Error ? error.message : String(error)));
  }
  await restoreJournal(root, journal);
  await rm(journalPath, { force: true });
  return true;
}

/** Persist snapshots before mutations so a later CLI invocation can recover after a process crash. */
async function applyDurableFileTransaction(projectPath: string, operations: FileTransactionOperation[]): Promise<void> {
  const root = await realpath(path.resolve(projectPath));
  await recoverFileTransaction(root);
  const snapshots = new Map<string, string | undefined>();
  for (const operation of operations) {
    const relative = path.relative(root, operation.path).split(path.sep).join("/");
    assertRelativeSafe(relative);
    if (!snapshots.has(relative)) snapshots.set(relative, await readIfExists(await resolveInside(root, relative)));
  }
  const journal: TransactionJournal = {
    schemaVersion: 1,
    snapshots: [...snapshots].map(([file, content]) => ({
      path: file,
      contentBase64: content === undefined ? null : Buffer.from(content, "utf8").toString("base64"),
    })),
  };
  const journalPath = path.join(root, TRANSACTION_JOURNAL_PATH);
  await atomicWrite(journalPath, JSON.stringify(journal, null, 2) + "\n");
  try {
    await applyFileTransaction(operations);
    await rm(journalPath, { force: true });
  } catch (error) {
    try {
      await restoreJournal(root, journal);
      await rm(journalPath, { force: true });
    } catch (recoveryError) {
      throw new Error((error instanceof Error ? error.message : String(error)) +
        ". Durable recovery journal retained at " + TRANSACTION_JOURNAL_PATH +
        "; next FORGE install/uninstall will retry recovery. Recovery error: " +
        (recoveryError instanceof Error ? recoveryError.message : String(recoveryError)));
    }
    throw error;
  }
}

async function pruneEmptyParents(root: string, file: string): Promise<void> {
  let directory = path.dirname(file);
  while (directory.startsWith(root + path.sep) && directory !== root) {
    try {
      if ((await readdir(directory)).length > 0) return;
      await rmdir(directory);
    } catch {
      return;
    }
    directory = path.dirname(directory);
  }
}

export function extractManagedBlock(content: string): { before: string; block: string; after: string } | undefined {
  const start = content.indexOf(BLOCK_BEGIN);
  const end = content.indexOf(BLOCK_END);
  if (start === -1 && end === -1) return undefined;
  if (start === -1 || end === -1 || end < start || content.indexOf(BLOCK_BEGIN, start + 1) !== -1) {
    throw new Error("FORGE managed block markers are malformed; fix them manually.");
  }
  return {
    before: content.slice(0, start),
    block: content.slice(start + BLOCK_BEGIN.length, end).replace(/^\r?\n/, "").replace(/\r?\n$/, ""),
    after: content.slice(end + BLOCK_END.length),
  };
}

export function withBlock(existing: string | undefined, block: string): string {
  const rendered = `${BLOCK_BEGIN}\n${block}\n${BLOCK_END}`;
  if (existing === undefined || existing.trim() === "") return `${rendered}\n`;
  const parts = extractManagedBlock(existing);
  if (!parts) return `${existing.replace(/\s*$/, "")}\n\n${rendered}\n`;
  return `${parts.before}${rendered}${parts.after}`;
}

function withoutBlock(existing: string): string {
  const parts = extractManagedBlock(existing);
  if (!parts) return existing;
  const before = parts.before.trimEnd();
  const after = parts.after.trim();
  const joined = before && after ? `${before}\n\n${after}` : before || after;
  return joined ? `${joined}\n` : "";
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export async function loadInstallState(projectPath: string): Promise<InstallState | undefined> {
  const root = await realpath(path.resolve(projectPath));
  const raw = await readIfExists(await resolveInside(root, INSTALL_STATE_PATH));
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(INSTALL_STATE_PATH + " is not valid JSON. The file was left untouched; restore a valid backup before running install or uninstall."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(INSTALL_STATE_PATH + " must contain a JSON object. The file was left untouched.");
  }
  const candidate = parsed as Record<string, unknown>;
  const version = candidate.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new Error(INSTALL_STATE_PATH + " is missing a valid schemaVersion. The file was left untouched.");
  }
  if (version > STATE_SCHEMA_VERSION) {
    throw new Error(INSTALL_STATE_PATH + " uses schema version " + version + ", but this FORGE CLI supports up to " + STATE_SCHEMA_VERSION + ". Upgrade FORGE before modifying or uninstalling this installation; the state file was left untouched.");
  }
  if (version !== LEGACY_STATE_SCHEMA_VERSION && version !== STATE_SCHEMA_VERSION) {
    throw new Error(INSTALL_STATE_PATH + " uses unsupported schema version " + version + ". No migration is available; the file was left untouched.");
  }
  const state = candidate as unknown as InstallState;
  if (typeof state.forgeVersion !== "string" || typeof state.installedAt !== "string" ||
      typeof state.profile !== "string" || !INSTALL_PROFILES.includes(state.profile) ||
      !Array.isArray(state.targets) || !Array.isArray(state.languages) ||
      !state.languages.every(value => typeof value === "string") ||
      !Array.isArray(state.files) || !Array.isArray(state.blocks)) {
    throw new Error(INSTALL_STATE_PATH + " has an invalid state structure. The file was left untouched.");
  }
  for (const target of state.targets) {
    if (typeof target !== "string" || !HARNESS_TARGETS.includes(target as HarnessTarget)) {
      throw new Error(INSTALL_STATE_PATH + " contains an unsupported harness target. The file was left untouched.");
    }
  }
  for (const entry of [...state.files, ...state.blocks]) {
    if (!entry || typeof entry.path !== "string" || typeof entry.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/i.test(entry.sha256) || !Array.isArray(entry.targets) ||
        !entry.targets.every(target => typeof target === "string" && HARNESS_TARGETS.includes(target as HarnessTarget))) {
      throw new Error(INSTALL_STATE_PATH + " contains an invalid file or block entry. The file was left untouched.");
    }
    assertRelativeSafe(entry.path);
  }
  if (state.settings !== undefined) {
    const settings = state.settings as Partial<InstallStateSettings>;
    if (!settings || typeof settings.path !== "string" || !Array.isArray(settings.commands) ||
        !settings.commands.every(command => typeof command === "string") || !Array.isArray(settings.addedDeny) ||
        !settings.addedDeny.every(rule => typeof rule === "string") || typeof settings.createdFile !== "boolean") {
      throw new Error(INSTALL_STATE_PATH + " has an invalid settings entry. The file was left untouched.");
    }
    assertRelativeSafe(settings.path);
  }
  // v1 and v2 share the payload shape; normalize v1 in memory. A successful install persists v2.
  return version === LEGACY_STATE_SCHEMA_VERSION ? { ...state, schemaVersion: STATE_SCHEMA_VERSION } : state;
}

// ---------------------------------------------------------------------------
// Install / uninstall / doctor
// ---------------------------------------------------------------------------

export async function installHarness(options: InstallOptions): Promise<InstallResult> {
  const root = await realpath(path.resolve(options.projectPath));
  await recoverFileTransaction(root);
  const plan = await buildInstallPlan({ ...options, projectPath: root });
  const previous = await loadInstallState(root);
  const previousFiles = new Map((previous?.files ?? []).map(entry => [entry.path, entry]));
  const previousBlocks = new Map((previous?.blocks ?? []).map(entry => [entry.path, entry]));
  const dryRun = Boolean(options.dryRun);
  const changes: InstallChange[] = [];
  const stateFiles: InstallStateFile[] = [];
  const stateBlocks: InstallStateBlock[] = [];
  const writes: FileTransactionOperation[] = [];

  for (const file of plan.files) {
    const absolute = await resolveInside(root, file.path);
    const current = await readIfExists(absolute);
    const hash = sha256(file.content);
    const owned = previousFiles.get(file.path);
    const record: InstallStateFile = { path: file.path, sha256: hash, targets: file.targets, ...(file.item ? { item: file.item } : {}) };
    if (current === undefined) {
      changes.push({ path: file.path, action: "create" });
    } else if (current === file.content) {
      changes.push({ path: file.path, action: "unchanged" });
      stateFiles.push(record);
      continue;
    } else if (owned && sha256(current) === owned.sha256) {
      changes.push({ path: file.path, action: "update" });
    } else if (options.force) {
      changes.push({ path: file.path, action: "overwrite", detail: owned ? "local edits replaced (--force)" : "existing file replaced (--force)" });
    } else {
      changes.push({ path: file.path, action: "conflict", detail: owned ? "modified since FORGE installed it; kept (use --force to replace)" : "file exists and is not managed by FORGE; kept (use --force to replace)" });
      if (owned) stateFiles.push(owned);
      continue;
    }
    stateFiles.push(record);
    writes.push({ path: absolute, content: file.content });
  }

  const planned = new Set(plan.files.map(file => file.path));
  for (const [stalePath, entry] of previousFiles) {
    if (planned.has(stalePath)) continue;
    const absolute = await resolveInside(root, stalePath);
    const current = await readIfExists(absolute);
    if (current === undefined) continue;
    if (sha256(current) === entry.sha256) {
      changes.push({ path: stalePath, action: "remove", detail: "no longer selected" });
      writes.push({ path: absolute, content: null });
    } else {
      changes.push({ path: stalePath, action: "keep-modified", detail: "no longer selected but locally modified; kept" });
    }
  }

  for (const block of plan.blocks) {
    const absolute = await resolveInside(root, block.path);
    const current = await readIfExists(absolute);
    const owned = previousBlocks.get(block.path);
    const existingBlock = current === undefined ? undefined : extractManagedBlock(current)?.block;
    const record: InstallStateBlock = { path: block.path, sha256: sha256(block.content), targets: block.targets, createdFile: owned?.createdFile ?? current === undefined };
    if (existingBlock === block.content) {
      changes.push({ path: block.path, action: "unchanged", detail: "managed block" });
    } else if (existingBlock !== undefined && owned && sha256(existingBlock) !== owned.sha256 && !options.force) {
      changes.push({ path: block.path, action: "conflict", detail: "managed block edited by hand; kept (use --force to replace)" });
      stateBlocks.push(owned);
      continue;
    } else {
      changes.push({ path: block.path, action: current === undefined ? "create" : "update", detail: "managed block" });
      writes.push({ path: absolute, content: withBlock(current, block.content) });
    }
    stateBlocks.push(record);
  }
  const plannedBlocks = new Set(plan.blocks.map(block => block.path));
  for (const [stalePath, entry] of previousBlocks) {
    if (plannedBlocks.has(stalePath)) continue;
    const absolute = await resolveInside(root, stalePath);
    const current = await readIfExists(absolute);
    if (current === undefined) continue;
    changes.push({ path: stalePath, action: "remove", detail: "managed block no longer selected" });
    const remaining = withoutBlock(current);
    writes.push({ path: absolute, content: !remaining && entry.createdFile ? null : remaining });
  }

  let stateSettings: InstallStateSettings | undefined;
  const wantHooks = Boolean(options.hooks) && plan.targets.includes("claude");
  if (wantHooks || previous?.settings) {
    const absolute = await resolveInside(root, CLAUDE_SETTINGS_PATH);
    let current: Awaited<ReturnType<typeof readSettingsFile>> | undefined;
    try {
      current = await readSettingsFile(absolute);
    } catch (error) {
      changes.push({ path: CLAUDE_SETTINGS_PATH, action: "conflict", detail: `cannot merge hooks: ${error instanceof Error ? error.message : String(error)}` });
      if (previous?.settings) stateSettings = previous.settings;
    }
    if (current) {
      const previousCommands = previous?.settings?.commands ?? [];
      if (wantHooks) {
        const entries = claudeHookEntries(options.hookCommand);
        const statusCommand = statusLineCommand(options.hookCommand);
        const wantStatusLine = options.statusLine ?? previousCommands.some(command => / statusline$/.test(command));
        const base = removeClaudeHooks(current.settings, previousCommands);
        const { settings: next, addedDeny, statusLine } = addClaudeHooks(base, entries, wantStatusLine ? { statusLineCommand: statusCommand } : {});
        if (wantStatusLine && !statusLine) changes.push({ path: CLAUDE_SETTINGS_PATH, action: "unchanged", detail: "kept your existing statusLine" });
        const keptDeny = (previous?.settings?.addedDeny ?? []).filter(rule => Array.isArray(next.permissions?.deny) && (next.permissions.deny as unknown[]).includes(rule));
        stateSettings = { path: CLAUDE_SETTINGS_PATH, commands: [...entries.map(entry => entry.command), ...(statusLine ? [statusCommand] : [])], addedDeny: [...new Set([...keptDeny, ...addedDeny])], createdFile: previous?.settings?.createdFile ?? !current.existed };
        if (JSON.stringify(next) === JSON.stringify(current.settings)) changes.push({ path: CLAUDE_SETTINGS_PATH, action: "unchanged", detail: "FORGE hooks" });
        else {
          changes.push({ path: CLAUDE_SETTINGS_PATH, action: current.existed ? "update" : "create", detail: "FORGE hooks merged" });
          writes.push({ path: absolute, content: `${JSON.stringify(next, null, 2)}\n` });
        }
      } else if (previous?.settings && current.existed) {
        const next = removeClaudeHooks(current.settings, previousCommands, previous.settings.addedDeny);
        changes.push({ path: CLAUDE_SETTINGS_PATH, action: "remove", detail: "FORGE hooks no longer selected" });
        writes.push({ path: absolute, content: !Object.keys(next).length && previous.settings?.createdFile ? null : `${JSON.stringify(next, null, 2)}\n` });
      }
    }
  }

  const conflicts = changes.filter(change => change.action === "conflict").length;
  if (!dryRun) {

    const state: InstallState = {
      schemaVersion: STATE_SCHEMA_VERSION,
      forgeVersion: options.forgeVersion,
      installedAt: (options.now ?? (() => new Date()))().toISOString(),
      profile: plan.profile,
      targets: plan.targets,
      languages: plan.languages,
      files: stateFiles.sort((a, b) => a.path.localeCompare(b.path)),
      blocks: stateBlocks.sort((a, b) => a.path.localeCompare(b.path)),
      ...(stateSettings ? { settings: stateSettings } : {}),
    };
    writes.push({ path: await resolveInside(root, INSTALL_STATE_PATH), content: `${JSON.stringify(state, null, 2)}\n` });
    await applyDurableFileTransaction(root, writes);
  }
  return { dryRun, plan, changes, conflicts, statePath: INSTALL_STATE_PATH };
}

export interface UninstallResult { dryRun: boolean; changes: InstallChange[]; installed: boolean }

export async function uninstallHarness(options: { projectPath: string; dryRun?: boolean; force?: boolean }): Promise<UninstallResult> {
  const root = await realpath(path.resolve(options.projectPath));
  await recoverFileTransaction(root);
  const state = await loadInstallState(root);
  if (!state) return { dryRun: Boolean(options.dryRun), changes: [], installed: false };
  const changes: InstallChange[] = [];
  const operations: FileTransactionOperation[] = [];
  const pruneAfterCommit: string[] = [];
  const remainingFiles: InstallStateFile[] = [];
  const remainingBlocks: InstallStateBlock[] = [];
  let remainingSettings: InstallStateSettings | undefined;

  for (const entry of state.files) {
    const absolute = await resolveInside(root, entry.path);
    const current = await readIfExists(absolute);
    if (current === undefined) continue;
    if (sha256(current) === entry.sha256 || options.force) {
      changes.push({ path: entry.path, action: "remove" });
      operations.push({ path: absolute, content: null });
      pruneAfterCommit.push(absolute);
    } else {
      changes.push({ path: entry.path, action: "keep-modified", detail: "locally modified; kept (use --force to remove)" });
      remainingFiles.push(entry);
    }
  }

  for (const entry of state.blocks) {
    const absolute = await resolveInside(root, entry.path);
    const current = await readIfExists(absolute);
    if (current === undefined) continue;
    const managed = extractManagedBlock(current);
    if (!managed) continue;
    if (sha256(managed.block) !== entry.sha256 && !options.force) {
      changes.push({ path: entry.path, action: "keep-modified", detail: "managed block edited by hand; kept (use --force to remove)" });
      remainingBlocks.push(entry);
      continue;
    }
    changes.push({ path: entry.path, action: "remove", detail: "managed block" });
    const remaining = withoutBlock(current);
    operations.push({ path: absolute, content: !remaining && entry.createdFile ? null : remaining });
    if (!remaining && entry.createdFile) pruneAfterCommit.push(absolute);
  }

  if (state.settings) {
    const absolute = await resolveInside(root, state.settings.path);
    try {
      const current = await readSettingsFile(absolute);
      if (current.existed) {
        const next = removeClaudeHooks(current.settings, state.settings.commands, state.settings.addedDeny);
        changes.push({ path: state.settings.path, action: "remove", detail: "FORGE hooks" });
        const createdFile = state.settings.createdFile;
        operations.push({ path: absolute, content: !Object.keys(next).length && createdFile ? null : `${JSON.stringify(next, null, 2)}\n` });
        if (!Object.keys(next).length && createdFile) pruneAfterCommit.push(absolute);
      }
    } catch (error) {
      changes.push({ path: state.settings.path, action: "keep-modified", detail: `could not remove FORGE hooks: ${error instanceof Error ? error.message : String(error)}` });
      remainingSettings = state.settings;
    }
  }

  if (!options.dryRun) {
    const remainingState: InstallState = {
      ...state,
      files: remainingFiles,
      blocks: remainingBlocks,
      ...(remainingSettings ? { settings: remainingSettings } : {}),
    };
    const statePath = await resolveInside(root, INSTALL_STATE_PATH);
    if (remainingFiles.length || remainingBlocks.length || remainingSettings) {
      operations.push({ path: statePath, content: `${JSON.stringify(remainingState, null, 2)}\n` });
    } else {
      operations.push({ path: statePath, content: null });
      pruneAfterCommit.push(statePath);
    }
    await applyDurableFileTransaction(root, operations);
    for (const file of pruneAfterCommit) await pruneEmptyParents(root, file);
  }
  return { dryRun: Boolean(options.dryRun), changes, installed: true };
}

export type DoctorStatus = "ok" | "missing" | "modified" | "outdated";
export interface DoctorEntry { path: string; status: DoctorStatus; detail?: string }
export interface DoctorReport {
  installed: boolean;
  healthy: boolean;
  forgeVersion?: string;
  currentVersion: string;
  profile?: InstallProfile;
  targets?: HarnessTarget[];
  languages?: string[];
  hooks?: boolean;
  entries: DoctorEntry[];
  summary: Record<DoctorStatus, number>;
  recommendations: string[];
}

export async function doctorHarness(options: { projectPath: string; forgeVersion: string; catalog?: HarnessCatalog }): Promise<DoctorReport> {
  const root = await realpath(path.resolve(options.projectPath));
  const state = await loadInstallState(root);
  const summary: Record<DoctorStatus, number> = { ok: 0, missing: 0, modified: 0, outdated: 0 };
  if (!state) {
    return { installed: false, healthy: false, currentVersion: options.forgeVersion, entries: [], summary, recommendations: ["Run `forge install` to add FORGE agents, skills, commands and rules to your harnesses."] };
  }
  const plan = await buildInstallPlan({ projectPath: root, forgeVersion: options.forgeVersion, profile: state.profile, targets: state.targets, languages: state.languages, ...(options.catalog ? { catalog: options.catalog } : {}) });
  const expected = new Map(plan.files.map(file => [file.path, sha256(file.content)]));
  const expectedBlocks = new Map(plan.blocks.map(block => [block.path, sha256(block.content)]));
  const entries: DoctorEntry[] = [];
  for (const entry of state.files) {
    const current = await readIfExists(await resolveInside(root, entry.path));
    if (current === undefined) entries.push({ path: entry.path, status: "missing" });
    else if (sha256(current) !== entry.sha256) entries.push({ path: entry.path, status: "modified", detail: "edited after install" });
    else if (expected.has(entry.path) && expected.get(entry.path) !== entry.sha256) entries.push({ path: entry.path, status: "outdated", detail: "a newer catalog version is available" });
    else if (!expected.has(entry.path)) entries.push({ path: entry.path, status: "outdated", detail: "no longer part of the catalog" });
    else entries.push({ path: entry.path, status: "ok" });
  }
  const installedPaths = new Set(state.files.map(entry => entry.path));
  for (const file of plan.files) if (!installedPaths.has(file.path)) entries.push({ path: file.path, status: "outdated", detail: "new catalog item not yet installed" });
  for (const entry of state.blocks) {
    const current = await readIfExists(await resolveInside(root, entry.path));
    let block: string | undefined;
    try {
      block = current === undefined ? undefined : extractManagedBlock(current)?.block;
    } catch (error) {
      entries.push({ path: entry.path, status: "modified", detail: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (block === undefined) entries.push({ path: entry.path, status: "missing", detail: "managed block" });
    else if (sha256(block) !== entry.sha256) entries.push({ path: entry.path, status: "modified", detail: "managed block edited" });
    else if (expectedBlocks.get(entry.path) !== entry.sha256) entries.push({ path: entry.path, status: "outdated", detail: "managed block" });
    else entries.push({ path: entry.path, status: "ok", detail: "managed block" });
  }
  if (state.settings) {
    try {
      const current = await readSettingsFile(await resolveInside(root, state.settings.path));
      const text = JSON.stringify({ hooks: current.settings.hooks ?? {}, statusLine: current.settings.statusLine ?? null });
      const missing = state.settings.commands.filter(command => !text.includes(JSON.stringify(command)));
      entries.push(missing.length ? { path: state.settings.path, status: "missing", detail: `FORGE hooks missing: ${missing.join(", ")}` } : { path: state.settings.path, status: "ok", detail: "FORGE hooks" });
    } catch (error) {
      entries.push({ path: state.settings.path, status: "modified", detail: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const entry of entries) summary[entry.status] += 1;
  const recommendations: string[] = [];
  if (summary.missing || summary.outdated) recommendations.push("Run `forge install` (or `forge repair`) to restore missing files and apply catalog updates.");
  if (summary.modified) recommendations.push("Modified files are preserved. Run `forge install --force` only if you want to discard local edits.");
  if (state.forgeVersion !== options.forgeVersion) recommendations.push(`Installed by FORGE ${state.forgeVersion}; current CLI is ${options.forgeVersion}.`);
  return {
    installed: true,
    healthy: summary.missing === 0 && summary.outdated === 0,
    forgeVersion: state.forgeVersion,
    currentVersion: options.forgeVersion,
    profile: state.profile,
    targets: state.targets,
    languages: state.languages,
    hooks: Boolean(state.settings),
    entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
    summary,
    recommendations,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatInstallResult(result: InstallResult): string {
  const counts = new Map<FileAction, number>();
  for (const change of result.changes) counts.set(change.action, (counts.get(change.action) ?? 0) + 1);
  const lines = [
    `${result.dryRun ? "FORGE install plan (dry run — nothing written)" : "FORGE install complete"}`,
    `  profile   ${result.plan.profile}`,
    `  targets   ${result.plan.targets.join(", ")}`,
    `  languages ${result.plan.languages.length ? result.plan.languages.join(", ") : "common only"}`,
    `  items     ${result.plan.itemCount} catalog items → ${result.plan.files.length} files, ${result.plan.blocks.length} managed blocks`,
    `  changes   ${[...counts].map(([action, count]) => `${action} ${count}`).join(" · ") || "none"}`,
  ];
  const notable = result.changes.filter(change => change.action !== "unchanged");
  if (notable.length) {
    lines.push("");
    for (const change of notable.slice(0, 200)) lines.push(`  ${change.action.padEnd(13)} ${change.path}${change.detail ? `  (${change.detail})` : ""}`);
    if (notable.length > 200) lines.push(`  … ${notable.length - 200} more`);
  }
  if (result.conflicts) lines.push("", `${result.conflicts} file(s) were kept because they were not written by FORGE or were edited. Use --force to replace them.`);
  if (!result.dryRun) lines.push("", `State recorded in ${result.statePath}. Check health any time with \`forge doctor\`.`);
  return lines.join("\n");
}

export function formatUninstallResult(result: UninstallResult): string {
  if (!result.installed) return "FORGE harness files are not installed in this project.";
  const lines = [result.dryRun ? "FORGE uninstall plan (dry run — nothing removed)" : "FORGE harness files removed"];
  for (const change of result.changes) lines.push(`  ${change.action.padEnd(13)} ${change.path}${change.detail ? `  (${change.detail})` : ""}`);
  return lines.join("\n");
}

export function formatDoctorReport(report: DoctorReport): string {
  if (!report.installed) return ["FORGE doctor: harness files not installed.", ...report.recommendations.map(r => `  → ${r}`)].join("\n");
  const lines = [
    `FORGE doctor: ${report.healthy ? "healthy" : "needs attention"}`,
    `  installed by ${report.forgeVersion} · current ${report.currentVersion} · profile ${report.profile} · targets ${report.targets?.join(", ")}`,
    `  ok ${report.summary.ok} · modified ${report.summary.modified} · missing ${report.summary.missing} · outdated ${report.summary.outdated}`,
  ];
  const problems = report.entries.filter(entry => entry.status !== "ok");
  if (problems.length) {
    lines.push("");
    for (const entry of problems.slice(0, 200)) lines.push(`  ${entry.status.padEnd(9)} ${entry.path}${entry.detail ? `  (${entry.detail})` : ""}`);
  }
  if (report.recommendations.length) lines.push("", ...report.recommendations.map(r => `  → ${r}`));
  return lines.join("\n");
}
