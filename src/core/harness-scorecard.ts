import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { detectProjectLanguages } from "./harness-catalog.js";
import { detectHarnessTargets, doctorHarness, type DoctorReport } from "./harness-installer.js";
import { runShield, type ShieldReport } from "./forge-shield.js";
import { listProjectMemory, type ProjectMemoryEntry } from "./project-memory.js";

/**
 * Deterministic harness readiness scorecard.
 *
 * Every category is scored 0-10 from files and reports on disk, never from a
 * model's opinion. Each point is backed by an evidence line, and every lost
 * point comes with the action that would earn it back, so the same repository
 * always gets the same score.
 */

export const SCORECARD_SCHEMA_VERSION = 1 as const;

export type ScorecardCategoryId =
  | "install"
  | "coverage"
  | "security"
  | "guards"
  | "quality-gates"
  | "context"
  | "memory"
  | "learning"
  | "ci";

export interface ScorecardCategory {
  id: ScorecardCategoryId;
  title: string;
  score: number;
  max: 10;
  evidence: string[];
  actions: string[];
}

export interface Scorecard {
  schemaVersion: typeof SCORECARD_SCHEMA_VERSION;
  tool: "forge-scorecard";
  generatedAt: string;
  project: string;
  total: number;
  max: number;
  percent: number;
  grade: "A" | "B" | "C" | "D" | "F";
  categories: ScorecardCategory[];
  topActions: string[];
}

export interface ScorecardOptions {
  projectPath: string;
  forgeVersion: string;
  now?: () => Date;
  /** Injected for tests; computed from disk when absent. */
  doctor?: DoctorReport;
  shield?: ShieldReport;
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch { return false; }
}

async function readText(file: string, limit = 512 * 1024): Promise<string | undefined> {
  try {
    const raw = await readFile(file);
    return raw.byteLength > limit ? undefined : raw.toString("utf8");
  } catch { return undefined; }
}

async function listFiles(dir: string): Promise<string[]> {
  try { return (await readdir(dir, { withFileTypes: true })).filter(e => e.isFile()).map(e => e.name); } catch { return []; }
}

class Category {
  readonly evidence: string[] = [];
  readonly actions: string[] = [];
  private points = 0;
  constructor(readonly id: ScorecardCategoryId, readonly title: string) {}
  /** Award points with evidence, or record the action that would earn them. */
  check(condition: boolean, points: number, evidence: string, action: string): boolean {
    if (condition) { this.points += points; this.evidence.push(`+${points} ${evidence}`); }
    else this.actions.push(action);
    return condition;
  }
  done(): ScorecardCategory {
    return { id: this.id, title: this.title, score: Math.max(0, Math.min(10, Math.round(this.points))), max: 10, evidence: this.evidence, actions: this.actions };
  }
}

const HARNESS_MARKERS: Array<[string, string]> = [
  ["claude", ".claude"],
  ["cursor", ".cursor"],
  ["codex", ".codex"],
  ["opencode", ".opencode"],
  ["gemini", ".gemini"],
];

function grade(percent: number): Scorecard["grade"] {
  return percent >= 90 ? "A" : percent >= 75 ? "B" : percent >= 60 ? "C" : percent >= 40 ? "D" : "F";
}

