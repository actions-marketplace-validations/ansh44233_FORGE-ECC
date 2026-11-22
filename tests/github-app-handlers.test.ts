import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildCheckRun, gitBlobSha, handleIssueComment, handlePullRequest, parseForgeCommand, selectShieldPaths } from "../src/github/app-handlers.js";
import { createAppJwt, GitHubApiError, GitHubClient, loadPrivateKey, type FetchLike, type PullFile, type TreeEntry } from "../src/github/github-client.js";
import { assessPullRequestRisk } from "../src/github/pr-risk.js";
import { analyzeRepository, renderProjectSkill } from "../src/github/repo-analysis.js";
import { buildRepoOverview, parseRepoFullName, runDashboardAction } from "../src/github/dashboard-service.js";

type Files = Record<string, string>;

class FakeClient {
  comments: string[] = [];
  pulls: Array<{ branch: string; title: string; body: string; files: Array<{ path: string; content: string }> }> = [];
  checks: Array<Record<string, unknown>> = [];
  constructor(public files: Files, public options: { permission?: string; pullFiles?: PullFile[] } = {}) {}
  async getRepository() { return { default_branch: "main", private: false, full_name: "acme/app" }; }
  async getTree(): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    return { truncated: false, entries: Object.entries(this.files).map(([path, content]) => ({ path, type: "blob" as const, size: content.length, sha: gitBlobSha(content) })) };
  }
  async getFileText(_o: string, _r: string, path: string) { return this.files[path]; }
  async listCommits() { return ["feat(api): add users", "fix(ui): button focus", "chore: bump deps", "feat(api): pagination", "test: cover auth", "docs: readme", "feat(ui): modal", "fix(api): 404", "refactor(core): split", "ci: cache"].map((message, index) => ({ sha: String(index), message })); }
  async listPullFiles() { return this.options.pullFiles ?? []; }
  async getPull() { return { head: { sha: "head123", ref: "feature", repo: { full_name: "acme/app" } }, base: { ref: "main" } }; }
  async getCollaboratorPermission() { if (!this.options.permission) throw new GitHubApiError(404, "not a collaborator"); return this.options.permission; }
  async createIssueComment(_o: string, _r: string, _i: number, body: string) { this.comments.push(body); return { html_url: "https://github.com/acme/app/issues/1#c" }; }
  async createCheckRun(_o: string, _r: string, check: Record<string, unknown>) { this.checks.push(check); return { id: 1, html_url: "https://github.com/acme/app/runs/1" }; }
  repo(owner: string, repo: string) { return `/repos/${owner}/${repo}`; }
  async request(_method: string, path: string) { if (path.includes("/pulls?state=open")) return [{ number: 5, title: "feat: billing", html_url: "https://github.com/acme/app/pull/5", user: { login: "dev" } }]; return []; }
  async openPullRequestWithFiles(options: { branch: string; title: string; body: string; files: Array<{ path: string; content: string }> }) { this.pulls.push(options); return { html_url: "https://github.com/acme/app/pull/7", number: 7 }; }
}

const REPO: Files = {
  "package.json": JSON.stringify({ type: "module", packageManager: "pnpm@9.0.0", scripts: { typecheck: "tsc --noEmit", test: "vitest run", build: "tsc" }, dependencies: { react: "^19.0.0", zod: "^4.0.0" }, devDependencies: { vitest: "^3.0.0" } }),
  "pnpm-lock.yaml": "lockfileVersion: 9",
  "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true } }",
  "src/index.ts": "export {};",
  "src/users.ts": "export {};",
  "tests/users.test.ts": "import 'vitest';",
  "AGENTS.md": "# Team rules\n\nAlways use pnpm.\n",
  ".github/workflows/ci.yml": "on: push\npermissions:\n  contents: read\njobs: {}\n",
};

const comment = (body: string, extra: Record<string, unknown> = {}) => ({
  action: "created",
  comment: { body, user: { login: "dev", type: "User" }, author_association: "OWNER" },
  issue: { number: 1 },
  repository: { name: "app", owner: { login: "acme" } },
  sender: { type: "User", login: "dev" },
  ...extra,
});

const context = (client: FakeClient) => ({ client: client as unknown as GitHubClient, forgeVersion: "2.0.0-test" });

