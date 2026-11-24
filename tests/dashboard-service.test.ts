import { describe, expect, it } from "vitest";
import { remoteContext, doctorFromRemote, harnessCoverage, parseInstinctCards, parseLoopCard, parseMemoryCards, parseRepoFullName } from "../src/github/dashboard-service.js";

describe("dashboard data", () => {
  it("parses committed memory newest first and ignores malformed entries", () => {
    const raw = JSON.stringify({ version: 1, entries: [
      { id: "mem-a", kind: "decision", content: "Use zod", tags: [], evidence: ["src/schema.ts"], source: "cli", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "mem-b", kind: "handoff", content: "x".repeat(5000), tags: ["auto-handoff"], createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" },
      { kind: "fact" }, null,
    ] });
    const cards = parseMemoryCards(raw);
    expect(cards.map(c => c.id)).toEqual(["mem-b", "mem-a"]);
    expect(cards[0]?.content.length).toBe(1200);
    expect(cards[1]?.evidence).toEqual(["src/schema.ts"]);
    expect(parseMemoryCards("not json")).toEqual([]);
  });

  it("parses instincts and loop receipts defensively", () => {
    const instincts = parseInstinctCards(JSON.stringify({ version: 1, instincts: [{ id: "inst-1", trigger: "editing api/**", action: "update spec", status: "active", confidence: 7, source: "manual", domain: "api" }, { id: 3 }] }));
    expect(instincts).toEqual([{ id: "inst-1", trigger: "editing api/**", action: "update spec", status: "active", confidence: 1, source: "manual", domain: "api", occurrences: 1 }]);
    const loop = parseLoopCard(JSON.stringify({ id: "loop-1", status: "needs-review", goal: "fix", agent: "claude", checks: ["npm test"], createdAt: "2026-11-23T00:00:00Z", reason: "r", baseline: { checks: [] },
      iterations: [{ checks: [{ command: "npm test", passed: true }], integrity: [{ kind: "deleted-test" }, { kind: "deleted-test" }] }] }));
    expect(loop).toMatchObject({ id: "loop-1", iterations: 1, integrity: ["deleted-test"], lastChecks: [{ command: "npm test", passed: true }] });
    expect(parseLoopCard("{}")).toBeUndefined();
  });

  it("reports which harnesses a repo uses and which FORGE covers", () => {
    const cards = harnessCoverage(["CLAUDE.md", ".windsurf/rules/a.md", ".github/copilot-instructions.md", "src/a.ts"], ["claude", "cursor"], ["claude", "cursor"]);
    const by = Object.fromEntries(cards.map(c => [c.target, c]));
    expect(cards).toHaveLength(10);
    expect(by.claude).toMatchObject({ detected: true, installed: true, guarded: true });
    expect(by.cursor).toMatchObject({ installed: true, guarded: true });
    expect(by.windsurf?.guarded).toBe(false);
    expect(by.windsurf).toMatchObject({ detected: true, installed: false });
    expect(by.copilot?.detected).toBe(true);
    expect(by.kiro?.detected).toBe(false);
  });

  it("maps remote setup into a doctor report and validates repo names", () => {
    const doctor = doctorFromRemote({ installed: true, healthy: false, state: { forgeVersion: "2.0.1", profile: "standard", targets: ["claude"], installedAt: "x", hooks: true }, missing: ["a"], outdated: ["b", "c"], added: [] }, "3.0.0");
    expect(doctor).toMatchObject({ installed: true, hooks: true, targets: ["claude"] });
    expect(doctor.summary).toEqual({ ok: 0, missing: 1, modified: 0, outdated: 2 });
    expect(parseRepoFullName("ansh44233/FORGE-ECC")).toEqual({ owner: "ansh44233", repo: "FORGE-ECC" });
    expect(parseRepoFullName("../etc")).toBeUndefined();
  });

  it("builds the context budget and MCP matrix from committed files", async () => {
    const files: Record<string, string> = {
      "AGENTS.md": "a".repeat(12_000),
      "CLAUDE.md": "# hi",
      ".mcp.json": JSON.stringify({ mcpServers: { context7: { command: "npx" } } }),
      ".cursor/mcp.json": JSON.stringify({ mcpServers: {} }),
      "src/index.ts": "ignored",
    };
    const fetched: string[] = [];
    const client = { getFileText: async (_o: string, _r: string, file: string) => { fetched.push(file); return files[file]; } };
    const entries = Object.keys(files).map(file => ({ path: file, type: "blob", size: files[file]!.length }));
    const { context, mcp } = await remoteContext(client as never, "o", "r", "main", entries);
    expect(fetched.includes("src/index.ts")).toBe(false);
    expect(context.worst).toBe(3000);
    expect(context.findings[0]?.id).toBe("CTX-INSTRUCTIONS-LARGE");
    expect(mcp.map(row => [row.name, row.targets.claude, row.targets.cursor])).toEqual([["context7", true, false]]);
  });
});
