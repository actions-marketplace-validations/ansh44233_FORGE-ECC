import { execFile } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Repository profiling: turns a file list, a few manifests and recent commit
 * messages into a project profile and a repository-specific agent skill.
 * Pure analysis is separated from collection so the GitHub App (remote) and
 * `forge analyze` (local) share it.
 */

export interface RepoInput {
  name: string;
  files: string[];
  manifests: Record<string, string>;
  commits: string[];
}

export interface RepoProfile {
  name: string;
  fileCount: number;
  languages: Array<{ language: string; files: number }>;
  frameworks: string[];
  packageManager?: string;
  scripts: Record<string, string>;
  verifyCommands: string[];
  testFramework?: string;
  testLocations: string[];
  sourceRoots: string[];
  ci: string[];
  agentConfig: string[];
  commitConvention: { conventional: number; sampled: number; topTypes: string[]; topScopes: string[] };
  conventions: string[];
}

/** Manifest files worth fetching for analysis (relative paths, exact or by basename). */
export const MANIFEST_FILES = ["package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts", "Gemfile", "composer.json", "tsconfig.json", "Makefile", "deno.json"];

const EXTENSIONS: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
  ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".py": "Python", ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin", ".rb": "Ruby",
  ".php": "PHP", ".cs": "C#", ".swift": "Swift", ".c": "C", ".h": "C", ".cpp": "C++", ".cc": "C++",
  ".dart": "Dart", ".scala": "Scala", ".vue": "Vue", ".svelte": "Svelte", ".sql": "SQL",
};
const IGNORED = /(?:^|\/)(?:node_modules|dist|build|out|coverage|vendor|\.git|\.next|target|__pycache__|\.venv)\//;
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go)$|Test\.java$/;

const FRAMEWORK_DEPS: Array<[string, RegExp]> = [
  ["Next.js", /^next$/], ["React", /^react$/], ["Vue", /^vue$/], ["Svelte", /^svelte$/], ["Angular", /^@angular\/core$/],
  ["Express", /^express$/], ["Fastify", /^fastify$/], ["NestJS", /^@nestjs\/core$/], ["Hono", /^hono$/],
  ["Prisma", /^prisma$|^@prisma\/client$/], ["Drizzle", /^drizzle-orm$/], ["Tailwind CSS", /^tailwindcss$/],
  ["Zod", /^zod$/], ["tRPC", /^@trpc\/server$/], ["Electron", /^electron$/], ["MCP SDK", /^@modelcontextprotocol\//],
];
const TEST_DEPS: Array<[string, RegExp]> = [["Vitest", /^vitest$/], ["Jest", /^jest$/], ["Mocha", /^mocha$/], ["Playwright", /^@playwright\/test$/], ["Cypress", /^cypress$/]];
const PY_FRAMEWORKS: Array<[string, RegExp]> = [["Django", /\bdjango\b/i], ["FastAPI", /\bfastapi\b/i], ["Flask", /\bflask\b/i], ["pytest", /\bpytest\b/i], ["SQLAlchemy", /\bsqlalchemy\b/i]];
const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\(([^)]+)\))?!?:\s/;