describe("GitHub App commands", () => {
  it("parses /forge commands and options", () => {
    expect(parseForgeCommand("/forge analyze --targets claude,cursor --profile minimal")).toMatchObject({ command: "analyze" });
    expect(parseForgeCommand("/forge analyze --targets claude,cursor")?.options.get("target")).toBe("claude,cursor");
    expect(parseForgeCommand("thanks!\n/forge audit")).toBeUndefined();
    expect(parseForgeCommand("/forge launch-rockets")?.flags.has("unknown")).toBe(true);
  });

  it("/forge analyze opens a setup PR that preserves existing files", async () => {
    const client = new FakeClient({ ...REPO });
    const result = await handleIssueComment(context(client), comment("/forge analyze"));
    expect(result.action).toBe("analyze");
    expect(client.pulls).toHaveLength(1);
    const pull = client.pulls[0]!;
    expect(pull.branch).toBe("forge/setup");
    const paths = pull.files.map(file => file.path);
    expect(paths).toContain(".claude/agents/forge-planner.md");
    expect(paths).toContain(".cursor/rules/forge-typescript-typescript-style.mdc");
    expect(paths).toContain(".claude/skills/forge-project/SKILL.md");
    expect(paths).toContain(".forge/install-state.json");
    const agents = pull.files.find(file => file.path === "AGENTS.md")!.content;
    expect(agents.startsWith("# Team rules\n\nAlways use pnpm.")).toBe(true);
    expect(agents).toContain("forge:begin");
    const skill = pull.files.find(file => file.path === ".claude/skills/forge-project/SKILL.md")!.content;
    expect(skill).toContain("pnpm typecheck");
    expect(skill).toContain("Conventional Commits");
    expect(pull.body).toContain("FORGE Shield");
    expect(client.comments.at(-1)).toContain("https://github.com/acme/app/pull/7");
  });

  it("is idempotent once the setup PR is merged", async () => {
    const first = new FakeClient({ ...REPO });
    await handleIssueComment(context(first), comment("/forge analyze"));
    const merged: Files = { ...REPO };
    for (const file of first.pulls[0]!.files) merged[file.path] = file.content;
    const second = new FakeClient(merged);
    const result = await handleIssueComment(context(second), comment("/forge repair"));
    expect(second.pulls.map(pull => pull.files.map(file => file.path))).toEqual([]);
    expect(result.detail).toBe("up to date");
    expect(second.pulls).toHaveLength(0);
  });

  it("rejects commands from users without write access and ignores bots", async () => {
    const client = new FakeClient({ ...REPO });
    const rejected = await handleIssueComment(context(client), comment("/forge analyze", { comment: { body: "/forge analyze", user: { login: "drive-by", type: "User" }, author_association: "NONE" } }));
    expect(rejected.action).toBe("rejected");
    expect(client.pulls).toHaveLength(0);
    const bot = await handleIssueComment(context(client), comment("/forge analyze", { sender: { type: "Bot", login: "forge[bot]" } }));
    expect(bot.handled).toBe(false);
  });

  it("/forge audit comments a Shield report and /forge doctor explains a missing install", async () => {
    const client = new FakeClient({ ...REPO, ".mcp.json": JSON.stringify({ mcpServers: { x: { url: "http://remote.example/mcp" } } }) });
    await handleIssueComment(context(client), comment("/forge audit"));
    expect(client.comments.at(-1)).toContain("SHIELD-MCP-001");
    await handleIssueComment(context(client), comment("/forge doctor"));
    expect(client.comments.at(-1)).toContain("not installed");
  });

  it("creates a failing check run when a PR introduces risky agent configuration", async () => {
    const client = new FakeClient({ ...REPO, ".claude/settings.json": JSON.stringify({ permissions: { defaultMode: "bypassPermissions", deny: ["Read(./.env)"] } }) }, {
      pullFiles: [{ filename: ".claude/settings.json", status: "added", additions: 3, deletions: 0, changes: 3 }, { filename: "src/users.ts", status: "modified", additions: 40, deletions: 2, changes: 42 }],
    });
    const result = await handlePullRequest(context(client), { action: "opened", pull_request: { number: 3, head: { sha: "head123" } }, repository: { name: "app", owner: { login: "acme" } } });
    expect(result.action).toBe("check-run");
    const check = client.checks[0]!;
    expect(check.conclusion).toBe("failure");
    const output = check.output as { annotations: Array<{ path: string }>; summary: string };
    expect(output.annotations[0]?.path).toBe(".claude/settings.json");
    expect(output.summary).toContain("Change risk");
  });
});

