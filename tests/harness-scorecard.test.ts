import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installHarness } from "../src/core/harness-installer.js";
import { addProjectMemory } from "../src/core/project-memory.js";
import { addManualInstinct } from "../src/core/instincts.js";
import { buildScorecard, formatScorecard, formatScorecardMarkdown } from "../src/core/harness-scorecard.js";

const directories: string[] = [];
async function project(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forge-score-"));
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
const now = () => new Date("2026-11-23T10:00:00Z");
const pkg = JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit", lint: "eslint .", build: "tsc" } });

describe("harness scorecard", () => {
  it("scores an empty project low and points at the first actions", async () => {
    const card = await buildScorecard({ projectPath: await project({ "package.json": "{}" }), forgeVersion: "test", now });
    expect(card.categories.map(c => c.id)).toEqual(["install", "coverage", "security", "guards", "quality-gates", "context", "memory", "learning", "ci"]);
    expect(card.categories.find(c => c.id === "install")?.score).toBe(0);
    expect(card.grade).toBe("F");
    expect(card.topActions.length).toBeGreaterThan(0);
    expect(card.topActions.some(a => /forge install/.test(a))).toBe(true);
  });

  it("is deterministic and rewards a well-prepared repository", async () => {
    const root = await project({
      "package.json": pkg,
      "README.md": "# demo\n",
      ".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - run: npm test\n      - run: npx forge shield .\n",
      ".github/dependabot.yml": "version: 2\n",
    });
    await installHarness({ projectPath: root, forgeVersion: "test", targets: ["claude", "codex"], hooks: true });
    await addProjectMemory(root, { kind: "decision", content: "Use ESM only", evidence: ["package.json"] });
    await addProjectMemory(root, { kind: "constraint", content: "Node 20+" });
    await addProjectMemory(root, { kind: "handoff", content: "Finished the parser" });
    await addProjectMemory(root, { kind: "lesson", content: "Run tests serially" });
    await addManualInstinct(root, "editing src/**", "run the unit tests");
    const first = await buildScorecard({ projectPath: root, forgeVersion: "test", now });
    const second = await buildScorecard({ projectPath: root, forgeVersion: "test", now });
    expect(second).toEqual(first);
    const score = (id: string) => first.categories.find(c => c.id === id)?.score;
    expect(score("install")).toBe(10);
    expect(score("guards")).toBe(10);
    expect(score("quality-gates")).toBe(10);
    expect(score("memory")).toBe(10);
    expect(score("ci")).toBe(10);
    expect(first.percent).toBeGreaterThan(75);
    expect(formatScorecard(first)).toContain("FORGE harness scorecard");
    expect(formatScorecardMarkdown(first)).toContain("| Runtime guards | 10/10 |");
  });

  it("flags harnesses the repo uses but FORGE does not cover", async () => {
    const root = await project({ "package.json": pkg, ".windsurf/rules/team.md": "x" });
    await installHarness({ projectPath: root, forgeVersion: "test", targets: ["claude"] });
    const coverage = (await buildScorecard({ projectPath: root, forgeVersion: "test", now })).categories.find(c => c.id === "coverage");
    expect(coverage?.actions.join(" ")).toMatch(/--target claude,windsurf/);
  });
});
