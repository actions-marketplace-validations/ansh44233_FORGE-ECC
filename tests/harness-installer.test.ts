import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectProjectLanguages, loadHarnessCatalog, parseCatalogItem, selectCatalogItems } from "../src/core/harness-catalog.js";
import {
  buildInstallPlan,
  doctorHarness,
  extractManagedBlock,
  installHarness,
  INSTALL_STATE_PATH,
  parseTargets,
  uninstallHarness,
} from "../src/core/harness-installer.js";

const directories: string[] = [];
async function project(files: Record<string, string> = { "package.json": "{}" }): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forge-install-"));
  directories.push(directory);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), content);
  }
  return directory;
}
async function exists(file: string): Promise<boolean> {
  try { await stat(file); return true; } catch { return false; }
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("harness catalog", () => {
  it("loads and validates every shipped catalog item", async () => {
    const catalog = await loadHarnessCatalog();
    const kinds = new Set(catalog.items.map(item => item.kind));
    expect(kinds).toEqual(new Set(["agent", "skill", "command", "rule"]));
    expect(catalog.items.filter(item => item.kind === "agent").length).toBeGreaterThanOrEqual(15);
    for (const item of catalog.items) {
      expect(item.description.length, item.sourcePath).toBeGreaterThan(10);
      expect(item.body.length, item.sourcePath).toBeGreaterThan(40);
    }
  });

  it("rejects items with unsafe ids, missing descriptions or unknown profiles", () => {
    expect(() => parseCatalogItem("agent", "../evil", "---\ndescription: x\n---\nbody", "x.md")).toThrow(/invalid id/);
    expect(() => parseCatalogItem("agent", "ok", "---\nprofile: minimal\n---\nbody", "x.md")).toThrow(/description/);
    expect(() => parseCatalogItem("agent", "ok", "---\ndescription: d\nprofile: huge\n---\nbody", "x.md")).toThrow(/profile/);
  });

  it("detects project languages and frameworks from marker files", async () => {
    const root = await project({ "package.json": JSON.stringify({ dependencies: { react: "^19.0.0" } }), "composer.json": "{}", "App.csproj": "<Project/>" });
    expect(new Set(await detectProjectLanguages(root))).toEqual(new Set(["typescript", "php", "csharp", "react"]));
  });

  it("filters by profile and language", async () => {
    const catalog = await loadHarnessCatalog();
    const minimal = selectCatalogItems(catalog, { profile: "minimal", languages: [] });
    const full = selectCatalogItems(catalog, { profile: "full" });
    expect(minimal.every(item => item.profile === "minimal")).toBe(true);
    expect(minimal.some(item => item.kind === "rule" && item.language !== "common")).toBe(false);
    expect(full.length).toBe(catalog.items.length);
  });
});

describe("harness installer", () => {
  it("rejects unknown targets", () => {
    expect(() => parseTargets("claude,vim")).toThrow(/Unknown target/);
    expect(parseTargets("all")).toContain("gemini");
  });

  it("renders native files for each harness", async () => {
    const root = await project();
    const plan = await buildInstallPlan({ projectPath: root, forgeVersion: "test", profile: "minimal" });
    const paths = plan.files.map(file => file.path);
    expect(paths).toContain(".claude/agents/forge-planner.md");
    expect(paths).toContain(".claude/commands/forge/plan.md");
    expect(paths).toContain(".claude/skills/forge-verification-loop/SKILL.md");
    expect(paths).toContain(".cursor/rules/forge-common-evidence.mdc");
    expect(paths).toContain(".opencode/agent/forge-planner.md");
    expect(paths).toContain(".gemini/commands/forge/plan.toml");
    expect(paths).toContain(".agents/skills/forge-verification-loop/SKILL.md");
    expect(plan.blocks.map(block => block.path)).toEqual(["AGENTS.md", "GEMINI.md"]);
    const agent = plan.files.find(file => file.path === ".claude/agents/forge-planner.md");
    expect(agent?.content).toMatch(/^---\nname: forge-planner\ndescription: /);
    const gemini = plan.files.find(file => file.path === ".gemini/commands/forge/plan.toml");
    expect(gemini?.content).toContain("{{args}}");
    expect(gemini?.content).not.toContain("$ARGUMENTS");
  });

  it("installs idempotently and preserves existing AGENTS.md content", async () => {
    const root = await project({ "package.json": "{}", "AGENTS.md": "# Mine\n\nKeep this.\n" });
    const first = await installHarness({ projectPath: root, forgeVersion: "test" });
    expect(first.conflicts).toBe(0);
    expect(first.changes.some(change => change.action === "create")).toBe(true);
    const agents = await readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(agents.startsWith("# Mine\n\nKeep this.")).toBe(true);
    expect(extractManagedBlock(agents)?.block).toContain("FORGE engineering harness");
    const second = await installHarness({ projectPath: root, forgeVersion: "test" });
    expect(new Set(second.changes.map(change => change.action))).toEqual(new Set(["unchanged"]));
  });

  it("dry run writes nothing", async () => {
    const root = await project();
    const result = await installHarness({ projectPath: root, forgeVersion: "test", dryRun: true });
    expect(result.changes.length).toBeGreaterThan(0);
    expect(await exists(path.join(root, ".claude"))).toBe(false);
    expect(await exists(path.join(root, INSTALL_STATE_PATH))).toBe(false);
  });

  it("never overwrites user-edited or foreign files without --force", async () => {
    const root = await project({ "package.json": "{}", ".claude/agents/forge-planner.md": "my own planner\n" });
    const result = await installHarness({ projectPath: root, forgeVersion: "test", targets: ["claude"] });
    expect(result.conflicts).toBe(1);
    expect(await readFile(path.join(root, ".claude/agents/forge-planner.md"), "utf8")).toBe("my own planner\n");

    const forced = await installHarness({ projectPath: root, forgeVersion: "test", targets: ["claude"], force: true });
    expect(forced.conflicts).toBe(0);
    expect(await readFile(path.join(root, ".claude/agents/forge-planner.md"), "utf8")).toContain("name: forge-planner");

    const reviewer = path.join(root, ".claude/agents/forge-code-reviewer.md");
    await writeFile(reviewer, (await readFile(reviewer, "utf8")) + "\nlocal tweak\n");
    const doctor = await doctorHarness({ projectPath: root, forgeVersion: "test" });
    expect(doctor.entries.find(entry => entry.path.endsWith("forge-code-reviewer.md"))?.status).toBe("modified");
    const again = await installHarness({ projectPath: root, forgeVersion: "test", targets: ["claude"] });
    expect(again.conflicts).toBe(1);
    expect(await readFile(reviewer, "utf8")).toContain("local tweak");
  });

  it("removes deselected unmodified files when the profile shrinks", async () => {
    const root = await project();
    await installHarness({ projectPath: root, forgeVersion: "test", targets: ["claude"], profile: "full" });
    expect(await exists(path.join(root, ".claude/agents/forge-rust-reviewer.md"))).toBe(true);
    const shrink = await installHarness({ projectPath: root, forgeVersion: "test", targets: ["claude"], profile: "minimal" });
    expect(shrink.changes.some(change => change.action === "remove" && change.path.endsWith("forge-rust-reviewer.md"))).toBe(true);
    expect(await exists(path.join(root, ".claude/agents/forge-rust-reviewer.md"))).toBe(false);
  });

  it("doctor reports missing files and uninstall restores the original project", async () => {
    const root = await project({ "package.json": "{}", "AGENTS.md": "# Mine\n" });
    await installHarness({ projectPath: root, forgeVersion: "test" });
    await rm(path.join(root, ".claude/commands/forge/plan.md"));
    const doctor = await doctorHarness({ projectPath: root, forgeVersion: "test" });
    expect(doctor.healthy).toBe(false);
    expect(doctor.summary.missing).toBe(1);

    const removal = await uninstallHarness({ projectPath: root });
    expect(removal.installed).toBe(true);
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("# Mine\n");
    for (const name of [".claude", ".cursor", ".opencode", ".gemini", ".agents", ".forge", "GEMINI.md"]) {
      expect(await exists(path.join(root, name)), name).toBe(false);
    }
  });

  it("refuses to write through symlinked directories", async () => {
    const root = await project();
    const outside = await project({});
    await symlink(outside, path.join(root, ".claude"), "dir");
    await expect(installHarness({ projectPath: root, forgeVersion: "test", targets: ["claude"] })).rejects.toThrow(/symlink/);
    expect(await exists(path.join(outside, "agents"))).toBe(false);
  });

  it("rejects malformed managed block markers", () => {
    expect(() => extractManagedBlock("<!-- forge:end -->")).toThrow(/malformed/);
  });
});

describe("harness CLI", () => {
  function runCli(...args: string[]): string {
    return execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: process.cwd(), encoding: "utf8" });
  }

  it("lists the catalog and installs with a dry run", async () => {
    expect(runCli("catalog")).toMatch(/FORGE catalog: \d+ agents/);
    const root = await project();
    const output = runCli("install", root, "--target", "claude", "--profile", "minimal", "--dry-run");
    expect(output).toContain("dry run");
    expect(await exists(path.join(root, ".claude"))).toBe(false);
  });

  it("rejects unknown options", async () => {
    const root = await project();
    expect(() => runCli("install", root, "--bogus")).toThrow();
  });
});
