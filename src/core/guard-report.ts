import { readFile } from "node:fs/promises";
import path from "node:path";
import { evaluateCommand, evaluateToolUse, loadHarnessHookConfig, type GuardDecision, type GuardVerdict } from "./harness-hooks.js";

/**
 * `forge guard`: see what FORGE Guard would decide before an agent ever runs
 * the command, and what it has blocked across every harness.
 */

export interface GuardEvent { at: string; harness: string; tool: string; decision: GuardDecision; rule: string; target: string }

export interface GuardReport {
  total: number;
  since?: string;
  byDecision: Record<"ask" | "deny", number>;
  byHarness: Array<{ harness: string; count: number }>;
  byRule: Array<{ rule: string; count: number; decision: GuardDecision }>;
  recent: GuardEvent[];
}

const GUARD_LOG = ".forge/session/guard.jsonl";

export async function readGuardEvents(projectPath: string): Promise<GuardEvent[]> {
  let raw = "";
  try { raw = await readFile(path.join(projectPath, GUARD_LOG), "utf8"); } catch { return []; }
  const events: GuardEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      if (typeof e.at !== "string" || (e.decision !== "ask" && e.decision !== "deny")) continue;
      events.push({
        at: e.at,
        harness: typeof e.harness === "string" ? e.harness : "claude",
        tool: typeof e.tool === "string" ? e.tool : "",
        decision: e.decision,
        rule: typeof e.rule === "string" ? e.rule : "GUARD",
        target: typeof e.target === "string" ? e.target.slice(0, 200) : "",
      });
    } catch { /* skip malformed lines */ }
  }
  return events;
}

export function buildGuardReport(events: GuardEvent[], options: { since?: Date; limit?: number } = {}): GuardReport {
  const list = options.since ? events.filter(e => Date.parse(e.at) >= options.since!.getTime()) : events;
  const harness = new Map<string, number>();
  const rules = new Map<string, { count: number; decision: GuardDecision }>();
  const byDecision = { ask: 0, deny: 0 };
  for (const e of list) {
    byDecision[e.decision as "ask" | "deny"] += 1;
    harness.set(e.harness, (harness.get(e.harness) ?? 0) + 1);
    const rule = rules.get(e.rule) ?? { count: 0, decision: e.decision };
    rule.count += 1;
    if (e.decision === "deny") rule.decision = "deny";
    rules.set(e.rule, rule);
  }
  return {
    total: list.length,
    ...(options.since ? { since: options.since.toISOString() } : {}),
    byDecision,
    byHarness: [...harness].map(([name, count]) => ({ harness: name, count })).sort((a, b) => b.count - a.count || a.harness.localeCompare(b.harness)),
    byRule: [...rules].map(([rule, v]) => ({ rule, ...v })).sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule)),
    recent: list.slice(-(options.limit ?? 10)).reverse(),
  };
}

export function formatGuardReport(report: GuardReport): string {
  if (!report.total) return "FORGE Guard has not blocked or questioned anything yet" + (report.since ? " in this period" : "") + ".\nInstall the hooks with `forge install --hooks` (Claude Code, Cursor, Codex and Gemini CLI).";
  const ruleWidth = Math.min(28, Math.max(...report.recent.map(e => e.rule.length)));
  const lines = [
    `FORGE Guard · ${report.total} intervention${report.total === 1 ? "" : "s"} (${report.byDecision.deny} blocked, ${report.byDecision.ask} asked)`,
    "",
    "By harness: " + report.byHarness.map(h => `${h.harness} ${h.count}`).join(" · "),
    "",
    "Top rules:",
    ...report.byRule.slice(0, 8).map(r => `  ${String(r.count).padStart(4)}  ${r.decision === "deny" ? "deny" : "ask "}  ${r.rule}`),
    "",
    "Recent:",
    ...report.recent.map(e => `  ${e.at.slice(0, 16).replace("T", " ")}  ${e.harness.padEnd(7)} ${e.decision.padEnd(4)} ${e.rule.padEnd(ruleWidth)}  ${e.target}`),
  ];
  return lines.join("\n");
}

export interface GuardCheck { kind: "command" | "read" | "write"; target: string; verdict: GuardVerdict }

/** Dry-run Guard on a command or file path with the project's own config. */
export async function checkGuard(projectPath: string, input: { command?: string; file?: string; write?: boolean }): Promise<GuardCheck> {
  const root = path.resolve(projectPath);
  const config = await loadHarnessHookConfig(root);
  if (input.command !== undefined) {
    return { kind: "command", target: input.command, verdict: config.guard.enabled ? evaluateCommand(input.command, config.guard.allow, config.guard.rules) : { decision: "allow" } };
  }
  const file = input.file ?? "";
  const tool = input.write ? "Write" : "Read";
  return { kind: input.write ? "write" : "read", target: file, verdict: evaluateToolUse(root, tool, { file_path: path.resolve(root, file) }, config) };
}

export function formatGuardCheck(check: GuardCheck): string {
  const { decision, ruleId, reason } = check.verdict;
  const icon = decision === "deny" ? "✗ deny" : decision === "ask" ? "? ask " : "✓ allow";
  const what = check.kind === "command" ? check.target : `${check.kind} ${check.target}`;
  const note = decision === "ask" ? `\n  Codex, Gemini and Cursor file reads cannot pause for approval, so "ask" is enforced as a deny there.` : "";
  const tail = decision === "allow" ? "" : `\n  ${ruleId ?? "GUARD"}: ${reason ?? ""}${note}`;
  return `${icon}  ${what}${tail}`;
}
