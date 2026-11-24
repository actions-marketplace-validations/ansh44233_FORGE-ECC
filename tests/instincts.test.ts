import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeInstincts,
  addManualInstinct,
  confidenceFor,
  evolveInstincts,
  exportInstincts,
  importInstincts,
  instinctId,
  learnInstincts,
  loadInstincts,
  mineCoChange,
  mineCommitConvention,
  mineGuard,
  mineVerification,
  setInstinctStatus,
} from "../src/core/instincts.js";
import { runHarnessHook } from "../src/core/harness-hooks.js";

const directories: string[] = [];
async function project(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forge-instinct-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  delete process.env.FORGE_HOME;
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const fixed = () => new Date("2026-11-23T10:00:00Z");
const coupled = Array.from({ length: 5 }, (_, i) => ({ subject: `feat(api): change ${i}`, files: ["src/api.ts", "tests/api.test.ts"] }))
  .concat(Array.from({ length: 6 }, (_, i) => ({ subject: `fix(core): tweak ${i}`, files: ["src/core.ts"] })));

describe("instinct mining", () => {
  it("finds files that change together and skips sweeping or lockfile-only noise", () => {
    const found = mineCoChange([...coupled, { subject: "chore: bump", files: ["package-lock.json", "src/api.ts"] }, { subject: "big", files: Array.from({ length: 20 }, (_, i) => `f${i}.ts`) }]);
    expect(found).toHaveLength(1);
    expect(found[0]?.trigger).toMatch(/editing (src\/api\.ts|tests\/api\.test\.ts)/);
    expect(found[0]?.action).toMatch(/changed together in 5 of 5 commits/);
  });

  it("detects a conventional-commit habit only when it is dominant", () => {
    expect(mineCommitConvention(coupled)[0]?.action).toMatch(/with a scope/);
    expect(mineCommitConvention(coupled.map(c => ({ ...c, subject: "updated stuff" })))).toEqual([]);
  });

  it("learns from repeated guard denials and repeated verification failures", () => {
    expect(mineGuard([{ rule: "GUARD-RM-ROOT" }, { rule: "GUARD-RM-ROOT" }, { rule: "GUARD-ONCE" }]).map(c => c.trigger)).toEqual(["about to run a command matching FORGE Guard GUARD-RM-ROOT"]);
    const rows = [1, 2].map(() => ({ kind: "verify", script: "test", status: "failed", files: ["src/a.ts", "src/b.ts"] }));
    const verify = mineVerification([...rows, { kind: "verify", script: "test", status: "passed", files: ["docs/x.md"] }]);
    expect(verify).toHaveLength(1);
    expect(verify[0]?.trigger).toBe("editing src/**");
    expect(verify[0]?.action).toMatch(/npm run test/);
  });

  it("uses monotonic, capped confidence", () => {
    expect(confidenceFor(1)).toBeLessThan(confidenceFor(3));
    expect(confidenceFor(1000)).toBeLessThanOrEqual(0.95);
  });
});

describe("instinct store", () => {
  it("stores learned instincts as candidates and never overrides a human decision", async () => {
    const root = await project();
    const first = await learnInstincts(root, { commits: coupled, now: fixed });
    expect(first.added.length).toBeGreaterThan(0);
    expect(first.added.every(i => i.status === "candidate")).toBe(true);
    const target = first.added[0]!;
    await setInstinctStatus(root, [target.id], "rejected");
    await learnInstincts(root, { commits: [...coupled, ...coupled], now: fixed });
    expect((await loadInstincts(root)).find(i => i.id === target.id)?.status).toBe("rejected");
    expect(await activeInstincts(root)).toEqual([]);
  });

  it("refuses secrets and keeps ids stable", async () => {
    const root = await project();
    await expect(addManualInstinct(root, "deploying", "use token=ghp_abcdefghijklmnopqrstuvwxyz123456")).rejects.toThrow(/secrets/);
    const a = await addManualInstinct(root, "editing api/**", "update the OpenAPI spec", { domain: "api" });
    expect(a.id).toBe(instinctId("Editing API/**", "update the openapi spec"));
    expect(a.status).toBe("active");
  });

  it("imports instincts as capped candidates without touching existing ones", async () => {
    const source = await project();
    const target = await project();
    await addManualInstinct(source, "editing api/**", "update the OpenAPI spec");
    await addManualInstinct(target, "editing api/**", "update the OpenAPI spec");
    await addManualInstinct(source, "editing ui/**", "run the visual tests");
    const payload = await exportInstincts(source);
    const result = await importInstincts(target, payload);
    expect(result.added).toHaveLength(1);
    expect(result.added[0]).toMatchObject({ status: "candidate", source: "import" });
    expect(result.added[0]!.confidence).toBeLessThanOrEqual(0.6);
    expect((await loadInstincts(target)).find(i => i.trigger === "editing api/**")?.status).toBe("active");
    await expect(importInstincts(target, { tool: "other" })).rejects.toThrow(/Not a FORGE instinct export/);
  });

  it("evolves active instincts into a skill and will not clobber a hand-written one", async () => {
    const root = await project();
    await addManualInstinct(root, "editing api/**", "update the OpenAPI spec", { domain: "api" });
    const dry = await evolveInstincts(root);
    expect(dry.files.map(f => f.action)).toEqual(["create", "create"]);
    await evolveInstincts(root, { write: true });
    const skill = await readFile(path.join(root, ".claude/skills/forge-learned/SKILL.md"), "utf8");
    expect(skill).toContain("name: forge-learned");
    expect(skill).toContain("**When editing api/**:** update the OpenAPI spec");
    expect((await evolveInstincts(root, { write: true })).files.map(f => f.action)).toEqual(["unchanged", "unchanged"]);
    await writeFile(path.join(root, ".agents/skills/forge-learned/SKILL.md"), "# mine\n");
    expect((await evolveInstincts(root)).files[1]?.action).toBe("skipped-user-edited");
  });
});

describe("instinct hooks", () => {
  it("records edits as observations and injects active instincts at session start", async () => {
    const root = await project();
    process.env.FORGE_HOME = await project();
    await mkdir(path.join(root, "src"), { recursive: true });
    await runHarnessHook("post-edit", JSON.stringify({ cwd: root, session_id: "s1", tool_name: "Edit", tool_input: { file_path: path.join(root, "src/a.ts") } }));
    const log = await readFile(path.join(root, ".forge/session/observations.jsonl"), "utf8");
    expect(log).toContain('"kind":"edit"');
    expect(log).toContain('"file":"src/a.ts"');
    await addManualInstinct(root, "editing src/**", "run the unit tests");
    const output = await runHarnessHook("session-start", JSON.stringify({ cwd: root }));
    const context = (output.json as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "";
    expect(context).toContain("When editing src/**: run the unit tests");
  });
});
