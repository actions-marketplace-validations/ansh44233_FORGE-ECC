import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_CATALOG, addMcpServers, codexServerNames, formatMatrix, mcpMatrix, readSyncSource, removeMcpServers, renderCodexTable, renderJsonEntry, toNeutral, writeCodexBlock } from "../src/core/mcp-sync.js";

const directories: string[] = [];
async function project(files: Record<string, string> = {}): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forge-mcp-"));
  directories.push(directory);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), content);
  }
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
const read = async (root: string, file: string) => JSON.parse(await readFile(path.join(root, file), "utf8"));
const all = ["claude", "cursor", "codex", "gemini", "copilot", "opencode", "kiro"] as const;

describe("MCP sync", () => {
  it("pins every catalog package and never uses plain HTTP", () => {
    for (const entry of MCP_CATALOG) {
      if (entry.transport === "stdio") expect(entry.args?.some(arg => /@\d+\.\d+\.\d+$/.test(arg))).toBe(true);
      else expect(entry.url?.startsWith("https://")).toBe(true);
    }
  });

  it("renders each harness's env reference syntax", () => {
    const server = { name: "supa", transport: "stdio" as const, command: "npx", args: ["-y", "x@1.0.0"], env: ["TOKEN"] };
    expect(renderJsonEntry("claude", server)).toEqual({ command: "npx", args: ["-y", "x@1.0.0"], env: { TOKEN: "${TOKEN}" } });
    expect(renderJsonEntry("cursor", server).env).toEqual({ TOKEN: "${env:TOKEN}" });
    expect(renderJsonEntry("gemini", server).env).toEqual({ TOKEN: "$TOKEN" });
    expect(renderJsonEntry("copilot", server).type).toBe("stdio");
    expect(renderJsonEntry("opencode", server)).toEqual({ type: "local", command: ["npx", "-y", "x@1.0.0"], enabled: true, environment: { TOKEN: "{env:TOKEN}" } });
    expect(renderCodexTable(server)).toBe('[mcp_servers.supa]\ncommand = "npx"\nargs = ["-y", "x@1.0.0"]\nenv_vars = ["TOKEN"]');
    const remote = { name: "gh", transport: "http" as const, url: "https://api.example.com/mcp", headers: { Authorization: "GH_PAT" } };
    expect(renderJsonEntry("gemini", remote)).toEqual({ httpUrl: "https://api.example.com/mcp", headers: { Authorization: "Bearer $GH_PAT" } });
    expect(renderCodexTable(remote)).toContain('bearer_token_env_var = "GH_PAT"');
  });

  it("refuses to spread literal secrets or plain-HTTP remotes", () => {
    expect(toNeutral("x", { command: "npx", env: { TOKEN: "abc123" } }).problem).toContain("literal");
    expect(toNeutral("x", { command: "npx", env: { TOKEN: "${TOKEN}" } }).server?.env).toEqual(["TOKEN"]);
    expect(toNeutral("x", { url: "http://evil.example/mcp" }).problem).toContain("https");
    expect(toNeutral("x", { type: "http", url: "https://ok.example/mcp", headers: { Authorization: "Bearer ${API_KEY}" } }).server?.headers).toEqual({ Authorization: "API_KEY" });
  });

  it("adds catalog servers to every harness, keeps user entries and removes only its own", async () => {
    const root = await project({
      ".mcp.json": JSON.stringify({ mcpServers: { mine: { command: "node", args: ["srv.js"] } } }),
      ".gemini/settings.json": JSON.stringify({ theme: "dark" }),
      ".codex/config.toml": 'model = "gpt-5"\n\n[mcp_servers.playwright]\ncommand = "my-playwright"\n',
    });
    const servers = MCP_CATALOG.filter(s => s.name === "context7" || s.name === "playwright");
    const changes = await addMcpServers(servers, { projectPath: root, targets: [...all] });
    expect(changes.filter(c => c.action === "add")).toHaveLength(13);
    expect(changes.find(c => c.target === "codex" && c.server === "playwright")?.action).toBe("skip");
    expect(Object.keys((await read(root, ".mcp.json")).mcpServers).sort()).toEqual(["context7", "mine", "playwright"]);
    expect((await read(root, ".gemini/settings.json")).theme).toBe("dark");
    expect(Object.keys((await read(root, ".vscode/mcp.json")).servers)).toEqual(["context7", "playwright"]);
    expect((await read(root, "opencode.json")).mcp.context7.type).toBe("local");
    const codex = await readFile(path.join(root, ".codex/config.toml"), "utf8");
    expect(codex).toContain('model = "gpt-5"');
    expect(codexServerNames(codex)).toEqual({ all: ["playwright", "context7"], managed: ["context7"] });
    // Idempotent.
    const again = await addMcpServers(servers, { projectPath: root, targets: [...all] });
    expect(again.every(c => c.action === "unchanged" || c.action === "skip")).toBe(true);
    expect(await readFile(path.join(root, ".codex/config.toml"), "utf8")).toBe(codex);

    const matrix = await mcpMatrix(root);
    const mine = matrix.find(r => r.name === "mine");
    expect(mine?.managed).toBe(false);
    expect([mine?.targets.claude, mine?.targets.cursor]).toEqual([true, false]);
    expect(formatMatrix(matrix)).toContain("forge mcp sync");

    await removeMcpServers(["context7", "playwright", "mine"], { projectPath: root, targets: [...all] });
    expect(Object.keys((await read(root, ".mcp.json")).mcpServers)).toEqual(["mine"]);
    expect(await read(root, ".gemini/settings.json")).toEqual({ theme: "dark" });
    expect(await readFile(path.join(root, ".codex/config.toml"), "utf8")).toBe('model = "gpt-5"\n\n[mcp_servers.playwright]\ncommand = "my-playwright"\n');
    await expect(readFile(path.join(root, ".vscode/mcp.json"), "utf8")).rejects.toThrow();
  });

  it("syncs .mcp.json to the other harnesses and reports what it cannot copy", async () => {
    const root = await project({ ".mcp.json": JSON.stringify({ mcpServers: { db: { command: "npx", args: ["-y", "db-mcp@1.2.3"], env: { DB_URL: "${DB_URL}" } }, leaky: { command: "x", env: { KEY: "sk-live-123" } } } }) });
    const { servers, problems } = await readSyncSource(root);
    expect(servers.map(s => s.name)).toEqual(["db"]);
    expect(problems[0]?.name).toBe("leaky");
    await addMcpServers(servers, { projectPath: root, targets: ["cursor", "gemini"], source: "sync" });
    expect((await read(root, ".cursor/mcp.json")).mcpServers.db.env).toEqual({ DB_URL: "${env:DB_URL}" });
  });

  it("does not rewrite JSON with comments", async () => {
    const root = await project({ ".cursor/mcp.json": '{ // mine\n "mcpServers": {} }' });
    const changes = await addMcpServers(MCP_CATALOG.slice(0, 1), { projectPath: root, targets: ["cursor"] });
    expect(changes[0]?.action).toBe("skip");
    expect(writeCodexBlock("", new Map())).toBe("");
  });
});
