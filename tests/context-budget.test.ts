import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeContext, estimateTokens, formatContextReport } from "../src/core/context-budget.js";

const directories: string[] = [];
async function project(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forge-ctx-"));
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
const para = (word: string) => `${word} `.repeat(40).trim();

describe("forge context", () => {
  it("measures what each harness loads and flags the heavy parts", async () => {
    const shared = `${para("alpha")}\n\n${para("beta")}\n\n${para("gamma")}\n\n${para("delta")}`;
    const root = await project({
      "CLAUDE.md": `# Project\n\nSee @docs/guide.md\n\n${shared}\n`,
      "docs/guide.md": shared,
      "AGENTS.md": "x".repeat(30_000),
      ".claude/rules/ts.md": "---\npaths: src/**/*.ts\n---\nTS only",
      ".claude/rules/always.md": "Always " + "y".repeat(400),
      ".claude/skills/big/SKILL.md": `---\nname: big\ndescription: ${"z".repeat(400)}\n---\nbody`,
      ".cursor/rules/a.mdc": "---\nalwaysApply: true\n---\n" + "c".repeat(20_000),
      ".cursor/rules/b.mdc": "---\nglobs: '*.py'\n---\n" + "d".repeat(20_000),
      ".mcp.json": JSON.stringify({ mcpServers: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}`, { command: "x" }])) }),
    });
    const report = await analyzeContext(root);
    const by = Object.fromEntries(report.harnesses.map(h => [h.harness, h]));
    expect(by.claude?.items.map(i => i.file)).toEqual(expect.arrayContaining(["CLAUDE.md", "docs/guide.md", ".claude/rules/always.md", ".claude/skills/big/SKILL.md"]));
    expect(by.claude?.items.some(i => i.file === ".claude/rules/ts.md")).toBe(false);
    expect(by.claude?.mcpServers).toBe(9);
    expect(by.codex?.tokens).toBe(estimateTokens("x".repeat(30_000)));
    expect(by.cursor?.items.map(i => i.file)).toEqual([".cursor/rules/a.mdc"]);
    const ids = report.findings.map(f => f.id);
    expect(ids).toEqual(expect.arrayContaining(["CTX-INSTRUCTIONS-HUGE", "CTX-CURSOR-ALWAYS", "CTX-LONG-DESCRIPTION", "CTX-DUPLICATE", "CTX-MCP-MANY"]));
    expect(report.findings[0]?.severity).toBe("high");
    expect(report.grade).toBe("B");
    expect(formatContextReport(report)).toContain("AGENTS.md");
  });

  it("grades an empty project A", async () => {
    const report = await analyzeContext(await project({ "README.md": "hi" }));
    expect(report.grade).toBe("A");
    expect(report.findings).toEqual([]);
  });
});
