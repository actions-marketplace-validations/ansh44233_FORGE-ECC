import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentInvocation, buildLoopPrompt, listLoops, readLoop, runVerifiedLoop } from "../src/core/verified-loop.js";

const directories: string[] = [];
async function repo(): Promise<{ root: string; agents: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-loop-"));
  const agents = await mkdtemp(path.join(os.tmpdir(), "forge-loop-agents-"));
  directories.push(root, agents);
  await writeFile(path.join(root, "sum.js"), "module.exports = (a, b) => a - b;\n");
  await mkdir(path.join(root, "tests"));
  await writeFile(path.join(root, "tests/sum.test.js"), 'const sum = require("../sum.js");\nif (sum(2, 3) !== 5) { console.error("expected 5 got " + sum(2, 3)); process.exit(1); }\n');
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node tests/sum.test.js" } }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "forge@example.com");
  git("config", "user.name", "FORGE test");
  git("add", "-A");
  git("commit", "-qm", "init");
  await writeFile(path.join(agents, "fix.mjs"), 'import { readFileSync, writeFileSync } from "node:fs";\nconst prompt = readFileSync(0, "utf8");\nif (!prompt.includes("expected 5")) process.exit(2);\nwriteFileSync("sum.js", "module.exports = (a, b) => a + b;\\n");\n');
  await writeFile(path.join(agents, "delete-test.mjs"), 'import { rmSync } from "node:fs";\nrmSync("tests/sum.test.js");\n');
  await writeFile(path.join(agents, "skip.mjs"), 'import { writeFileSync } from "node:fs";\nwriteFileSync("tests/extra.test.js", "test.skip(\\"later\\", () => {});\\n");\nwriteFileSync("sum.js", "module.exports = (a, b) => a + b;\\n");\n');
  await writeFile(path.join(agents, "noop.mjs"), "\n");
  return { root, agents };
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
const check = "node tests/sum.test.js";

describe("verified loop", () => {
  it("passes only when FORGE's own check run passes, and keeps a receipt", async () => {
    const { root, agents } = await repo();
    const record = await runVerifiedLoop({ projectPath: root, goal: "make sum add", checks: [check], agent: "command", agentCommand: ["node", path.join(agents, "fix.mjs")] });
    expect(record.status).toBe("passed");
    expect(record.baseline.checks[0]?.passed).toBe(false);
    expect(record.iterations).toHaveLength(1);
    expect(record.iterations[0]?.filesChanged).toEqual(["sum.js"]);
    expect((await readLoop(root))?.id).toBe(record.id);
    expect(await readFile(path.join(root, "sum.js"), "utf8")).toContain("a + b");
  });

  it("stops with needs-review when the agent deletes a test, even though checks go green", async () => {
    const { root, agents } = await repo();
    const record = await runVerifiedLoop({ projectPath: root, goal: "make sum add", checks: ["node -e \"process.exit(require('fs').existsSync('tests/sum.test.js') ? 1 : 0)\""], agent: "command", agentCommand: ["node", path.join(agents, "delete-test.mjs")] });
    expect(record.iterations[0]?.checks[0]?.passed).toBe(true);
    expect(record.status).toBe("needs-review");
    expect(record.iterations[0]?.integrity.map(i => i.kind)).toContain("deleted-test");
  });

  it("flags skip markers in new test files", async () => {
    const { root, agents } = await repo();
    const record = await runVerifiedLoop({ projectPath: root, goal: "make sum add", checks: [check], agent: "command", agentCommand: ["node", path.join(agents, "skip.mjs")] });
    expect(record.status).toBe("needs-review");
    expect(record.iterations[0]?.integrity.some(i => i.kind === "skip-marker" && i.file === "tests/extra.test.js")).toBe(true);
  });

  it("stops a stalled agent instead of burning the whole budget", async () => {
    const { root, agents } = await repo();
    const record = await runVerifiedLoop({ projectPath: root, goal: "make sum add", checks: [check], agent: "command", agentCommand: ["node", path.join(agents, "noop.mjs")], maxIterations: 6 });
    expect(record.status).toBe("stalled");
    expect(record.iterations.length).toBe(2);
  });

  it("refuses a dirty tree, needs checks, and supports dry runs", async () => {
    const { root } = await repo();
    await expect(runVerifiedLoop({ projectPath: root, goal: "x", checks: [], agent: "command", agentCommand: ["true"] })).rejects.toThrow(/--check/);
    const dry = await runVerifiedLoop({ projectPath: root, goal: "x", checks: [check], dryRun: true });
    expect(dry.status).toBe("dry-run");
    expect(dry.agentCommand.slice(0, 4)).toEqual(["claude", "-p", "<prompt>", "--permission-mode"]);
    await writeFile(path.join(root, "sum.js"), "changed\n");
    await expect(runVerifiedLoop({ projectPath: root, goal: "x", checks: [check] })).rejects.toThrow(/uncommitted/);
    expect(await listLoops(root)).toEqual([]);
  });

  it("never asks an agent to bypass its permission system", () => {
    for (const agent of ["claude", "codex", "gemini", "opencode"] as const) {
      const argv = agentInvocation(agent, "p").args.join(" ");
      expect(argv).not.toMatch(/dangerously|bypass|yolo|full-access/);
    }
    const prompt = buildLoopPrompt("goal", ["npm test"], undefined, [{ command: "npm test", exitCode: 1, passed: false, durationMs: 1, timedOut: false, outputTail: "boom" }], "");
    expect(prompt).toContain("boom");
    expect(prompt).toContain("Do not delete or skip tests");
  });
});
