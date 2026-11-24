import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadHarnessCatalog, type HarnessCatalog, type InstallProfile } from "../core/harness-catalog.js";
import { buildInstallPlan, extractManagedBlock, HARNESS_TARGETS, INSTALL_STATE_PATH, parseProfile, parseTargets, sha256, withBlock, type HarnessTarget, type InstallState } from "../core/harness-installer.js";
import { formatShieldMarkdown, runShield, type ShieldFinding, type ShieldReport } from "../core/forge-shield.js";
import { GitHubApiError, type GitHubClient, type TreeEntry } from "./github-client.js";
import { assessPullRequestRisk, formatRiskMarkdown } from "./pr-risk.js";
import { analyzeRepository, MANIFEST_FILES, renderProjectSkill, type RepoProfile } from "./repo-analysis.js";

/**
 * FORGE GitHub App event handlers. Transport-agnostic: the Vercel webhook
 * verifies signatures and passes parsed payloads plus an installation client.
 */

export interface AppContext {
  client: GitHubClient;
  forgeVersion: string;
  catalogRoot?: string;
  now?: () => Date;
}

export interface HandlerResult { handled: boolean; action: string; detail?: string; url?: string }

const COMMANDS = ["help", "analyze", "setup", "repair", "audit", "doctor", "risk"] as const;
type ForgeCommand = (typeof COMMANDS)[number];

export interface ParsedCommand { command: ForgeCommand; options: Map<string, string>; flags: Set<string> }

export function parseForgeCommand(body: string): ParsedCommand | undefined {
  const line = body.split(/\r?\n/).map(item => item.trim()).find(item => item.length > 0) ?? "";
  const match = line.match(/^\/forge(?:-ecc)?\s+([a-z-]+)((?:\s+\S+)*)\s*$/i);
  if (!match) return undefined;
  const command = (match[1] ?? "").toLowerCase();
  if (!COMMANDS.includes(command as ForgeCommand)) return { command: "help", options: new Map(), flags: new Set(["unknown"]) };
  const tokens = (match[2] ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 10);
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const value = tokens[index + 1];
    if (/^--(?:targets?|profile)$/.test(token) && value && !value.startsWith("--")) { options.set(token.replace(/^--/, "").replace(/s$/, ""), value); index += 1; }
    else if (/^--[a-z-]+$/.test(token)) flags.add(token.slice(2));
  }
  return { command: command as ForgeCommand, options, flags };
}