function count<T extends string>(values: T[]): Array<[T, number]> {
  const map = new Map<T, number>();
  for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
  return [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function parseJson(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function analyzeRepository(input: RepoInput): RepoProfile {
  const files = input.files.filter(file => !IGNORED.test(file)).slice(0, 50_000);
  const languages = count(files.map(file => EXTENSIONS[path.extname(file).toLowerCase()]).filter((v): v is string => Boolean(v))).map(([language, filesCount]) => ({ language, files: filesCount }));
  const frameworks = new Set<string>();
  let testFramework: string | undefined;
  let packageManager: string | undefined;
  let scripts: Record<string, string> = {};

  const pkg = parseJson(input.manifests["package.json"]);
  if (pkg) {
    const deps = Object.keys({ ...(pkg.dependencies as object ?? {}), ...(pkg.devDependencies as object ?? {}) });
    for (const [name, pattern] of FRAMEWORK_DEPS) if (deps.some(dep => pattern.test(dep))) frameworks.add(name);
    testFramework = TEST_DEPS.find(([, pattern]) => deps.some(dep => pattern.test(dep)))?.[0];
    const scriptEntries = pkg.scripts && typeof pkg.scripts === "object" ? Object.entries(pkg.scripts as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string") : [];
    scripts = Object.fromEntries(scriptEntries.slice(0, 40));
    const declared = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
    packageManager = declared ?? (files.includes("pnpm-lock.yaml") ? "pnpm" : files.includes("yarn.lock") ? "yarn" : files.includes("bun.lockb") || files.includes("bun.lock") ? "bun" : files.includes("package-lock.json") ? "npm" : "npm");
  }
  const python = [input.manifests["pyproject.toml"], input.manifests["requirements.txt"]].filter(Boolean).join("\n");
  if (python) {
    for (const [name, pattern] of PY_FRAMEWORKS) if (pattern.test(python)) { if (name === "pytest") testFramework ??= "pytest"; else frameworks.add(name); }
    packageManager ??= /\[tool\.poetry\]/.test(python) ? "poetry" : files.includes("uv.lock") ? "uv" : "pip";
  }
  if (input.manifests["go.mod"]) { packageManager ??= "go"; testFramework ??= "go test"; }
  if (input.manifests["Cargo.toml"]) { packageManager ??= "cargo"; testFramework ??= "cargo test"; }
  if (input.manifests["pom.xml"]) { packageManager ??= "maven"; testFramework ??= "JUnit"; }
  if (input.manifests["build.gradle"] || input.manifests["build.gradle.kts"]) { packageManager ??= "gradle"; testFramework ??= "JUnit"; }

  const run = packageManager === "npm" ? "npm run" : packageManager === "yarn" ? "yarn" : packageManager === "bun" ? "bun run" : packageManager === "pnpm" ? "pnpm" : undefined;
  const verifyCommands: string[] = [];
  if (run) for (const name of ["typecheck", "lint", "test", "build"]) if (scripts[name]) verifyCommands.push(name === "test" && packageManager === "npm" ? "npm test" : `${run} ${name}`);
  if (packageManager === "go") verifyCommands.push("go vet ./...", "go test ./...");
  if (packageManager === "cargo") verifyCommands.push("cargo clippy -- -D warnings", "cargo test");
  if (["pip", "poetry", "uv"].includes(packageManager ?? "") && testFramework === "pytest") verifyCommands.push(packageManager === "poetry" ? "poetry run pytest" : packageManager === "uv" ? "uv run pytest" : "pytest");
  if (packageManager === "maven") verifyCommands.push("mvn -q verify");
  if (packageManager === "gradle") verifyCommands.push("./gradlew check");

  const testFiles = files.filter(file => TEST_FILE.test(file));
  const testLocations = count(testFiles.map(file => file.includes("/") ? file.split("/").slice(0, file.split("/").length > 2 ? 2 : 1).join("/") : ".")).slice(0, 4).map(([dir]) => dir);
  const colocated = testFiles.filter(file => /\.(?:test|spec)\./.test(file) && !/(?:^|\/)(?:tests?|__tests__)\//.test(file)).length;
  const sourceRoots = count(files.filter(file => EXTENSIONS[path.extname(file).toLowerCase()] && !TEST_FILE.test(file) && file.includes("/")).map(file => file.split("/")[0] as string)).slice(0, 4).map(([dir]) => dir);

  const ci: string[] = [];
  if (files.some(file => file.startsWith(".github/workflows/"))) ci.push("GitHub Actions");
  if (files.includes(".gitlab-ci.yml")) ci.push("GitLab CI");
  if (files.some(file => file.startsWith(".circleci/"))) ci.push("CircleCI");
  if (files.includes("vercel.json")) ci.push("Vercel");
  if (files.some(file => /(?:^|\/)Dockerfile$/.test(file))) ci.push("Docker");

  const agentConfig = files.filter(file => /^(?:AGENTS\.md|CLAUDE\.md|GEMINI\.md|\.cursorrules|\.mcp\.json|\.claude\/settings\.json|\.cursor\/rules\/|\.github\/copilot-instructions\.md)/.test(file)).slice(0, 20);

  const subjects = input.commits.map(message => message.split("\n")[0] ?? "").filter(Boolean).slice(0, 200);
  const conventional = subjects.map(subject => subject.match(CONVENTIONAL)).filter((m): m is RegExpMatchArray => Boolean(m));
  const commitConvention = {
    conventional: subjects.length ? Math.round((conventional.length / subjects.length) * 100) : 0,
    sampled: subjects.length,
    topTypes: count(conventional.map(m => m[1] as string)).slice(0, 5).map(([type]) => type),
    topScopes: count(conventional.map(m => m[2]).filter((v): v is string => Boolean(v))).slice(0, 6).map(([scope]) => scope),
  };

  const conventions: string[] = [];
  if (packageManager) conventions.push(`Use **${packageManager}** for dependencies${packageManager === "pnpm" || packageManager === "yarn" || packageManager === "bun" ? ` (do not mix in another package manager's lockfile)` : ""}.`);
  if (input.manifests["tsconfig.json"]) conventions.push(/"strict"\s*:\s*true/.test(input.manifests["tsconfig.json"]) ? "TypeScript runs in `strict` mode: keep new code free of `any` and unchecked casts." : "TypeScript is configured; match the existing compiler settings.");
  if (pkg?.type === "module") conventions.push("The package is ESM (`\"type\": \"module\"`): use `import`/`export` and include file extensions in relative imports when the project does.");
  if (testFramework) conventions.push(`Tests use **${testFramework}**${testLocations.length ? ` and live in ${testLocations.map(l => `\`${l}\``).join(", ")}` : ""}${colocated > testFiles.length / 2 ? " (co-located with source)" : ""}.`);
  if (commitConvention.sampled >= 10 && commitConvention.conventional >= 60) conventions.push(`Commits follow Conventional Commits (${commitConvention.conventional}% of the last ${commitConvention.sampled})${commitConvention.topScopes.length ? `; common scopes: ${commitConvention.topScopes.map(s => `\`${s}\``).join(", ")}` : ""}.`);
  if (ci.includes("GitHub Actions")) conventions.push("CI runs on GitHub Actions: make sure the same checks pass locally before pushing.");

  return { name: input.name, fileCount: files.length, languages, frameworks: [...frameworks].sort(), ...(packageManager ? { packageManager } : {}), scripts, verifyCommands, ...(testFramework ? { testFramework } : {}), testLocations, sourceRoots, ci, agentConfig, commitConvention, conventions };
}

export function renderProjectSkill(profile: RepoProfile): string {
  const lines = [
    "---",
    "name: forge-project",
    `description: Conventions, commands and structure of the ${profile.name.replace(/[^\w ./-]/g, "")} repository. Use before changing code here.`,
    "---",
    "",
    "<!-- Generated by FORGE `forge analyze` from repository files and commit history. Review and edit freely; re-run to refresh. -->",
    "",
    `# ${profile.name} — project guide`,
    "",
    "## Stack",
    "",
    `- Languages: ${profile.languages.slice(0, 5).map(l => `${l.language} (${l.files} files)`).join(", ") || "not detected"}`,
  ];
  if (profile.frameworks.length) lines.push(`- Frameworks and libraries: ${profile.frameworks.join(", ")}`);
  if (profile.packageManager) lines.push(`- Package manager: ${profile.packageManager}`);
  if (profile.sourceRoots.length) lines.push(`- Main source folders: ${profile.sourceRoots.map(s => `\`${s}/\``).join(", ")}`);
  if (profile.ci.length) lines.push(`- Delivery: ${profile.ci.join(", ")}`);
  lines.push("", "## Verify every change", "");
  if (profile.verifyCommands.length) {
    lines.push("Run these before saying work is done, and report the exact results:", "", "```bash", ...profile.verifyCommands, "```");
  } else {
    lines.push("No standard check commands were detected. Ask the user how this project is tested before claiming a change works.");
  }
  if (profile.conventions.length) lines.push("", "## Conventions", "", ...profile.conventions.map(item => `- ${item}`));
  const extraScripts = Object.keys(profile.scripts).filter(name => !["typecheck", "lint", "test", "build"].includes(name)).slice(0, 12);
  if (extraScripts.length) lines.push("", "## Other scripts", "", ...extraScripts.map(name => `- \`${name}\`: \`${profile.scripts[name]?.slice(0, 120)}\``));
  if (profile.agentConfig.length) lines.push("", "## Existing agent configuration", "", "Respect these files; they may contain team rules:", "", ...profile.agentConfig.map(file => `- \`${file}\``));
  lines.push("", "## Working rules", "", "- Read the code you are changing and its tests first; follow the patterns you find.", "- Keep changes small and focused; do not reformat unrelated code.", "- Never claim a check passed unless you ran it in this session.");
  return lines.join("\n") + "\n";
}

export function formatRepoProfile(profile: RepoProfile): string {
  return [
    `FORGE repository profile: ${profile.name}`,
    `  files      ${profile.fileCount}`,
    `  languages  ${profile.languages.slice(0, 5).map(l => `${l.language} ${l.files}`).join(", ") || "none"}`,
    `  frameworks ${profile.frameworks.join(", ") || "none detected"}`,
    `  packages   ${profile.packageManager ?? "unknown"}`,
    `  tests      ${profile.testFramework ?? "not detected"}${profile.testLocations.length ? ` in ${profile.testLocations.join(", ")}` : ""}`,
    `  verify     ${profile.verifyCommands.join(" && ") || "none detected"}`,
    `  commits    ${profile.commitConvention.sampled ? `${profile.commitConvention.conventional}% conventional of ${profile.commitConvention.sampled}` : "no history"}`,
    `  ci         ${profile.ci.join(", ") || "none"}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Local collection for `forge analyze`
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

async function walkFiles(root: string, relative = "", output: string[] = [], depth = 0): Promise<string[]> {
  if (depth > 12 || output.length >= 50_000) return output;
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (IGNORED.test(child + "/") || entry.name === ".git") continue;
      await walkFiles(root, child, output, depth + 1);
    } else if (entry.isFile()) output.push(child);
    if (output.length >= 50_000) break;
  }
  return output;
}

export async function collectLocalRepository(projectPath: string): Promise<RepoInput> {
  const root = path.resolve(projectPath);
  let files: string[];
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    files = stdout.split("\0").filter(Boolean);
    if (!files.length) files = await walkFiles(root);
  } catch {
    files = await walkFiles(root);
  }
  const manifests: Record<string, string> = {};
  for (const name of MANIFEST_FILES) {
    try {
      const info = await lstat(path.join(root, name));
      if (info.isFile() && info.size <= 512 * 1024) manifests[name] = await readFile(path.join(root, name), "utf8");
    } catch {
      // Not present.
    }
  }
  let commits: string[] = [];
  try {
    const { stdout } = await execFileAsync("git", ["log", "-n", "200", "--format=%s%x00"], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    commits = stdout.split("\0").map(line => line.trim()).filter(Boolean);
  } catch {
    commits = [];
  }
  return { name: path.basename(root), files, manifests, commits };
}