export async function buildScorecard(options: ScorecardOptions): Promise<Scorecard> {
  const root = path.resolve(options.projectPath);
  const now = options.now ?? (() => new Date());
  const doctor = options.doctor ?? await doctorHarness({ projectPath: root, forgeVersion: options.forgeVersion }).catch(() => undefined);
  const shield = options.shield ?? await runShield(root, { now });
  const pkgText = await readText(path.join(root, "package.json"));
  let scripts: Record<string, string> = {};
  try { scripts = (JSON.parse(pkgText ?? "{}") as { scripts?: Record<string, string> }).scripts ?? {}; } catch { /* invalid package.json is reported by Shield */ }
  const memory: ProjectMemoryEntry[] = await listProjectMemory(root).catch(() => []);
  const workflows = (await listFiles(path.join(root, ".github", "workflows"))).filter(f => /\.ya?ml$/.test(f));
  const workflowText = (await Promise.all(workflows.map(f => readText(path.join(root, ".github", "workflows", f))))).join("\n");
  const categories: ScorecardCategory[] = [];

  // 1. Install health -------------------------------------------------------
  {
    const c = new Category("install", "Harness install");
    const installed = Boolean(doctor?.installed);
    c.check(installed, 4, `FORGE harness installed (${doctor?.targets?.join(", ") ?? "?"})`, "Run `forge install` to add agents, skills, commands and rules.");
    if (installed && doctor) {
      c.check(doctor.summary.missing === 0, 2, "no missing harness files", `Run \`forge repair\` to restore ${doctor.summary.missing} missing file(s).`);
      c.check(doctor.summary.outdated === 0, 2, "harness matches this FORGE version", `Run \`forge repair\` to update ${doctor.summary.outdated} outdated file(s).`);
      c.check(doctor.summary.modified === 0, 1, "no hand-edited managed files", `Review ${doctor.summary.modified} locally edited FORGE file(s) with \`forge doctor\`.`);
      c.check(doctor.profile !== "minimal", 1, `profile ${doctor.profile}`, "Use `--profile standard` for the full reviewer and planner set.");
    }
    categories.push(c.done());
  }

  // 2. Harness coverage -------------------------------------------------------
  {
    const c = new Category("coverage", "Harness coverage");
    const installedTargets = new Set<string>(doctor?.targets ?? []);
    const used = new Set<string>(await detectHarnessTargets(root));
    for (const [target, marker] of HARNESS_MARKERS) if (await exists(path.join(root, marker))) used.add(target);
    if (await exists(path.join(root, "AGENTS.md"))) used.add("codex");
    const uncovered = [...used].filter(t => !installedTargets.has(t)).sort();
    if (c.check(installedTargets.size > 0, 4, `${installedTargets.size} harness target(s) installed`, used.size ? `Install FORGE for the harnesses this repo uses: \`forge install --target ${[...used].sort().join(",")}\`.` : "Run `forge install` to cover Claude Code, Cursor, Codex, OpenCode and Gemini.")) {
      c.check(uncovered.length === 0, 4, used.size ? `every harness in use is covered (${[...used].sort().join(", ")})` : "no other harnesses detected", `Add the harnesses this repo already uses: \`forge install --target ${[...new Set([...installedTargets, ...uncovered])].join(",")}\`.`);
      c.check(installedTargets.size >= 2, 2, "works across more than one agent", "Install a second harness so the team is not locked to one agent.");
    }
    categories.push(c.done());
  }

  // 3. Security posture (Shield) --------------------------------------------
  {
    const c = new Category("security", "Security posture");
    c.check(shield.summary.critical === 0, 4, "no critical Shield findings", `Fix ${shield.summary.critical} critical Shield finding(s): \`forge shield\`.`);
    c.check(shield.summary.high === 0, 3, "no high Shield findings", `Fix ${shield.summary.high} high Shield finding(s).`);
    c.check(shield.summary.medium === 0, 2, "no medium Shield findings", `Review ${shield.summary.medium} medium Shield finding(s); \`forge shield --fix\` repairs the fixable ones.`);
    c.check(shield.summary.low === 0, 1, "no low Shield findings", `Review ${shield.summary.low} low Shield finding(s).`);
    categories.push(c.done());
  }

  // 4. Runtime guards ---------------------------------------------------------
  {
    const c = new Category("guards", "Runtime guards");
    const settingsText = await readText(path.join(root, ".claude", "settings.json")) ?? "";
    // Native hook configs written by `forge install --hooks` for Cursor, Codex and Gemini CLI.
    const nativeText = (await Promise.all([".cursor/hooks.json", ".codex/hooks.json", ".gemini/settings.json"].map(file => readText(path.join(root, file))))).map(text => text ?? "").join("\n");
    const preTool = /hook pre-tool/.test(settingsText) || /hook --harness \w+ (?:beforeShellExecution|PreToolUse|BeforeTool)\b/.test(nativeText);
    const stopGate = /hook stop/.test(settingsText) || /hook --harness \w+ (?:stop|Stop|AfterAgent)\b/.test(nativeText);
    const secretReads = /Read\(\.\/\.env\)/.test(settingsText) || /hook --harness \w+ (?:beforeReadFile|BeforeTool)\b/.test(nativeText);
    const guardedIn = [settingsText && /hook pre-tool/.test(settingsText) ? "Claude Code" : "", ...[["Cursor", /--harness cursor/], ["Codex", /--harness codex/], ["Gemini CLI", /--harness gemini/]].filter(([, re]) => (re as RegExp).test(nativeText)).map(([name]) => name as string)].filter(Boolean);
    if (c.check(Boolean(doctor?.hooks) || preTool, 4, guardedIn.length ? `FORGE runtime hooks installed (${guardedIn.join(", ")})` : "FORGE runtime hooks installed", "Enable runtime guards: `forge install --hooks` (Claude Code, Cursor, Codex and Gemini CLI: blocks destructive commands, requires verification, denies .env reads).")) {
      c.check(preTool, 2, "pre-tool guard blocks destructive commands", "Add the pre-tool guard hook (`forge install --hooks`).");
      c.check(stopGate, 2, "stop hook requires verification evidence", "Add the stop hook so sessions cannot end on unverified claims.");
    }
    c.check(secretReads, 2, "agents are denied reading .env files", "Deny secret reads (`forge install --hooks` adds them for Claude Code, and Guard covers file reads in Cursor and Gemini CLI).");
    categories.push(c.done());
  }

  // 5. Quality gates ----------------------------------------------------------
  {
    const c = new Category("quality-gates", "Quality gates");
    const hasPython = await exists(path.join(root, "pyproject.toml"));
    const hasGo = await exists(path.join(root, "go.mod"));
    const hasRust = await exists(path.join(root, "Cargo.toml"));
    const nativeTests = hasGo || hasRust;
    c.check(Boolean(scripts.test) || nativeTests || (hasPython && /pytest/.test(await readText(path.join(root, "pyproject.toml")) ?? "")), 4, "a test command is defined", "Define a `test` script so agents can verify their changes.");
    c.check(Boolean(scripts.typecheck || scripts["type-check"] || scripts.tsc) || hasGo || hasRust || (hasPython && /mypy|pyright/.test(await readText(path.join(root, "pyproject.toml")) ?? "")), 2, "a typecheck command is defined", "Add a `typecheck` script (for example `tsc --noEmit`).");
    c.check(Boolean(scripts.lint) || await exists(path.join(root, "eslint.config.js")) || await exists(path.join(root, "biome.json")) || await exists(path.join(root, "ruff.toml")) || hasGo || hasRust, 2, "a linter is configured", "Add a `lint` script or linter config.");
    c.check(Boolean(scripts.build) || hasGo || hasRust || !pkgText, 2, "a build command is defined", "Add a `build` script so agents can check the project compiles.");
    categories.push(c.done());
  }

  // 6. Project context --------------------------------------------------------
  {
    const c = new Category("context", "Project context");
    const instructions = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".github/copilot-instructions.md"];
    const present: string[] = [];
    for (const file of instructions) if (await exists(path.join(root, file))) present.push(file);
    c.check(present.length > 0, 3, `agent instructions present (${present.join(", ")})`, "Add an AGENTS.md or CLAUDE.md describing how to work in this repo.");
    c.check(await exists(path.join(root, ".claude", "skills", "forge-project", "SKILL.md")) || await exists(path.join(root, ".agents", "skills", "forge-project", "SKILL.md")), 3, "project skill generated from the codebase", "Run `forge analyze --write` to generate a project skill from the repo.");
    const languages = await detectProjectLanguages(root).catch(() => [] as string[]);
    const installedLanguages = new Set(doctor?.languages ?? []);
    const missing = languages.filter(l => !installedLanguages.has(l));
    c.check(languages.length > 0 && missing.length === 0 && Boolean(doctor?.installed), 2, `language rules installed for ${languages.join(", ") || "detected stack"}`, missing.length ? `Install rules for ${missing.join(", ")}: \`forge install --lang ${languages.join(",")}\`.` : "Install language rules with `forge install`.");
    c.check(await exists(path.join(root, "README.md")), 2, "README present", "Add a README so agents can learn the project's purpose.");
    categories.push(c.done());
  }

  // 7. Memory -----------------------------------------------------------------
  {
    const c = new Category("memory", "Memory persistence");
    const kinds = new Set(memory.map(e => e.kind));
    c.check(memory.length > 0, 3, `${memory.length} project memory entr${memory.length === 1 ? "y" : "ies"}`, "Record a first decision: `forge memory add --kind decision --content \"...\"`.");
    c.check(kinds.has("decision") || kinds.has("architecture"), 2, "decisions or architecture recorded", "Record key architecture decisions so new sessions don't relitigate them.");
    c.check(kinds.has("constraint") || kinds.has("preference"), 2, "constraints or preferences recorded", "Record constraints: `forge memory add --kind constraint --content \"Node 20 only\"`.");
    c.check(kinds.has("handoff"), 2, "a session handoff exists", "End sessions with `forge memory handoff` (the stop hook does this automatically).");
    c.check(memory.some(e => (e.evidence?.length ?? 0) > 0), 1, "memory entries cite evidence", "Attach evidence to memory entries with `--evidence FILE`.");
    categories.push(c.done());
  }

  // 8. Continuous learning ------------------------------------------------------
  {
    const c = new Category("learning", "Continuous learning");
    const lessons = memory.filter(e => e.kind === "lesson").length;
    let instincts: Array<{ status?: string; confidence?: number }> = [];
    try {
      const parsed = JSON.parse(await readText(path.join(root, ".forge", "instincts.json")) ?? "{}") as { instincts?: unknown };
      if (Array.isArray(parsed.instincts)) instincts = parsed.instincts as typeof instincts;
    } catch { /* absent or invalid */ }
    const active = instincts.filter(i => i.status === "active");
    c.check(lessons > 0, 3, `${lessons} lesson(s) recorded`, "Record what a session learned: `forge memory add --kind lesson --content \"...\"`.");
    c.check(instincts.length > 0, 3, `${instincts.length} instinct(s) captured`, "Capture learned behaviour: `forge instinct learn` (or enable hooks to observe sessions).");
    c.check(active.length > 0, 2, `${active.length} instinct(s) promoted to active`, "Review candidates and promote the good ones: `forge instinct promote ID`.");
    c.check(await exists(path.join(root, ".claude", "skills", "forge-learned")) || await exists(path.join(root, ".agents", "skills", "forge-learned")), 2, "learned skill generated", "Turn active instincts into a skill: `forge evolve --write`.");
    categories.push(c.done());
  }

  // 9. CI integration ---------------------------------------------------------
  {
    const c = new Category("ci", "CI integration");
    c.check(workflows.length > 0, 3, `${workflows.length} GitHub workflow(s)`, "Add a CI workflow that runs tests on every pull request.");
    c.check(/\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|pytest|go test|cargo test/.test(workflowText), 3, "CI runs the test suite", "Run the test suite in CI.");
    c.check(/forge(?:-engineering-workbench)?[^\n]*shield|ansh44233\/FORGE-ECC|forge shield/i.test(workflowText), 2, "FORGE Shield runs in CI", "Add the FORGE Shield action to CI (see README → GitHub Action).");
    c.check(await exists(path.join(root, ".github", "dependabot.yml")) || await exists(path.join(root, ".github", "renovate.json")) || await exists(path.join(root, "renovate.json")), 2, "dependency updates automated", "Add Dependabot or Renovate for dependency updates.");
    categories.push(c.done());
  }

  const total = categories.reduce((sum, c) => sum + c.score, 0);
  const max = categories.length * 10;
  const percent = Math.round((total / max) * 100);
  // Highest-value actions first: categories with the lowest scores lead.
  const topActions = [...new Set([...categories].sort((a, b) => a.score - b.score || a.id.localeCompare(b.id)).flatMap(c => c.actions.slice(0, 1)))].slice(0, 5);
  return {
    schemaVersion: SCORECARD_SCHEMA_VERSION,
    tool: "forge-scorecard",
    generatedAt: now().toISOString(),
    project: root,
    total,
    max,
    percent,
    grade: grade(percent),
    categories,
    topActions,
  };
}