export function gitBlobSha(content: string): string {
  const buffer = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${buffer.length}\0`).update(buffer).digest("hex");
}

// ---------------------------------------------------------------------------
// Remote Shield: fetch only agent-configuration files into a temporary folder
// ---------------------------------------------------------------------------

const SHIELD_PATH = /^(?:AGENTS\.md|CLAUDE\.md|CLAUDE\.local\.md|GEMINI\.md|\.cursorrules|\.windsurfrules|\.clinerules|\.rules|\.mcp\.json|mcp\.json|opencode\.json|\.github\/copilot-instructions\.md|\.claude\/settings(?:\.local)?\.json|\.cursor\/mcp\.json|\.vscode\/(?:mcp|settings)\.json|\.gemini\/settings\.json|\.codex\/config\.toml|\.zed\/settings\.json|\.kiro\/settings\/mcp\.json|\.roo\/mcp\.json|\.windsurf\/mcp\.json|\.forge\/(?:permissions|policy)\.json)$|^(?:\.claude\/(?:agents|commands|skills|hooks|rules)|\.cursor\/(?:rules|commands)|\.opencode|\.gemini\/commands|\.agents\/skills|\.forge\/(?:skills|hooks|harness)|\.github\/(?:workflows|instructions|prompts|agents)|\.windsurf\/(?:rules|workflows)|\.kiro\/steering|\.clinerules|\.roo\/rules)\/.+\.(?:md|mdc|json|ya?ml|toml|sh|js|mjs|cjs|ts|py)$/;
const MAX_REMOTE_FILES = 200;

/** Highest-risk surfaces first; FORGE-generated catalog copies last. */
function shieldPriority(file: string): number {
  if (!file.includes("/") || /settings(?:\.local)?\.json$|mcp\.json$|config\.toml$|permissions\.json$|policy\.json$/.test(file)) return 0;
  if (file.startsWith(".github/workflows/") || /\/hooks\//.test(file)) return 1;
  if (/(?:^|\/)forge-[\w.-]+(?:\/SKILL)?\.(?:md|mdc|toml)$|^\.forge\/harness\/|^\.(?:claude\/(?:commands|rules)|gemini\/commands)\/forge\//.test(file)) return 3;
  return 2;
}

export function selectShieldPaths(entries: readonly TreeEntry[]): string[] {
  return entries
    .filter(entry => entry.type === "blob" && (entry.size ?? 0) <= 256 * 1024 && SHIELD_PATH.test(entry.path))
    .map(entry => entry.path)
    .sort((a, b) => shieldPriority(a) - shieldPriority(b) || a.localeCompare(b))
    .slice(0, MAX_REMOTE_FILES)
    .sort();
}

async function withRemoteFiles<T>(client: GitHubClient, owner: string, repo: string, ref: string, paths: string[], action: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-remote-"));
  try {
    const contents = await Promise.all(paths.map(async file => [file, await client.getFileText(owner, repo, file, ref)] as const));
    for (const [file, content] of contents) {
      if (content === undefined) continue;
      const target = path.join(root, ...file.split("/"));
      if (!target.startsWith(root + path.sep)) continue;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    return await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function remoteShield(client: GitHubClient, owner: string, repo: string, ref: string, entries?: TreeEntry[]): Promise<ShieldReport> {
  const tree = entries ?? (await client.getTree(owner, repo, ref)).entries;
  return withRemoteFiles(client, owner, repo, ref, selectShieldPaths(tree), root => runShield(root));
}

// ---------------------------------------------------------------------------
// Repository analysis and setup pull request
// ---------------------------------------------------------------------------

const LANGUAGE_RULES: Record<string, string> = { TypeScript: "typescript", JavaScript: "typescript", Python: "python", Go: "golang", Rust: "rust", Java: "java", Kotlin: "java", "C#": "csharp", PHP: "php", Ruby: "ruby", Swift: "swift" };

export function ruleLanguages(profile: RepoProfile): string[] {
  const languages = profile.languages.filter(item => item.files >= 2).map(item => LANGUAGE_RULES[item.language]).filter((v): v is string => Boolean(v));
  if (profile.frameworks.some(name => name === "React" || name === "Next.js")) languages.push("react");
  return [...new Set(languages)].sort();
}

export interface SetupPlan {
  profile: RepoProfile;
  files: Array<{ path: string; content: string }>;
  created: string[];
  updated: string[];
  skipped: string[];
  targets: HarnessTarget[];
  installProfile: InstallProfile;
}

async function readRepository(client: GitHubClient, owner: string, repo: string, ref: string) {
  const [{ entries, truncated }, commits] = await Promise.all([client.getTree(owner, repo, ref), client.listCommits(owner, repo, ref, 100).catch(() => [])]);
  const present = new Set(entries.filter(entry => entry.type === "blob").map(entry => entry.path));
  const manifestPairs = await Promise.all(MANIFEST_FILES.filter(file => present.has(file)).map(async file => [file, await client.getFileText(owner, repo, file, ref)] as const));
  const manifests = Object.fromEntries(manifestPairs.filter((pair): pair is readonly [string, string] => typeof pair[1] === "string"));
  return { entries, truncated, commits, manifests };
}

export async function planRepositorySetup(context: AppContext, owner: string, repo: string, ref: string, requested: { targets?: HarnessTarget[]; profile?: InstallProfile }, prefetched?: Awaited<ReturnType<typeof readRepository>>): Promise<SetupPlan> {
  const { client } = context;
  const data = prefetched ?? await readRepository(client, owner, repo, ref);
  const blobs = new Map(data.entries.filter(entry => entry.type === "blob").map(entry => [entry.path, entry.sha]));
  // Exclude FORGE's own generated files so re-analysis after merging is stable.
  const ownFiles = /^\.forge\/|(?:^|\/)forge-[\w.-]+(?:\/SKILL)?\.(?:md|mdc|toml)$|(?:^|\/)forge-project\/SKILL\.md$|^\.(?:claude\/(?:commands|rules)|gemini\/commands)\/forge\//;
  const profile = analyzeRepository({ name: `${owner}/${repo}`, files: [...blobs.keys()].filter(file => !ownFiles.test(file)), manifests: data.manifests, commits: data.commits.map(commit => commit.message) });

  let previous: InstallState | undefined;
  if (blobs.has(INSTALL_STATE_PATH)) {
    try { previous = JSON.parse((await client.getFileText(owner, repo, INSTALL_STATE_PATH, ref)) ?? "") as InstallState; } catch { previous = undefined; }
  }
  const targets = requested.targets ?? (previous?.targets?.length ? previous.targets.filter(t => HARNESS_TARGETS.includes(t)) : ["claude", "cursor", "codex"] as HarnessTarget[]);
  const installProfile = requested.profile ?? previous?.profile ?? "standard";
  const catalog: HarnessCatalog = await loadHarnessCatalog(...(context.catalogRoot ? [context.catalogRoot] : []));
  const plan = await buildInstallPlan({ projectPath: os.tmpdir(), forgeVersion: context.forgeVersion, catalog, targets, profile: installProfile, languages: ruleLanguages(profile) });

  const previousHashes = new Map((previous?.files ?? []).map(file => [file.path, file.sha256]));
  const files: Array<{ path: string; content: string }> = [];
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  const stateFiles: InstallState["files"] = [];
  for (const file of plan.files) {
    const existing = blobs.get(file.path);
    const record = { path: file.path, sha256: sha256(file.content), targets: file.targets, ...(file.item ? { item: file.item } : {}) };
    if (!existing) { files.push({ path: file.path, content: file.content }); created.push(file.path); stateFiles.push(record); continue; }
    if (existing === gitBlobSha(file.content)) { stateFiles.push(record); continue; }
    if (previousHashes.has(file.path)) {
      // FORGE-managed file. Only replace it when it still matches what FORGE wrote.
      const current = await client.getFileText(owner, repo, file.path, ref);
      if (current !== undefined && sha256(current) === previousHashes.get(file.path)) { files.push({ path: file.path, content: file.content }); updated.push(file.path); stateFiles.push(record); continue; }
    }
    skipped.push(file.path);
  }
  const stateBlocks: InstallState["blocks"] = [];
  for (const block of plan.blocks) {
    const current = blobs.has(block.path) ? await client.getFileText(owner, repo, block.path, ref) : undefined;
    let existingBlock: string | undefined;
    try { existingBlock = current === undefined ? undefined : extractManagedBlock(current)?.block; } catch { skipped.push(block.path); continue; }
    stateBlocks.push({ path: block.path, sha256: sha256(block.content), targets: block.targets, createdFile: current === undefined });
    if (existingBlock === block.content) continue;
    files.push({ path: block.path, content: withBlock(current, block.content) });
    (current === undefined ? created : updated).push(block.path);
  }
  const skill = renderProjectSkill(profile);
  const skillPaths = [targets.includes("claude") ? ".claude/skills/forge-project/SKILL.md" : undefined, targets.some(t => t === "codex" || t === "opencode" || t === "gemini") ? ".agents/skills/forge-project/SKILL.md" : undefined].filter((v): v is string => Boolean(v));
  for (const skillPath of skillPaths) {
    if (blobs.get(skillPath) === gitBlobSha(skill)) continue;
    files.push({ path: skillPath, content: skill });
    (blobs.has(skillPath) ? updated : created).push(skillPath);
  }
  if (files.length) {
    const state: InstallState = { schemaVersion: 1, forgeVersion: context.forgeVersion, installedAt: (context.now ?? (() => new Date()))().toISOString(), profile: installProfile, targets, languages: plan.languages, files: stateFiles.sort((a, b) => a.path.localeCompare(b.path)), blocks: stateBlocks };
    files.push({ path: INSTALL_STATE_PATH, content: `${JSON.stringify(state, null, 2)}\n` });
  }
  return { profile, files, created, updated, skipped, targets, installProfile };
}

function setupPullRequestBody(setup: SetupPlan, shield: ShieldReport): string {
  const p = setup.profile;
  return [
    "## FORGE setup for this repository",
    "",
    "FORGE analyzed the repository's files, manifests and recent commits and generated agent configuration for "
      + setup.targets.map(t => `**${t}**`).join(", ") + ` (profile \`${setup.installProfile}\`).`,
    "",
    "### What FORGE learned",
    "",
    `- Languages: ${p.languages.slice(0, 5).map(l => `${l.language} (${l.files})`).join(", ") || "not detected"}`,
    `- Frameworks: ${p.frameworks.join(", ") || "none detected"}`,
    `- Package manager: ${p.packageManager ?? "unknown"} · Tests: ${p.testFramework ?? "not detected"}`,
    `- Verify commands: ${p.verifyCommands.map(c => `\`${c}\``).join(", ") || "none detected"}`,
    `- Commit style: ${p.commitConvention.sampled ? `${p.commitConvention.conventional}% conventional (last ${p.commitConvention.sampled})` : "no history"}`,
    "",
    "### Files",
    "",
    `- ${setup.created.length} new, ${setup.updated.length} updated${setup.skipped.length ? `, ${setup.skipped.length} kept because they were edited by you` : ""}`,
    "- `forge-project` skill: repository-specific conventions and verify commands (edit freely)",
    "- `.forge/install-state.json`: lets `forge doctor` / `forge repair` and `/forge doctor` track these files",
    "",
    formatShieldMarkdown(shield),
    "",
    "---",
    "Review the diff, then merge. Comment `/forge repair` later to pull catalog updates without overwriting your edits.",
  ].join("\n");
}

export interface SetupOutcome { base: string; setup: SetupPlan; shield: ShieldReport; pull?: { html_url: string; number: number } }

/** Analyze the default branch and open (or update) a FORGE setup/repair pull request. */
export async function runRemoteSetup(context: AppContext, owner: string, repo: string, mode: "analyze" | "repair", requested: { targets?: HarnessTarget[]; profile?: InstallProfile } = {}): Promise<SetupOutcome> {
  const { client } = context;
  const repository = await client.getRepository(owner, repo);
  const base = repository.default_branch;
  const data = await readRepository(client, owner, repo, base);
  const setup = await planRepositorySetup(context, owner, repo, base, requested, data);
  const shield = await remoteShield(client, owner, repo, base, data.entries);
  if (!setup.files.length) return { base, setup, shield };
  const pull = await client.openPullRequestWithFiles({
    owner, repo, baseBranch: base,
    branch: mode === "repair" ? "forge/repair" : "forge/setup",
    title: mode === "repair" ? "chore(forge): refresh FORGE agent configuration" : "chore(forge): add FORGE agents, skills, rules and project guide",
    message: `chore(forge): ${mode === "repair" ? "refresh" : "add"} FORGE harness files\n\nGenerated by the FORGE GitHub App (FORGE ${context.forgeVersion}).`,
    body: setupPullRequestBody(setup, shield),
    files: setup.files,
  });
  return { base, setup, shield, pull };
}

export interface RemoteDoctor {
  installed: boolean;
  healthy: boolean;
  state?: Pick<InstallState, "forgeVersion" | "profile" | "targets" | "installedAt"> & { languages?: string[]; hooks?: boolean };
  missing: string[];
  outdated: string[];
  added: string[];
}

export async function computeRemoteDoctor(context: AppContext, owner: string, repo: string, prefetched?: { ref: string; entries: TreeEntry[] }): Promise<RemoteDoctor> {
  const { client } = context;
  const ref = prefetched?.ref ?? (await client.getRepository(owner, repo)).default_branch;
  const entries = prefetched?.entries ?? (await client.getTree(owner, repo, ref)).entries;
  const blobs = new Map(entries.filter(entry => entry.type === "blob").map(entry => [entry.path, entry.sha]));
  const rawState = blobs.has(INSTALL_STATE_PATH) ? await client.getFileText(owner, repo, INSTALL_STATE_PATH, ref) : undefined;
  if (!rawState) return { installed: false, healthy: false, missing: [], outdated: [], added: [] };
  const state = JSON.parse(rawState) as InstallState;
  const catalog = await loadHarnessCatalog(...(context.catalogRoot ? [context.catalogRoot] : []));
  const plan = await buildInstallPlan({ projectPath: os.tmpdir(), forgeVersion: context.forgeVersion, catalog, profile: state.profile, targets: state.targets, languages: state.languages });
  const missing = state.files.filter(file => !blobs.has(file.path)).map(file => file.path);
  const outdated = plan.files.filter(file => blobs.has(file.path) && blobs.get(file.path) !== gitBlobSha(file.content)).map(file => file.path);
  const added = plan.files.filter(file => !blobs.has(file.path) && !state.files.some(entry => entry.path === file.path)).map(file => file.path);
  return { installed: true, healthy: !missing.length && !outdated.length && !added.length, state: { forgeVersion: state.forgeVersion, profile: state.profile, targets: state.targets, installedAt: state.installedAt, ...(Array.isArray(state.languages) ? { languages: state.languages } : {}), hooks: Boolean(state.settings) }, missing, outdated, added };
}

export function formatRemoteDoctor(doctor: RemoteDoctor, forgeVersion: string): string {
  if (!doctor.installed || !doctor.state) return "FORGE is not installed on the default branch yet. Comment `/forge analyze` to open a setup pull request.";
  const list = (title: string, items: string[]) => items.length ? [`**${title} (${items.length})**`, ...items.slice(0, 15).map(item => `- \`${item}\``), ...(items.length > 15 ? [`- …${items.length - 15} more`] : []), ""] : [];
  return [
    `### FORGE doctor: ${doctor.healthy ? "✅ healthy" : "⚠️ needs attention"}`,
    "",
    `Installed by FORGE ${doctor.state.forgeVersion} · current ${forgeVersion} · profile \`${doctor.state.profile}\` · targets ${doctor.state.targets.join(", ")}`,
    "",
    ...list("Missing", doctor.missing),
    ...list("Different from the current catalog (edited by you, or an update is available)", doctor.outdated),
    ...list("New catalog items", doctor.added),
    doctor.healthy ? "Everything matches the current catalog." : "Comment `/forge repair` to restore missing files and apply updates. Files you edited are kept.",
  ].join("\n");
}

