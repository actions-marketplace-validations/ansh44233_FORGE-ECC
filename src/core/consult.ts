import { loadHarnessCatalog, type CatalogItem, type CatalogKind, type HarnessCatalog } from "./harness-catalog.js";
import { MCP_CATALOG, type McpCatalogEntry } from "./mcp-sync.js";

/**
 * `forge consult "<what you are doing>"`: find the agents, skills, commands,
 * rules and MCP servers that fit a task, with the exact command to add them.
 * Ranking is deterministic keyword scoring over ids, names, tags, descriptions
 * and headings, plus a small synonym table. No model call, no network.
 */

const SYNONYMS: Record<string, string[]> = {
  test: ["tdd", "testing", "tests", "unit", "e2e", "coverage", "vitest", "jest", "pytest"],
  tdd: ["test", "testing"],
  e2e: ["playwright", "browser", "end-to-end", "test"],
  security: ["secure", "vulnerability", "owasp", "secrets", "auth", "shield", "threat"],
  auth: ["authentication", "authorization", "login", "oauth", "session", "security"],
  review: ["reviewer", "pr", "pull", "code-review", "audit"],
  pr: ["pull", "review", "github"],
  docs: ["documentation", "readme", "writer", "docs"],
  perf: ["performance", "optimize", "speed", "latency", "profiling"],
  performance: ["perf", "optimize", "profiling"],
  refactor: ["cleanup", "refactoring", "simplify", "dead-code"],
  database: ["db", "sql", "postgres", "migration", "schema", "prisma", "supabase"],
  db: ["database", "sql", "migration"],
  api: ["rest", "endpoint", "openapi", "graphql", "http"],
  frontend: ["react", "ui", "css", "nextjs", "component", "accessibility"],
  ui: ["frontend", "react", "design", "accessibility"],
  deploy: ["deployment", "release", "ci", "vercel", "docker"],
  ci: ["github-actions", "workflow", "pipeline", "build"],
  build: ["compile", "build-error", "ci", "typecheck"],
  bug: ["debug", "fix", "error", "failure", "root-cause"],
  debug: ["bug", "error", "root-cause", "diagnose"],
  plan: ["planner", "planning", "architecture", "design", "spec"],
  architecture: ["architect", "design", "adr", "system"],
  research: ["search", "docs", "investigate", "explore"],
  python: ["django", "fastapi", "pytest"],
  typescript: ["ts", "node", "react", "nextjs"],
  go: ["golang"],
  golang: ["go"],
  ml: ["machine-learning", "model", "pytorch", "data"],
  docker: ["container", "dockerfile", "deploy"],
};

/** Stack words: languages plus the frameworks that imply them. */
const STACKS: Record<string, string> = {
  typescript: "typescript", javascript: "typescript", node: "typescript", react: "typescript", nextjs: "typescript", vue: "typescript", nuxt: "typescript",
  python: "python", django: "python", fastapi: "python",
  golang: "golang", go: "golang", rust: "rust", java: "java", spring: "java", kotlin: "java",
  php: "php", laravel: "php", ruby: "ruby", rails: "ruby", swift: "swift", ios: "swift", csharp: "csharp", dotnet: "csharp",
};

const STOP = new Set(["a", "an", "the", "and", "or", "for", "to", "of", "in", "on", "with", "my", "our", "i", "we", "want", "need", "how", "do", "help", "me", "some", "is", "it", "this", "that", "be", "using", "use", "write", "make", "add", "new", "get", "set", "up", "can", "should", "about", "into", "from"]);

export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9+#.-]+/).map(t => t.replace(/^[.-]+|[.-]+$/g, "")).filter(t => t.length > 1 && !STOP.has(t));
}

function expand(tokens: string[]): Map<string, number> {
  const weights = new Map<string, number>();
  for (const token of tokens) {
    weights.set(token, Math.max(weights.get(token) ?? 0, 1));
    const stem = token.replace(/(?:ing|ers|er|es|s)$/, "");
    if (stem.length > 2 && stem !== token) weights.set(stem, Math.max(weights.get(stem) ?? 0, 0.9));
    for (const synonym of SYNONYMS[token] ?? SYNONYMS[stem] ?? []) weights.set(synonym, Math.max(weights.get(synonym) ?? 0, 0.5));
  }
  return weights;
}

export interface ConsultMatch { kind: CatalogKind | "mcp"; id: string; name: string; description: string; score: number; why: string[]; install: string }

