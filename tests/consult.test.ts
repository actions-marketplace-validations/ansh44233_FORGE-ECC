import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { consult, formatConsult, tokenize } from "../src/core/consult.js";
import { doctorHarness, installHarness } from "../src/core/harness-installer.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("forge consult", () => {
  it("finds the right components for a task, including MCP servers", async () => {
    const security = await consult("security review of auth code", { limit: 5 });
    expect(security.map(m => `${m.kind}:${m.id}`)).toContain("agent:security-reviewer");
    const e2e = await consult("e2e tests in the browser", { limit: 5 });
    expect(e2e.map(m => `${m.kind}:${m.id}`)).toEqual(expect.arrayContaining(["skill:e2e-testing", "mcp:playwright"]));
    expect(formatConsult("e2e", e2e)).toContain("forge mcp add playwright");
    expect(await consult("zzqx")).toEqual([]);
    expect(tokenize("How do I write the API?")).toEqual(["api"]);
  });

  it("ranks the project's own stack above other stacks", async () => {
    const python = (await consult("review queries", { languages: ["python"], kinds: ["agent"] })).map(m => m.id);
    const ruby = (await consult("review queries", { languages: ["ruby"], kinds: ["agent"] })).map(m => m.id);
    expect(python.indexOf("django-reviewer")).toBeLessThan(python.indexOf("ruby-reviewer") === -1 ? 99 : python.indexOf("ruby-reviewer"));
    expect(ruby.indexOf("ruby-reviewer")).toBeLessThan(ruby.indexOf("django-reviewer") === -1 ? 99 : ruby.indexOf("django-reviewer"));
  });

  it("installs consulted extras and keeps them on reinstall", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forge-consult-"));
    directories.push(root);
    await writeFile(path.join(root, "package.json"), "{}");
    await installHarness({ projectPath: root, forgeVersion: "test", targets: ["claude"], profile: "minimal", extras: ["skill:django-apps", "agent:security-reviewer"] });
    expect(await readFile(path.join(root, ".claude/skills/forge-django-apps/SKILL.md"), "utf8").catch(async () => readFile(path.join(root, ".claude/skills/django-apps/SKILL.md"), "utf8"))).toContain("Django");
    const doctor = await doctorHarness({ projectPath: root, forgeVersion: "test" });
    expect(doctor.extras).toEqual(["agent:security-reviewer", "skill:django-apps"]);
    expect(doctor.healthy).toBe(true);
    await expect(installHarness({ projectPath: root, forgeVersion: "test", targets: ["claude"], extras: ["skill:nope"] })).rejects.toThrow("No skill");
  });
});