export { readRepository, remoteShield };

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

interface CommentPayload {
  action?: string;
  comment?: { body?: string; user?: { login?: string; type?: string }; author_association?: string };
  issue?: { number?: number; pull_request?: unknown };
  repository?: { name?: string; owner?: { login?: string }; default_branch?: string };
  sender?: { type?: string; login?: string };
}

const HELP = [
  "**FORGE commands** (comment on any issue or pull request):",
  "",
  "| Command | What it does |",
  "|---|---|",
  "| `/forge analyze [--targets claude,cursor,codex,opencode,gemini] [--profile minimal\\|standard\\|full]` | Learn this repo and open a PR with FORGE agents, skills, commands, rules and a repo-specific skill |",
  "| `/forge repair` | Refresh FORGE files from the latest catalog, keeping your edits |",
  "| `/forge audit` | FORGE Shield security review of agent settings, hooks, MCP servers, instructions and workflows |",
  "| `/forge doctor` | Check installed FORGE files for missing or outdated entries |",
  "| `/forge risk` | (on a PR) explainable change-risk score and suggested reviewers |",
].join("\n");

export async function handleIssueComment(context: AppContext, payload: CommentPayload): Promise<HandlerResult> {
  if (payload.action !== "created") return { handled: false, action: "ignored", detail: "not a new comment" };
  if (payload.sender?.type === "Bot" || payload.comment?.user?.type === "Bot") return { handled: false, action: "ignored", detail: "bot comment" };
  const parsed = parseForgeCommand(payload.comment?.body ?? "");
  if (!parsed) return { handled: false, action: "ignored", detail: "no /forge command" };
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const issue = payload.issue?.number;
  if (!owner || !repo || !issue) return { handled: false, action: "ignored", detail: "incomplete payload" };
  const { client } = context;

  const login = payload.comment?.user?.login ?? payload.sender?.login ?? "";
  let trusted = TRUSTED_ASSOCIATIONS.has(payload.comment?.author_association ?? "");
  if (!trusted && login) {
    try { trusted = ["admin", "maintain", "write"].includes(await client.getCollaboratorPermission(owner, repo, login)); } catch { trusted = false; }
  }
  if (!trusted) {
    await client.createIssueComment(owner, repo, issue, `@${login} FORGE commands can only be run by repository collaborators with write access.`);
    return { handled: true, action: "rejected", detail: "insufficient permission" };
  }

  const isPull = Boolean(payload.issue?.pull_request);
  try {
    switch (parsed.command) {
      case "help": {
        await client.createIssueComment(owner, repo, issue, (parsed.flags.has("unknown") ? "Unknown FORGE command.\n\n" : "") + HELP);
        return { handled: true, action: "help" };
      }
      case "audit": {
        const ref = isPull ? (await client.getPull(owner, repo, issue)).head.sha : (await client.getRepository(owner, repo)).default_branch;
        const report = await remoteShield(client, owner, repo, ref);
        await client.createIssueComment(owner, repo, issue, `${formatShieldMarkdown(report)}\n\n<sub>Scanned \`${ref.slice(0, 12)}\` · ${report.filesScanned} agent configuration files · FORGE ${context.forgeVersion}</sub>`);
        return { handled: true, action: "audit", detail: `score ${report.score}` };
      }
      case "risk": {
        if (!isPull) {
          await client.createIssueComment(owner, repo, issue, "`/forge risk` works on pull requests.");
          return { handled: true, action: "risk", detail: "not a pull request" };
        }
        const risk = assessPullRequestRisk(await client.listPullFiles(owner, repo, issue));
        await client.createIssueComment(owner, repo, issue, formatRiskMarkdown(risk));
        return { handled: true, action: "risk", detail: `${risk.level} ${risk.score}` };
      }
      case "doctor": {
        const doctor = await computeRemoteDoctor(context, owner, repo);
        await client.createIssueComment(owner, repo, issue, formatRemoteDoctor(doctor, context.forgeVersion));
        return { handled: true, action: "doctor", detail: !doctor.installed ? "not installed" : doctor.healthy ? "healthy" : "needs attention" };
      }
      case "analyze":
      case "setup":
      case "repair": {
        const targets = parsed.options.has("target") ? parseTargets(parsed.options.get("target")) : undefined;
        const profile = parsed.options.has("profile") ? parseProfile(parsed.options.get("profile")) : undefined;
        const outcome = await runRemoteSetup(context, owner, repo, parsed.command === "repair" ? "repair" : "analyze", { ...(targets ? { targets } : {}), ...(profile ? { profile } : {}) });
        if (!outcome.pull) {
          await client.createIssueComment(owner, repo, issue, `FORGE is already up to date on \`${outcome.base}\`. Nothing to change.${outcome.setup.skipped.length ? ` (${outcome.setup.skipped.length} file(s) you edited were left alone.)` : ""}`);
          return { handled: true, action: parsed.command, detail: "up to date" };
        }
        await client.createIssueComment(owner, repo, issue, `Opened ${outcome.pull.html_url} — ${outcome.setup.created.length} new and ${outcome.setup.updated.length} updated files for ${outcome.setup.targets.join(", ")}. Shield score for \`${outcome.base}\`: ${outcome.shield.score}/100.`);
        return { handled: true, action: parsed.command, url: outcome.pull.html_url };
      }
    }
  } catch (error) {
    const message = error instanceof GitHubApiError && (error.status === 403 || error.status === 404)
      ? "FORGE does not have permission for this action. A repository admin should grant the FORGE GitHub App **Contents**, **Pull requests**, **Issues** and **Checks** read & write access."
      : `FORGE could not complete \`/forge ${parsed.command}\`: ${error instanceof Error ? error.message.slice(0, 300) : "unknown error"}`;
    await client.createIssueComment(owner, repo, issue, message).catch(() => undefined);
    return { handled: true, action: "error", detail: message };
  }
}

