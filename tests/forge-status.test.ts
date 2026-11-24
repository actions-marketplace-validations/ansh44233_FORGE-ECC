import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { forgeStatus, formatStatus } from "../src/core/forge-status.js";
import { installHarness } from "../src/core/harness-installer.js";
import { runNativeHook } from "../src/core/hook-adapters.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("forge status", () => {
  it("summarizes install, guard, context and MCP with next steps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forge-status-"));
    directories.push(root);
    const empty = await forgeStatus(root, "test");
    expect(empty.install.installed).toBe(false);
    expect(empty.next[0]).toBe("forge install . --hooks");

    await writeFile(path.join(root, "package.json"), "{}");
    await installHarness({ projectPath: root, forgeVersion: "test", targets: ["claude", "cursor", "codex"], profile: "minimal", hooks: true });
    await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { a: { command: "x" } } }));
    await writeFile(path.join(root, ".cursor/mcp.json"), JSON.stringify({ mcpServers: {} }));
    await runNativeHook("cursor", "beforeShellExecution", JSON.stringify({ command: "rm -rf /", workspace_roots: [root] }));
    const status = await forgeStatus(root, "test");
    expect(status.install.healthy).toBe(true);
    expect(status.guard.live).toEqual(["claude", "cursor", "codex"]);
    expect(status.guard.missing).toEqual([]);
    expect(status.guard.lastDay).toBe(1);
    expect(status.mcp).toEqual({ servers: 1, gaps: 1 });
    expect(status.next).toContain("forge mcp sync   # some MCP servers are missing in some tools");
    expect(formatStatus(status)).toContain("live in claude, cursor, codex");
  });
});