function bar(score: number): string {
  return "█".repeat(score) + "░".repeat(10 - score);
}

export function formatScorecard(card: Scorecard, options: { verbose?: boolean } = {}): string {
  const lines = [`FORGE harness scorecard — ${card.total}/${card.max} (${card.percent}%, grade ${card.grade})`, ""];
  for (const c of card.categories) {
    lines.push(`  ${c.title.padEnd(22)} ${bar(c.score)} ${String(c.score).padStart(2)}/10`);
    if (options.verbose) {
      for (const e of c.evidence) lines.push(`      ${e}`);
      for (const a of c.actions) lines.push(`      → ${a}`);
    }
  }
  if (card.topActions.length) {
    lines.push("", "Top actions:");
    card.topActions.forEach((a, i) => lines.push(`  ${i + 1}. ${a}`));
  }
  return lines.join("\n");
}

export function formatScorecardMarkdown(card: Scorecard): string {
  const lines = [`## FORGE harness scorecard: ${card.total}/${card.max} (grade ${card.grade})`, "", "| Category | Score | Evidence |", "|---|---:|---|"];
  for (const c of card.categories) lines.push(`| ${c.title} | ${c.score}/10 | ${c.evidence.map(e => e.replace(/\|/g, "\\|")).join("<br>") || "—"} |`);
  if (card.topActions.length) {
    lines.push("", "### Top actions", "");
    for (const a of card.topActions) lines.push(`- ${a}`);
  }
  return lines.join("\n");
}
