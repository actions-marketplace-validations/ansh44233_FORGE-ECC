import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectProjectLanguages, loadHarnessCatalog, parseCatalogItem, selectCatalogItems } from "../src/core/harness-catalog.js";
import {
  applyFileTransaction,
  buildInstallPlan,
  detectHarnessTargets,
  doctorHarness,
  extractManagedBlock,
  installHarness,
  INSTALL_STATE_PATH,
  STATE_SCHEMA,
  loadInstallState,
  HARNESS_TARGETS,
  parseTargets,
  uninstallHarness,
  recoverFileTransaction,
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

describe("installer file transaction recovery", () => {
  it("restores snapshots from a journal left by an interrupted process", async () => {
    const root = await project({ "existing.txt": "before" });
    const forgeDir = path.join(root, ".forge");
    await mkdir(forgeDir, { recursive: true });
    await writeFile(path.join(root, "existing.txt"), "partially-written");
    await writeFile(path.join(root, "new.txt"), "partial-create");
    await writeFile(path.join(forgeDir, "transaction-journal.json"), JSON.stringify({
      schemaVersion: 1,
      snapshots: [
        { path: "existing.txt", contentBase64: Buffer.from("before", "utf8").toString("base64") },
        { path: "new.txt", contentBase64: null },
      ],
    }));
    await expect(recoverFileTransaction(root)).resolves.toBe(true);
    await expect(readFile(path.join(root, "existing.txt"), "utf8")).resolves.toBe("before");
    expect(await exists(path.join(root, "new.txt"))).toBe(false);
    expect(await exists(path.join(forgeDir, "transaction-journal.json"))).toBe(false);
  });

  it("refuses malformed journals without deleting them", async () => {
    const root = await project();
    const forgeDir = path.join(root, ".forge");
    await mkdir(forgeDir, { recursive: true });
    const journalPath = path.join(forgeDir, "transaction-journal.json");
    await writeFile(journalPath, JSON.stringify({ schemaVersion: 99, snapshots: [] }));
    await expect(recoverFileTransaction(root)).rejects.toThrow(/invalid/);
    expect(await exists(journalPath)).toBe(true);
  });

  it("rejects non-canonical base64 snapshots without modifying project files", async () => {
    const root = await project({ "keep.txt": "partially-written" });
    const forgeDir = path.join(root, ".forge");
    await mkdir(forgeDir, { recursive: true });
    const journalPath = path.join(forgeDir, "transaction-journal.json");
    await writeFile(journalPath, JSON.stringify({
      schemaVersion: 1,
      snapshots: [{ path: "keep.txt", contentBase64: "%%%not-base64%%%" }],
    }));
    await expect(recoverFileTransaction(root)).rejects.toThrow(/invalid/);
    await expect(readFile(path.join(root, "keep.txt"), "utf8")).resolves.toBe("partially-written");
    expect(await exists(journalPath)).toBe(true);
  });

  it("rejects duplicate snapshot paths rather than applying ambiguous restores", async () => {
    const root = await project({ "keep.txt": "partially-written" });
    const forgeDir = path.join(root, ".forge");
    await mkdir(forgeDir, { recursive: true });
    const journalPath = path.join(forgeDir, "transaction-journal.json");
    await writeFile(journalPath, JSON.stringify({
      schemaVersion: 1,
      snapshots: [
        { path: "keep.txt", contentBase64: Buffer.from("first").toString("base64") },
        { path: "keep.txt", contentBase64: Buffer.from("second").toString("base64") },
      ],
    }));
    await expect(recoverFileTransaction(root)).rejects.toThrow(/duplicate/);
    await expect(readFile(path.join(root, "keep.txt"), "utf8")).resolves.toBe("partially-written");
    expect(await exists(journalPath)).toBe(true);
  });
});

describe("durable installer lifecycle recovery", () => {
  it("recovers an interrupted transaction before install reads or writes project files", async () => {
    const root = await project({ "AGENTS.md": "# User instructions\n" });
    const forgeDir = path.join(root, ".forge");
    await mkdir(forgeDir, { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "partially-written");
    await writeFile(path.join(forgeDir, "transaction-journal.json"), JSON.stringify({
      schemaVersion: 1,
      snapshots: [{ path: "AGENTS.md", contentBase64: Buffer.from("# User instructions\n", "utf8").toString("base64") }],
    }));

    await installHarness({ projectPath: root, forgeVersion: "test", targets: ["codex"] });

    const restored = await readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(restored.startsWith("# User instructions\n")).toBe(true);
    expect(restored).toContain("FORGE engineering harness");
    expect(await exists(path.join(forgeDir, "transaction-journal.json"))).toBe(false);
  });

  it("recovers an interrupted transaction before uninstall checks install state", async () => {
    const root = await project({ "AGENTS.md": "# Keep this file\n" });
    const forgeDir = path.join(root, ".forge");
    await mkdir(forgeDir, { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "partially-removed");
    await writeFile(path.join(forgeDir, "transaction-journal.json"), JSON.stringify({
      schemaVersion: 1,
      snapshots: [{ path: "AGENTS.md", contentBase64: Buffer.from("# Keep this file\n", "utf8").toString("base64") }],
    }));

    await expect(uninstallHarness({ projectPath: root })).resolves.toMatchObject({ installed: false });
    await expect(readFile(path.join(root, "AGENTS.md"), "utf8")).resolves.toBe("# Keep this file\n");
    expect(await exists(path.join(forgeDir, "transaction-journal.json"))).toBe(false);
  });
});

describe("installer file transaction", () => {
  it("restores earlier writes when a later operation fails", async () => {
    const root = await project({ "blocker": "original" });
    const blocker = path.join(root, "blocker");
    await expect(applyFileTransaction([
      { path: blocker, content: "updated" },
      { path: path.join(blocker, "child.txt"), content: "cannot-write" },
    ])).rejects.toThrow("All applied changes were rolled back");
    await expect(readFile(blocker, "utf8")).resolves.toBe("original");
  });
  it("restores deleted files and removes newly created files after failure", async () => {
    const root = await project({ "blocker": "keep", "to-delete.txt": "restore-me" });
    const blocker = path.join(root, "blocker");
    const created = path.join(root, "created.txt");
    const deleted = path.join(root, "to-delete.txt");
    await expect(applyFileTransaction([
      { path: deleted, content: null },
      { path: created, content: "temporary" },
      { path: path.join(blocker, "child.txt"), content: "cannot-write" },
    ])).rejects.toThrow("All applied changes were rolled back");
    await expect(readFile(deleted, "utf8")).resolves.toBe("restore-me");
    expect(await exists(created)).toBe(false);
  });
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
  it("derives the accepted target list from the capability manifest", () => {
    expect(parseTargets("all")).toEqual([...HARNESS_TARGETS]);
    expect(parseTargets("claude,claude,codex")).toEqual(["claude", "codex"]);
    expect(() => parseTargets("claude,vim")).toThrow(/Unknown target/);
  });

  it("rejects unsupported targets passed directly to the install planner", async () => {
    const root = await project();
    await expect(buildInstallPlan({
      projectPath: root,
      forgeVersion: "test",
      targets: ["vim" as never],
    })).rejects.toThrow(/Unknown target/);
  });

  it("migrates a valid v1 install state in memory without changing its payload", async () => {
    const root = await project();
    const legacy = { schemaVersion: 1, forgeVersion: "2.0.1", installedAt: "2026-01-01T00:00:00.000Z", profile: "minimal", targets: ["claude"], languages: [], files: [], blocks: [] };
    await mkdir(path.join(root, ".forge"), { recursive: true });
    const statePath = path.join(root, INSTALL_STATE_PATH);
    await writeFile(statePath, JSON.stringify(legacy));
    const migrated = await loadInstallState(root);
    expect(migrated?.schemaVersion).toBe(STATE_SCHEMA);
    expect(migrated?.forgeVersion).toBe("2.0.1");
    expect(JSON.parse(await readFile(statePath, "utf8")).schemaVersion).toBe(1);
  });

  it("refuses future state schemas without modifying the state file", async () => {
    const root = await project();
    await mkdir(path.join(root, ".forge"), { recursive: true });
    const statePath = path.join(root, INSTALL_STATE_PATH);
    const future = JSON.stringify({ schemaVersion: STATE_SCHEMA + 1, files: [], blocks: [] });
    await writeFile(statePath, future);
    await expect(loadInstallState(root)).rejects.toThrow(/Upgrade FORGE/);
    expect(await readFile(statePath, "utf8")).toBe(future);
  });

  it("rejects malformed state entries without deleting the state file", async () => {
    const root = await project();
    await mkdir(path.join(root, ".forge"), { recursive: true });
    const statePath = path.join(root, INSTALL_STATE_PATH);
    const malformed = JSON.stringify({ schemaVersion: STATE_SCHEMA, forgeVersion: "test", installedAt: "now", profile: "minimal", targets: ["claude"], languages: [], files: [{ path: "../outside", sha256: "bad", targets: ["claude"] }], blocks: [] });
    await writeFile(statePath, malformed);
    await expect(loadInstallState(root)).rejects.toThrow();
    expect(await readFile(statePath, "utf8")).toBe(malformed);
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

  it("preserves modified managed blocks and install state during uninstall", async () => {
    const root = await project({ "package.json": "{}", "AGENTS.md": "# Personal instructions\n" });
    await installHarness({ projectPath: root, forgeVersion: "test", targets: ["codex"] });
    const agentsPath = path.join(root, "AGENTS.md");
    const before = await readFile(agentsPath, "utf8");
    await writeFile(agentsPath, before.replace("FORGE engineering harness", "Locally customized FORGE harness"));
    const result = await uninstallHarness({ projectPath: root });
    expect(result.changes.some(change => change.path === "AGENTS.md" && change.action === "keep-modified")).toBe(true);
    expect(await readFile(agentsPath, "utf8")).toContain("Locally customized FORGE harness");
    const state = await loadInstallState(root);
    expect(state?.blocks.map(block => block.path)).toContain("AGENTS.md");
  });

  it("keeps modified generated files tracked after uninstall", async () => {
    const root = await project();
    await installHarness({ projectPath: root, forgeVersion: "test", targets: ["claude"], profile: "minimal" });
    const filePath = path.join(root, ".claude/agents/forge-planner.md");
    await writeFile(filePath, (await readFile(filePath, "utf8")) + "\nlocal note\n");
    const result = await uninstallHarness({ projectPath: root });
    expect(result.changes.some(change => change.path.endsWith("forge-planner.md") && change.action === "keep-modified")).toBe(true);
    expect(await exists(filePath)).toBe(true);
    expect((await loadInstallState(root))?.files.some(file => file.path.endsWith("forge-planner.md"))).toBe(true);
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

describe("opt-in harness targets", () => {
  it("keeps the default target set unchanged and accepts default/all keywords", async () => {
    expect(parseTargets("default")).toEqual(["claude", "cursor", "codex", "opencode", "gemini"]);
    expect(parseTargets("all")).toHaveLength(HARNESS_TARGETS.length);
    const plan = await buildInstallPlan({ projectPath: await project(), forgeVersion: "test" });
    expect(plan.targets).toEqual(["claude", "cursor", "codex", "opencode", "gemini"]);
  });

  it("detects harnesses the project already uses", async () => {
    const root = await project({ "package.json": "{}", ".github/copilot-instructions.md": "# team\n", ".kiro/steering/x.md": "x", ".clinerules": "" });
    expect(await detectHarnessTargets(root)).toEqual(["copilot", "kiro", "cline"]);
  });

  it("renders native Copilot, Windsurf, Kiro and Cline files plus managed blocks", async () => {
    const plan = await buildInstallPlan({ projectPath: await project(), forgeVersion: "test", targets: ["copilot", "windsurf", "kiro", "cline", "zed"] });
    const paths = plan.files.map(file => file.path);
    expect(paths.some(p => p.startsWith(".github/instructions/forge-common-") && p.endsWith(".instructions.md"))).toBe(true);
    expect(paths.some(p => p.startsWith(".github/prompts/forge-") && p.endsWith(".prompt.md"))).toBe(true);
    expect(paths.some(p => p.startsWith(".github/agents/forge-") && p.endsWith(".agent.md"))).toBe(true);
    expect(paths.some(p => p.startsWith(".windsurf/rules/forge-common-"))).toBe(true);
    expect(paths.some(p => p.startsWith(".windsurf/workflows/forge-"))).toBe(true);
    expect(paths.some(p => p.startsWith(".kiro/steering/forge-agent-"))).toBe(true);
    expect(paths.some(p => p.startsWith(".clinerules/workflows/forge-"))).toBe(true);
    expect(paths.some(p => p.startsWith(".agents/skills/forge-"))).toBe(true);
    expect(plan.blocks.map(block => block.path)).toEqual([".clinerules/forge-harness.md", ".github/copilot-instructions.md", ".kiro/steering/forge-harness.md", "AGENTS.md"]);
    const common = plan.files.find(file => file.path.startsWith(".windsurf/rules/forge-common-"));
    expect(common?.content).toMatch(/^---\ntrigger: always_on/);
    const steering = plan.files.find(file => file.path.startsWith(".kiro/steering/forge-common-"));
    expect(steering?.content).toMatch(/inclusion: always/);
    const prompt = plan.files.find(file => file.path.startsWith(".github/prompts/"));
    expect(prompt?.content).not.toContain("$ARGUMENTS");
  });

  it("installs and uninstalls a new target cleanly", async () => {
    const root = await project({ "package.json": "{}", ".github/copilot-instructions.md": "# Team notes\n" });
    await installHarness({ projectPath: root, forgeVersion: "test", targets: ["copilot"] });
    const instructions = await readFile(path.join(root, ".github/copilot-instructions.md"), "utf8");
    expect(instructions).toContain("# Team notes");
    expect(instructions).toContain("forge:begin");
    expect((await doctorHarness({ projectPath: root, forgeVersion: "test" })).healthy).toBe(true);
    await uninstallHarness({ projectPath: root });
    await expect(readFile(path.join(root, ".github/copilot-instructions.md"), "utf8")).resolves.toBe("# Team notes\n");
    expect(await exists(path.join(root, ".github/prompts"))).toBe(false);
  });
});

describe("stack-scoped skills", () => {
  it("installs stack skills only for detected languages, and all of them with the full profile", async () => {
    const catalog = await loadHarnessCatalog();
    const ids = (languages: string[] | undefined, profile: "standard" | "full" = "standard") => new Set(selectCatalogItems(catalog, languages ? { profile, languages } : { profile }).filter(i => i.kind === "skill").map(i => i.id));
    const python = ids(["python"]);
    expect(python.has("django-apps")).toBe(true);
    expect(python.has("go-services")).toBe(false);
    expect(python.has("postgres-queries")).toBe(true);
    const ts = ids(["typescript", "react"]);
    expect(ts.has("nextjs-app-router")).toBe(true);
    expect(ts.has("django-apps")).toBe(false);
    expect(ids(undefined, "full").has("go-services")).toBe(true);
    expect(catalog.items.filter(i => i.kind === "skill").length).toBeGreaterThanOrEqual(50);
  });

  it("rejects a languages field on rules", () => {
    expect(() => parseCatalogItem("rule", "x", "---\ndescription: d\nlanguages: python\n---\n# X\nbody", "rules/common/x.md", "common")).toThrow(/languages/);
  });
});
