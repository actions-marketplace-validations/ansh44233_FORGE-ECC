import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCostReport, estimateUsd, parseRates, parseTranscriptUsage, rateFor, recordSessionCost } from "../src/core/session-cost.js";
import { formatStatusLine, renderStatusLine } from "../src/core/statusline.js";

const directories: string[] = [];
async function project(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forge-cost-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const transcript = [
  { message: { id: "a", model: "claude-opus-5-5", usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000 } } },
  { message: { id: "a", model: "claude-opus-5-5", usage: { input_tokens: 1_000_000, output_tokens: 100_000 } } },
  { message: { id: "b", model: "claude-haiku-5-5", usage: { input_tokens: 1_000_000, output_tokens: 0 } } },
  { type: "user", message: { content: "hi" } },
].map(row => JSON.stringify(row)).join("\n") + "\nnot json usage\n";

describe("session cost", () => {
  it("sums usage per model and counts streamed duplicates once", () => {
    const { models, turns } = parseTranscriptUsage(transcript);
    expect(turns).toBe(2);
    expect(models["claude-opus-5-5"]).toEqual({ input: 1_000_000, output: 100_000, cacheWrite: 0, cacheRead: 1_000_000 });
  });

  it("estimates with family rates and honours overrides", () => {
    const { models } = parseTranscriptUsage(transcript);
    // opus: 5 + 2.5 + 0.5 cache read; haiku: 1
    expect(estimateUsd(models)).toBe(9);
    expect(rateFor("claude-sonnet-5-5")?.input).toBe(3);
    expect(estimateUsd({ "mystery-model": { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 } })).toBeUndefined();
    const rates = parseRates({ "claude-opus-5-5": { input: 1, output: 2 }, bad: { input: "x" } });
    expect(rateFor("claude-opus-5-5", rates)?.input).toBe(1);
    expect(rates.bad).toBeUndefined();
  });

  it("records cumulative rows and reports the latest per session", async () => {
    const root = await project();
    const file = path.join(root, "t.jsonl");
    await writeFile(file, transcript.split("\n").slice(0, 1).join("\n"));
    await recordSessionCost(root, "s1", file, { now: new Date("2026-11-22T10:00:00Z") });
    await writeFile(file, transcript);
    await recordSessionCost(root, "s1", file, { now: new Date("2026-11-22T11:00:00Z") });
    await recordSessionCost(root, "s2", file, { now: new Date("2026-11-23T11:00:00Z") });
    const report = await buildCostReport(root);
    expect(report.sessions).toBe(2);
    expect(report.estimatedUsd).toBe(18);
    expect(report.byDay.map(d => d.day)).toEqual(["2026-11-22", "2026-11-23"]);
    expect((await buildCostReport(root, { since: new Date("2026-11-23T00:00:00Z") })).sessions).toBe(1);
  });
});

describe("statusline", () => {
  it("renders a compact line from session files", async () => {
    const root = await project();
    const line = await renderStatusLine(JSON.stringify({ model: { display_name: "Opus" }, workspace: { current_dir: root }, cost: { total_cost_usd: 1.234 } }), root);
    expect(line).toBe("FORGE ▸ Opus │ ✎ clean │ $1.23");
    expect(formatStatusLine({ unverified: 2, blocked: 1, instincts: 3, verification: "✗ test failed" })).toBe("FORGE │ ✎ 2 unverified │ ✗ test failed │ ⛨ 1 blocked │ ★ 3 instincts");
    expect(await renderStatusLine("garbage", root)).toContain("FORGE");
  });
});
