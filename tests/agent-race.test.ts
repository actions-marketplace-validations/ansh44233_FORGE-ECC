import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanRace, formatRace, listRaces, parseContestants, pickRace, rankEntries, runRace, type RaceEntry } from "../src/core/agent-race.js";

const directories: string[] = [];
async function repo(): Promise<{ root: string; agents: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-race-"));
  const agents = await mkdtemp(path.join(os.tmpdir(), "forge-race-agents-"));
  directories.push(root, agents);
  await writeFile(path.join(root, "sum.js"), "module.exports = (a, b) => a - b;\n");
  await mkdir(path.join(root, "tests"));
  await writeFile(path.join(root, "tests/sum.test.js"), 'const sum = require("../sum.js");\nif (sum(2, 3) !== 5) { console.error("expected 5"); process.exit(1); }\n');
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "forge@example.com");
  git("config", "user.name", "FORGE test");
  git("add", "-A");
  git("commit", "-qm", "init");
  await writeFile(path.join(agents, "fix.mjs"), 'import { writeFileSync } from "node:fs";\nwriteFileSync("sum.js", "module.exports = (a, b) => a + b;\\n");\n');
  await writeFile(path.join(agents, "verbose-fix.mjs"), 'import { writeFileSync } from "node:fs";\nwriteFileSync("sum.js", "// add two numbers\\n// carefully\\nmodule.exports = function sum(a, b) {\\n  return a + b;\\n};\\n");\n');
  await writeFile(path.join(agents, "cheat.mjs"), 'import { rmSync } from "node:fs";\nrmSync("tests/sum.test.js");\n');
  return { root, agents };
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
const check = "node -e \"const fs=require('fs');if(!fs.existsSync('tests/sum.test.js'))process.exit(0);require('child_process').execSync('node tests/sum.test.js',{stdio:'inherit'})\"";

describe("agent race", () => {
  it("runs contestants in isolated worktrees and ranks by FORGE's own checks", async () => {
    const { root, agents } = await repo();
    const race = await runRace({
      projectPath: root,
      goal: "make sum add",
      checks: [check],
      contestants: [
        { name: "cheater", agent: "command", agentCommand: ["node", path.join(agents, "cheat.mjs")] },
        { name: "verbose", agent: "command", agentCommand: ["node", path.join(agents, "verbose-fix.mjs")] },
        { name: "tight", agent: "command", agentCommand: ["node", path.join(agents, "fix.mjs")] },
      ],
      maxIterations: 2,
    });
    expect(race.entries.map(e => [e.name, e.status])).toEqual([["tight", "passed"], ["verbose", "passed"], ["cheater", "needs-review"]]);
    expect(race.winner).toBe("tight");
    expect(race.entries[0]?.filesChanged).toEqual(["sum.js"]);
    expect(race.entries[2]?.integrity.join()).toContain("deleted-test");
    // The main working tree is untouched until a pick.
    expect(await readFile(path.join(root, "sum.js"), "utf8")).toContain("a - b");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root }).toString()).toBe("");
    expect(formatRace(race)).toContain("Winner: tight");
    expect((await listRaces(root))[0]?.id).toBe(race.id);

    const picked = await pickRace(root, race.id);
    expect(picked.entry.name).toBe("tight");
    expect(await readFile(path.join(root, "sum.js"), "utf8")).toContain("a + b");

    const cleaned = await cleanRace(root, race.id);
    expect(cleaned.removed.sort()).toEqual(["cheater", "tight", "verbose"]);
    await expect(stat(path.join(root, ".forge/races", race.id))).rejects.toThrow();
    expect(execFileSync("git", ["worktree", "list"], { cwd: root }).toString().trim().split("\n")).toHaveLength(1);
  });

  it("validates contestants and ranking", async () => {
    expect(() => parseContestants("claude,nope")).toThrow("Unknown agent");
    expect(parseContestants("claude,codex", [{ name: "mine", command: "node a.js" }]).map(c => c.name)).toEqual(["claude", "codex", "mine"]);
    const { root } = await repo();
    await expect(runRace({ projectPath: root, goal: "x", checks: ["true"], contestants: [{ name: "a", agent: "claude" }] })).rejects.toThrow("at least two");
    await expect(runRace({ projectPath: root, goal: "x", checks: ["true"], contestants: [{ name: "a", agent: "claude" }, { name: "a", agent: "codex" }] })).rejects.toThrow("appears twice");
    const entry = (name: string, status: RaceEntry["status"], lines: number): RaceEntry => ({ name, agent: "claude", worktree: "", status, reason: "", iterations: 1, durationMs: 1, filesChanged: [], linesAdded: lines, linesRemoved: 0, checksPassed: status === "passed" ? 1 : 0, checksTotal: 1, integrity: [], rank: 0 });
    expect(rankEntries([entry("a", "failed", 1), entry("b", "passed", 9), entry("c", "passed", 2)]).map(e => e.name)).toEqual(["c", "b", "a"]);
  });
});