describe("GitHub building blocks", () => {
  it("signs App JWTs that verify with the public key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const jwt = createAppJwt(42, pem.replace(/\n/g, "\\n"), new Date("2026-11-22T00:00:00Z"));
    const [header, payload, signature] = jwt.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, Buffer.from(signature!.replace(/-/g, "+").replace(/_/g, "/"), "base64"))).toBe(true);
    expect(JSON.parse(Buffer.from(payload!, "base64").toString()).iss).toBe("42");
  });

  it("reads private keys pasted into environment variables in common broken formats", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const variants = [
      pkcs1,
      pkcs8,
      pkcs1.replace(/\n/g, "\\n"),
      `"${pkcs1.replace(/\n/g, "\\n")}"`,
      pkcs1.replace(/\n/g, " "),
      pkcs1.replace(/\n/g, "\r\n"),
      Buffer.from(pkcs1).toString("base64"),
      `  ${pkcs8}  `,
    ];
    for (const variant of variants) {
      const jwt = createAppJwt(7, variant);
      const [header, payload, signature] = jwt.split(".");
      const verifier = createVerify("RSA-SHA256");
      verifier.update(`${header}.${payload}`);
      expect(verifier.verify(publicKey, Buffer.from(signature!.replace(/-/g, "+").replace(/_/g, "/"), "base64"))).toBe(true);
    }
    expect(() => loadPrivateKey("not a key")).toThrow(/GITHUB_APP_PRIVATE_KEY could not be read/);
  });

  it("mints repository-scoped installation tokens and opens PRs through the git data API", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown; auth?: string }> = [];
    const responses: Record<string, unknown> = {
      "POST /app/installations/9/access_tokens": { token: "inst-token" },
      "GET /repos/acme/app/git/ref/heads/main": { object: { sha: "base-sha" } },
      "GET /repos/acme/app/git/commits/base-sha": { tree: { sha: "base-tree" } },
      "POST /repos/acme/app/git/trees": { sha: "new-tree" },
      "POST /repos/acme/app/git/commits": { sha: "new-commit" },
      "POST /repos/acme/app/git/refs": { ref: "refs/heads/forge/setup" },
      "POST /repos/acme/app/pulls": { html_url: "https://github.com/acme/app/pull/1", number: 1 },
    };
    const fetchImpl: FetchLike = async (url, init) => {
      const key = `${init?.method} ${url.replace("https://api.github.com", "").split("?")[0]}`;
      calls.push({ method: init?.method ?? "GET", url, ...(init?.body ? { body: JSON.parse(init.body) } : {}), ...(init?.headers?.Authorization ? { auth: init.headers.Authorization } : {}) });
      const body = responses[key];
      return { ok: body !== undefined, status: body !== undefined ? 200 : 404, json: async () => body ?? { message: "Not Found" }, text: async () => "" };
    };
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const client = await GitHubClient.forInstallation({ appId: 1, privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(), installationId: 9, repositories: ["app"], fetchImpl });
    expect(calls[0]?.auth).toMatch(/^Bearer /);
    expect(calls[0]?.body).toEqual({ repositories: ["app"] });
    const pull = await client.openPullRequestWithFiles({ owner: "acme", repo: "app", baseBranch: "main", branch: "forge/setup", title: "t", body: "b", message: "m", files: [{ path: "a.md", content: "hello" }] });
    expect(pull.number).toBe(1);
    const tree = calls.find(call => call.url.endsWith("/git/trees"))?.body as { base_tree: string; tree: Array<{ content: string }> };
    expect(tree.base_tree).toBe("base-tree");
    expect(tree.tree[0]?.content).toBe("hello");
    expect(calls.slice(1).every(call => call.auth === "token inst-token")).toBe(true);
  });

  it("selects only agent-configuration files for remote Shield scans", () => {
    const entries: TreeEntry[] = ["src/a.ts", "AGENTS.md", ".mcp.json", ".claude/agents/x.md", ".github/workflows/ci.yml", "node_modules/x/AGENTS.md", "docs/guide.md"].map(path => ({ path, type: "blob", size: 10, sha: "x" }));
    expect(selectShieldPaths(entries)).toEqual([".claude/agents/x.md", ".github/workflows/ci.yml", ".mcp.json", "AGENTS.md"]);
  });

  it("scores pull request risk with explanations", () => {
    const low = assessPullRequestRisk([{ filename: "src/a.ts", status: "modified", additions: 5, deletions: 1 }, { filename: "tests/a.test.ts", status: "modified", additions: 5, deletions: 0 }]);
    expect(low.level).toBe("low");
    const high = assessPullRequestRisk([
      { filename: ".github/workflows/deploy.yml", status: "modified", additions: 10, deletions: 2 },
      { filename: "src/auth/session.ts", status: "modified", additions: 120, deletions: 30 },
      { filename: "db/migrations/0042_users.sql", status: "added", additions: 20, deletions: 0 },
    ]);
    expect(["high", "critical"]).toContain(high.level);
    expect(high.reasons.map(r => r.reason).join(" ")).toMatch(/CI\/CD/);
    expect(high.reasons.some(r => /without any test changes/.test(r.reason))).toBe(true);
    expect(high.suggestedReviewers).toContain("security-reviewer");
  });

  it("profiles a repository and renders a project skill", () => {
    const profile = analyzeRepository({ name: "acme/app", files: Object.keys(REPO), manifests: { "package.json": REPO["package.json"]!, "tsconfig.json": REPO["tsconfig.json"]! }, commits: ["feat(api): x", "fix(api): y", "feat(ui): z", "docs: a", "chore: b", "feat(api): c", "test: d", "fix(ui): e", "ci: f", "feat(core): g"] });
    expect(profile.packageManager).toBe("pnpm");
    expect(profile.testFramework).toBe("Vitest");
    expect(profile.frameworks).toEqual(expect.arrayContaining(["React", "Zod"]));
    expect(profile.verifyCommands).toEqual(["pnpm typecheck", "pnpm test", "pnpm build"]);
    expect(profile.commitConvention.conventional).toBe(100);
    expect(profile.commitConvention.topScopes[0]).toBe("api");
    expect(renderProjectSkill(profile)).toMatch(/^---\nname: forge-project\n/);
  });

  it("builds a passing check run when nothing risky changed", () => {
    const shield = { schemaVersion: 1 as const, tool: "forge-shield" as const, generatedAt: "", filesScanned: 1, score: 100, grade: "A" as const, summary: { critical: 0, high: 0, medium: 0, low: 0 }, byCategory: {}, findings: [], caveats: [] };
    const check = buildCheckRun("sha", shield, assessPullRequestRisk([{ filename: "README.md", status: "modified", additions: 2, deletions: 1 }]), new Set(["README.md"]));
    expect(check.conclusion).toBe("success");
  });
});