interface PullPayload {
  action?: string;
  pull_request?: { number?: number; draft?: boolean; head?: { sha?: string } };
  repository?: { name?: string; owner?: { login?: string } };
}

const CHECK_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

export function buildCheckRun(headSha: string, shield: ShieldReport, risk: ReturnType<typeof assessPullRequestRisk>, changed: Set<string>): Record<string, unknown> {
  const introduced = shield.findings.filter(item => changed.has(item.file));
  const blocking = introduced.filter(item => item.severity === "critical" || item.severity === "high");
  const conclusion = blocking.length ? "failure" : (risk.level === "critical" || risk.level === "high" || introduced.length) ? "neutral" : "success";
  const ordered: ShieldFinding[] = [...introduced, ...shield.findings.filter(item => !changed.has(item.file))];
  const annotations = ordered.slice(0, 50).map(item => ({
    path: item.file,
    start_line: Math.max(1, item.line),
    end_line: Math.max(1, item.line),
    annotation_level: item.severity === "critical" || item.severity === "high" ? "failure" : item.severity === "medium" ? "warning" : "notice",
    title: `${item.ruleId}: ${item.title}`.slice(0, 255),
    message: `${item.detail} ${item.recommendation}`.slice(0, 64_000),
  }));
  const title = blocking.length
    ? `${blocking.length} high-risk agent configuration issue(s) in this PR`
    : `Risk ${risk.level} (${risk.score}/100) · Shield ${shield.score}/100`;
  return {
    name: "FORGE",
    head_sha: headSha,
    status: "completed",
    conclusion,
    output: {
      title,
      summary: [formatRiskMarkdown(risk), "", formatShieldMarkdown(shield), "", introduced.length ? `**${introduced.length} Shield finding(s) are in files changed by this PR.**` : "No Shield findings in files changed by this PR."].join("\n").slice(0, 65_000),
      annotations,
    },
  };
}

export async function handlePullRequest(context: AppContext, payload: PullPayload): Promise<HandlerResult> {
  if (!CHECK_ACTIONS.has(payload.action ?? "")) return { handled: false, action: "ignored", detail: `pull_request.${payload.action}` };
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const number = payload.pull_request?.number;
  const headSha = payload.pull_request?.head?.sha;
  if (!owner || !repo || !number || !headSha) return { handled: false, action: "ignored", detail: "incomplete payload" };
  const { client } = context;
  const files = await client.listPullFiles(owner, repo, number);
  const risk = assessPullRequestRisk(files);
  const shield = await remoteShield(client, owner, repo, headSha);
  const check = buildCheckRun(headSha, shield, risk, new Set(files.map(file => file.filename)));
  const created = await client.createCheckRun(owner, repo, check);
  return { handled: true, action: "check-run", detail: String(check.conclusion), ...(created.html_url ? { url: created.html_url } : {}) };
}

export async function handleGitHubEvent(context: AppContext, event: string, payload: unknown): Promise<HandlerResult> {
  if (event === "issue_comment") return handleIssueComment(context, payload as CommentPayload);
  if (event === "pull_request") return handlePullRequest(context, payload as PullPayload);
  return { handled: false, action: "ignored", detail: event };
}
