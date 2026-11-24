import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildGuardReport, checkGuard, formatGuardCheck, formatGuardReport, readGuardEvents } from "../src/core/guard-report.js";
import { runNativeHook } from "../src/core/hook-adapters.js";
import { runHarnessHook } from "../src/core/harness-hooks.js";

const directories: string[] = [];
async function project(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forge-guard-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("forge guard", () => {
  it("dry-runs commands and files with the project's own rules", async () => {
    const root = await project();
    expect((await checkGuard(root, { command: "rm -rf /" })).verdict.decision).toBe("deny");
    expect((await checkGuard(root, { command: "npm test" })).verdict.decision).toBe("allow");
    expect((await checkGuard(root, { file: ".env" })).verdict.decision).toBe("ask");
    expect((await checkGuard(root, { file: ".git/config", write: true })).verdict.decision).toBe("deny");
    await mkdir(path.join(root, ".forge"), { recursive: true });
    await writeFile(path.join(root, ".forge/harness-hooks.json"), JSON.stringify({ guard: { allow: ["^rm -rf dist$"] } }));
    expect((await checkGuard(root, { command: "rm -rf dist" })).verdict.decision).toBe("allow");
    expect(formatGuardCheck(await checkGuard(root, { command: "git push --force origin x" }))).toContain("? ask");
  });

  it("reports interventions per harness and rule, newest first, without secrets", async () => {
    const root = await project();
    await runHarnessHook("pre-tool", JSON.stringify({ cwd: root, tool_name: "Bash", tool_input: { command: "git push --force origin x token=abcdef123456" } }));
    await runNativeHook("cursor", "beforeShellExecution", JSON.stringify({ command: "rm -rf /", workspace_roots: [root] }));
    await runNativeHook("codex", "PreToolUse", JSON.stringify({ cwd: root, tool_name: "Bash", tool_input: { command: "rm -rf ~/" } }));
    await runNativeHook("gemini", "BeforeAgent", JSON.stringify({ cwd: root, prompt: "use ghp_" + "b".repeat(36) }));
    const events = await readGuardEvents(root);
    expect(events.map(e => e.harness)).toEqual(["claude", "cursor", "codex", "gemini"]);
    const report = buildGuardReport(events);
    expect(report.total).toBe(4);
    expect(report.byDecision).toEqual({ ask: 1, deny: 3 });
    expect(report.recent[0]?.harness).toBe("gemini");
    expect(report.byRule.map(r => r.rule)).toContain("GUARD-PROMPT-SECRET");
    const text = formatGuardReport(report);
    expect(text).toContain("cursor 1");
    expect(text).not.toContain("abcdef123456");
    expect(text).not.toContain("bbbbbbbb");
    expect(buildGuardReport(events, { since: new Date(Date.now() + 60_000) }).total).toBe(0);
    expect(formatGuardReport(buildGuardReport([]))).toContain("forge install --hooks");
  });
});