describe("hosted dashboard service", () => {
  it("builds a repository overview with profile, setup, Shield and PR risk", async () => {
    const client = new FakeClient({ ...REPO, ".mcp.json": JSON.stringify({ mcpServers: { x: { url: "http://remote.example/mcp" } } }) }, { pullFiles: [{ filename: "src/billing/charge.ts", status: "modified", additions: 80, deletions: 5, changes: 85 }] });
    const overview = await buildRepoOverview(context(client), "acme", "app", [{ at: "2026-11-22T00:00:00Z", event: "issue_comment", action: "audit" }]);
    expect(overview.repository.defaultBranch).toBe("main");
    expect(overview.profile.packageManager).toBe("pnpm");
    expect(overview.setup.installed).toBe(false);
    expect(overview.shield.findings.some(item => item.ruleId === "SHIELD-MCP-001")).toBe(true);
    expect(overview.pulls[0]?.risk.reasons.some(reason => /billing/i.test(reason.reason))).toBe(true);
    expect(overview.history).toHaveLength(1);
  });

  it("only lets writers open setup pull requests from the dashboard", async () => {
    const reader = new FakeClient({ ...REPO }, { permission: "read" });
    await expect(runDashboardAction(context(reader), "acme", "app", "analyze", "viewer")).rejects.toThrow(/write access/);
    const writer = new FakeClient({ ...REPO }, { permission: "write" });
    const result = await runDashboardAction(context(writer), "acme", "app", "analyze", "dev");
    expect(result.url).toBe("https://github.com/acme/app/pull/7");
  });

  it("validates repository names", () => {
    expect(parseRepoFullName("acme/app")).toEqual({ owner: "acme", repo: "app" });
    for (const bad of ["acme", "acme/../x", "../x/y", "acme/app/extra", "a b/c", 42]) expect(parseRepoFullName(bad)).toBeUndefined();
  });
});