function scoreText(weights: Map<string, number>, fields: Array<[string, number, string]>, direct: Set<string> = new Set()): { score: number; why: string[] } {
  let score = 0;
  const why = new Set<string>();
  let directHits = 0;
  const tokenized = fields.map(([text, fieldWeight, label]) => [tokenize(text), fieldWeight, label] as const);
  for (const [term, weight] of weights) {
    for (const [words, fieldWeight, label] of tokenized) {
      const hit = words.some(w => w === term || (term.length > 3 && w.startsWith(term)));
      if (hit) { score += weight * fieldWeight; why.add(`${label}: ${term}`); if (direct.has(term)) directHits += 1; break; }
    }
  }
  // Items that cover more of what was asked rank above items that match one word strongly.
  if (direct.size > 1) score *= 0.6 + 0.8 * (directHits / direct.size);
  return { score, why: [...why].slice(0, 3) };
}

function itemKey(item: CatalogItem): string {
  return `${item.kind}:${item.kind === "rule" && item.language ? `${item.language}/${item.id}` : item.id}`;
}

export interface ConsultOptions { limit?: number; kinds?: Array<CatalogKind | "mcp">; /** Stacks detected in the project: their items rank higher, other stacks lower. */ languages?: string[] }

export function consultCatalog(catalog: HarnessCatalog, query: string, options: ConsultOptions = {}): ConsultMatch[] {
  const asked = tokenize(query);
  const weights = expand(asked);
  if (!weights.size) return [];
  const direct = new Set(asked.flatMap(t => { const stem = t.replace(/(?:ing|ers|er|es|s)$/, ""); return stem.length > 2 && stem !== t ? [t, stem] : [t]; }));
  const limit = options.limit ?? 12;
  const matches: ConsultMatch[] = [];
  for (const item of catalog.items) {
    if (options.kinds && !options.kinds.includes(item.kind)) continue;
    const headings = item.body.split("\n").filter(line => /^#{1,3}\s/.test(line)).join(" ");
    const { score, why } = scoreText(weights, [
      [item.id.replace(/-/g, " "), 6, "name"],
      [item.name, 5, "name"],
      [[...item.tags, ...(item.languages ?? []), item.language ?? ""].join(" "), 4, "tag"],
      [item.description, 3, "description"],
      [headings, 1.5, "section"],
    ], direct);
    const stackTags = item.tags.filter(tag => tag in STACKS);
    const stacks = [...new Set([...(item.languages ?? []), ...(item.kind === "rule" && item.language && item.language !== "common" ? [item.language] : []), ...stackTags.map(tag => STACKS[tag] as string)])];
    const named = [...stacks, ...stackTags, ...tokenize(item.id.replace(/-/g, " ")).filter(word => word in STACKS)].some(word => direct.has(word));
    const stackFactor = !stacks.length || !options.languages?.length || named ? 1 : stacks.some(stack => options.languages?.includes(stack)) ? 1.3 : 0.6;
    const adjusted = score * stackFactor;
    if (adjusted < 2.5) continue;
    matches.push({ kind: item.kind, id: item.id, name: item.name, description: item.description, score: Math.round(adjusted * 10) / 10, why, install: `forge install --with ${itemKey(item)}` });
  }
  if (!options.kinds || options.kinds.includes("mcp")) {
    for (const entry of MCP_CATALOG as readonly McpCatalogEntry[]) {
      const { score, why } = scoreText(weights, [[entry.name.replace(/-/g, " "), 6, "name"], [entry.description, 3, "description"]], direct);
      if (score < 2.5) continue;
      matches.push({ kind: "mcp", id: entry.name, name: entry.name, description: entry.description, score: Math.round(score * 10) / 10, why, install: `forge mcp add ${entry.name}` });
    }
  }
  return matches.sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)).slice(0, limit);
}

export async function consult(query: string, options: ConsultOptions & { catalog?: HarnessCatalog } = {}): Promise<ConsultMatch[]> {
  const catalog = options.catalog ?? await loadHarnessCatalog();
  return consultCatalog(catalog, query, options);
}

export function formatConsult(query: string, matches: ConsultMatch[]): string {
  if (!matches.length) return `Nothing in the FORGE catalog matches "${query}". Try broader words, or browse with \`forge catalog\` and \`forge mcp catalog\`.`;
  const width = Math.max(...matches.map(m => `${m.kind}:${m.id}`.length));
  const lines = [`FORGE consult · "${query}"`, ""];
  for (const m of matches) lines.push(`  ${`${m.kind}:${m.id}`.padEnd(width)}  ${m.description.slice(0, 90)}`);
  const items = matches.filter(m => m.kind !== "mcp").slice(0, 6);
  const mcp = matches.filter(m => m.kind === "mcp").slice(0, 3);
  lines.push("", "Add them:");
  if (items.length) lines.push(`  forge install --with ${items.map(m => m.install.replace("forge install --with ", "")).join(",")} --dry-run`);
  if (mcp.length) lines.push(`  forge mcp add ${mcp.map(m => m.id).join(" ")}`);
  return lines.join("\n");
}
