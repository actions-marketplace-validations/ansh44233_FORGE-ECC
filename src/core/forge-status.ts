import path from "node:path";
import { analyzeContext } from "./context-budget.js";
import { doctorHarness } from "./harness-installer.js";
import { readGuardEvents } from "./guard-report.js";
import { mcpMatrix } from "./mcp-sync.js";
import { listLoops } from "./verified-loop.js";
import { listRaces } from "./agent-race.js";

/**
 * `forge status`: one screen for the whole harness. It covers install health,
 * where Guard is live, the context budget, MCP coverage, and the latest loop
 * and race, each with the next command to run.
 */

export interface ForgeStatus {
  install: { installed: boolean; healthy: boolean; version?: string; profile?: string; targets: string[]; issues: number };
  guard: { live: string[]; missing: string[]; interventions: number; lastDay: number };
  context: { grade: string; worst: number; heaviest?: string; findings: number };
  mcp: { servers: number; gaps: number };
  loop?: { id: string; status: string; goal: string };
  race?: { id: string; winner?: string; agents: number };
  next: string[];
}

const HOOK_CAPABLE = new Set(["claude", "cursor", "codex", "gemini"]);

export async function forgeStatus(projectPath: string, forgeVersion: string, now: () => Date = () => new Date()): Promise<ForgeStatus> {
  const root = path.resolve(projectPath);
  const [doctor, events, context, mcp, loops, races] = await Promise.all([
    doctorHarness({ projectPath: root, forgeVersion }).catch(() => undefined),
    readGuardEvents(root),
    analyzeContext(root),
    mcpMatrix(root).catch(() => []),
    listLoops(root).catch(() => []),
    listRaces(root).catch(() => []),
  ]);
  const targets = (doctor?.targets ?? []) as string[];
  const live = (doctor?.hookTargets ?? []) as string[];
  const missing = targets.filter(t => HOOK_CAPABLE.has(t) && !live.includes(t));
  const dayAgo = now().getTime() - 86_400_000;
  const heaviest = [...context.harnesses].sort((a, b) => b.tokens - a.tokens)[0];
  // Tools this repo uses: any with a configured server, plus installed harnesses that support MCP.
  const columns = ["claude", "cursor", "codex", "gemini", "copilot", "opencode", "kiro"].filter(t => mcp.some(r => r.targets[t as keyof typeof r.targets]) || (mcp.length > 0 && targets.includes(t)));
  const gaps = mcp.filter(r => columns.some(t => !r.targets[t as keyof typeof r.targets])).length;
  const loop = loops[0];
  const race = races[0];
  const issues = doctor ? doctor.summary.missing + doctor.summary.modified + doctor.summary.outdated : 0;

  const next: string[] = [];
  if (!doctor?.installed) next.push("forge install . --hooks");
  else if (!doctor.healthy) next.push("forge repair .");
  if (doctor?.installed && missing.length) next.push(`forge install --hooks   # Guard is not live in ${missing.join(", ")}`);
  if (context.findings.some(f => f.severity !== "low")) next.push("forge context --verbose   # trim what loads every session");
  if (gaps) next.push("forge mcp sync   # some MCP servers are missing in some tools");
  if (loop?.status === "needs-review") next.push(`forge loop status ${loop.id}   # review before trusting the result`);
  if (race?.winner && !race.picked) next.push(`forge race pick ${race.id}   # apply ${race.winner}'s verified changes`);

  return {
    install: { installed: Boolean(doctor?.installed), healthy: Boolean(doctor?.healthy), ...(doctor?.forgeVersion ? { version: doctor.forgeVersion } : {}), ...(doctor?.profile ? { profile: doctor.profile } : {}), targets, issues },
    guard: { live, missing, interventions: events.length, lastDay: events.filter(e => Date.parse(e.at) >= dayAgo).length },
    context: { grade: context.grade, worst: context.worst, ...(heaviest && heaviest.tokens ? { heaviest: heaviest.harness } : {}), findings: context.findings.length },
    mcp: { servers: mcp.length, gaps },
    ...(loop ? { loop: { id: loop.id, status: loop.status, goal: loop.goal.split("\n")[0]?.slice(0, 80) ?? "" } } : {}),
    ...(race ? { race: { id: race.id, ...(race.winner ? { winner: race.winner } : {}), agents: race.entries.length } } : {}),
    next,
  };
}

export function formatStatus(status: ForgeStatus): string {
  const ok = (good: boolean) => (good ? "✓" : "!");
  const i = status.install;
  const lines = [
    "FORGE status",
    `  ${ok(i.installed && i.healthy)} install   ${i.installed ? `${i.version ?? "?"} · ${i.profile ?? "?"} · ${i.targets.join(", ") || "no targets"}${i.issues ? ` · ${i.issues} file issue(s)` : ""}` : "not installed"}`,
    `  ${ok(status.guard.live.length > 0 && !status.guard.missing.length)} guard     ${status.guard.live.length ? `live in ${status.guard.live.join(", ")}` : "not live"}${status.guard.missing.length ? ` · missing in ${status.guard.missing.join(", ")}` : ""} · ${status.guard.interventions} intervention(s), ${status.guard.lastDay} in 24h`,
    `  ${ok(status.context.grade <= "B")} context   grade ${status.context.grade} · heaviest ${status.context.heaviest ?? "-"} ≈ ${status.context.worst.toLocaleString("en-US")} tokens · ${status.context.findings} finding(s)`,
    `  ${ok(!status.mcp.gaps)} mcp       ${status.mcp.servers} server(s)${status.mcp.gaps ? ` · ${status.mcp.gaps} missing in some tools` : ""}`,
  ];
  if (status.loop) lines.push(`  ${ok(status.loop.status === "passed")} loop      ${status.loop.status} · ${status.loop.goal}`);
  if (status.race) lines.push(`  ${ok(Boolean(status.race.winner))} race      ${status.race.winner ? `winner ${status.race.winner}` : "no winner"} of ${status.race.agents}`);
  lines.push("");
  lines.push(status.next.length ? "Next:" : "Nothing to do. Everything FORGE checks looks good.");
  for (const step of status.next) lines.push(`  ${step}`);
  return lines.join("\n");
}
