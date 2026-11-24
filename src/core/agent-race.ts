import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { LOOP_AGENTS, runVerifiedLoop, type LoopAgent, type LoopRecord, type LoopStatus } from "./verified-loop.js";

/**
 * Agent race: the same task, several agents, one verdict.
 *
 * Each contestant gets its own git worktree, created detached from the same
 * HEAD, and runs FORGE's verified loop there. Contestants run in parallel and
 * cannot see each other's changes. FORGE then ranks the results with its own
 * check runs and integrity gate, not on anything an agent claims. The winner's diff can be applied to the
 * main working tree with `forge race pick`; nothing touches it before that.
 */

export const RACES_DIR = ".forge/races";
export const RACE_SCHEMA_VERSION = 1 as const;

export interface RaceContestant {
  /** Display name, unique within the race (e.g. "claude", "codex-high"). */
  name: string;
  agent: LoopAgent;
  agentCommand?: string[];
  agentArgs?: string[];
}

export interface RaceEntry {
  name: string;
  agent: LoopAgent;
  worktree: string;
  status: LoopStatus;
  reason: string;
  iterations: number;
  durationMs: number;
  filesChanged: string[];
  linesAdded: number;
  linesRemoved: number;
  checksPassed: number;
  checksTotal: number;
  integrity: string[];
  loopId?: string;
  rank: number;
}

export interface RaceRecord {
  schemaVersion: typeof RACE_SCHEMA_VERSION;
  id: string;
  goal: string;
  checks: string[];
  head: string;
  createdAt: string;
  finishedAt?: string;
  setup?: string;
  winner?: string;
  picked?: string;
  entries: RaceEntry[];
}

export interface RaceOptions {
  projectPath: string;
  goal: string;
  checks: string[];
  contestants: RaceContestant[];
  maxIterations?: number;
  /** Shell command run in each worktree before the baseline (e.g. "npm ci"). */
  setup?: string;
  /** Symlink the project's gitignored node_modules into each worktree (default true). */
  linkNodeModules?: boolean;
  agentTimeoutMs?: number;
  checkTimeoutMs?: number;
  now?: () => Date;
  onEvent?: (message: string) => void;
}

interface Exec { exitCode: number | null; output: string }

function exec(command: string, args: string[], cwd: string, options: { shell?: boolean; timeoutMs?: number } = {}): Promise<Exec> {
  return new Promise(resolve => {
    let output = "";
    let child;
    try {
      child = spawn(command, args, { cwd, shell: options.shell ?? false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ exitCode: null, output: String(error) });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 10 * 60_000);
    const collect = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-20_000); };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", error => { clearTimeout(timer); resolve({ exitCode: null, output: output + String(error) }); });
    child.on("close", code => { clearTimeout(timer); resolve({ exitCode: code, output }); });
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec("git", args, cwd, { timeoutMs: 120_000 });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.output.trim().slice(-300)}`);
  return result.output;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const STATUS_RANK: Record<LoopStatus, number> = { passed: 0, failed: 1, stalled: 2, "needs-review": 3, error: 4, running: 5, "dry-run": 6 };

export function rankEntries(entries: RaceEntry[]): RaceEntry[] {
  const sorted = [...entries].sort((a, b) =>
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    b.checksPassed - a.checksPassed ||
    a.iterations - b.iterations ||
    (a.linesAdded + a.linesRemoved) - (b.linesAdded + b.linesRemoved) ||
    a.durationMs - b.durationMs ||
    a.name.localeCompare(b.name));
  return sorted.map((entry, index) => ({ ...entry, rank: index + 1 }));
}

export function parseContestants(value: string, custom: Array<{ name: string; command: string }> = []): RaceContestant[] {
  const contestants: RaceContestant[] = [];
  for (const raw of value.split(",").map(v => v.trim()).filter(Boolean)) {
    if (!(LOOP_AGENTS as readonly string[]).includes(raw) || raw === "command") throw new Error(`Unknown agent "${raw}". Use ${LOOP_AGENTS.filter(a => a !== "command").join(", ")}, or --contestant name="program args".`);
    contestants.push({ name: raw, agent: raw as LoopAgent });
  }
  for (const entry of custom) {
    const argv = entry.command.split(/\s+/).filter(Boolean);
    if (!argv.length) throw new Error(`Contestant ${entry.name} needs a command.`);
    contestants.push({ name: entry.name, agent: "command", agentCommand: argv });
  }
  return contestants;
}

function newRaceId(now: Date): string {
  return `race-${now.toISOString().slice(0, 19).replace(/[-:T]/g, "")}-${randomBytes(3).toString("hex")}`;
}

async function saveRace(root: string, record: RaceRecord): Promise<void> {
  const file = path.join(root, RACES_DIR, `${record.id}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", "utf8");
  try { await rename(temporary, file); } catch (error) { await rm(temporary, { force: true }); throw error; }
}

async function ensureIgnored(root: string): Promise<void> {
  const dir = path.join(root, RACES_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, ".gitignore"), "# FORGE race worktrees and receipts are local\n*\n", "utf8");
}

async function diffStat(worktree: string, head: string): Promise<{ added: number; removed: number; files: string[] }> {
  await git(worktree, ["add", "-A", "--", ".", ":(exclude).forge", ":(exclude)node_modules"]).catch(() => "");
  const numstat = await git(worktree, ["diff", "--cached", "--numstat", head]).catch(() => "");
  let added = 0;
  let removed = 0;
  const files: string[] = [];
  for (const line of numstat.split("\n")) {
    const [a, r, file] = line.split("\t");
    if (!file) continue;
    files.push(file);
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }
  return { added, removed, files };
}

export async function runRace(options: RaceOptions): Promise<RaceRecord> {
  const root = await realpath(path.resolve(options.projectPath));
  const now = options.now ?? (() => new Date());
  const emit = options.onEvent ?? (() => undefined);
  const goal = options.goal.trim();
  if (!goal || goal.length > 4000) throw new Error("--goal must be 1-4000 characters.");
  const checks = options.checks.map(c => c.trim()).filter(Boolean);
  if (!checks.length) throw new Error("Give at least one --check command; FORGE ranks contestants by running it.");
  if (options.contestants.length < 2) throw new Error("A race needs at least two contestants (e.g. --agents claude,codex).");
  if (options.contestants.length > 6) throw new Error("At most 6 contestants.");
  const names = new Set<string>();
  for (const c of options.contestants) {
    if (!NAME.test(c.name)) throw new Error(`Invalid contestant name "${c.name}" (lowercase letters, digits, - and _).`);
    if (names.has(c.name)) throw new Error(`Contestant "${c.name}" appears twice; give custom contestants distinct names.`);
    names.add(c.name);
  }
  const head = (await git(root, ["rev-parse", "HEAD"]).catch(() => "")).trim();
  if (!head) throw new Error("A race needs a git repository with at least one commit.");
  const dirty = (await git(root, ["status", "--porcelain", "--untracked-files=no"])).trim();
  if (dirty) emit("note: uncommitted changes in your working tree are not part of the race; contestants start from HEAD");

  await ensureIgnored(root);
  const record: RaceRecord = { schemaVersion: RACE_SCHEMA_VERSION, id: newRaceId(now()), goal, checks, head, createdAt: now().toISOString(), ...(options.setup ? { setup: options.setup } : {}), entries: [] };
  const raceDir = path.join(root, RACES_DIR, record.id);
  await mkdir(raceDir, { recursive: true });
  await saveRace(root, record);

  let nodeModules = false;
  if (options.linkNodeModules !== false) {
    const info = await lstat(path.join(root, "node_modules")).catch(() => undefined);
    nodeModules = Boolean(info?.isDirectory()) && (await exec("git", ["check-ignore", "-q", "node_modules"], root)).exitCode === 0;
  }

  const results = await Promise.all(options.contestants.map(async (contestant): Promise<RaceEntry> => {
    const worktree = path.join(raceDir, contestant.name);
    const started = Date.now();
    const base: Omit<RaceEntry, "status" | "reason"> = { name: contestant.name, agent: contestant.agent, worktree: path.relative(root, worktree).split(path.sep).join("/"), iterations: 0, durationMs: 0, filesChanged: [], linesAdded: 0, linesRemoved: 0, checksPassed: 0, checksTotal: checks.length, integrity: [], rank: 0 };
    try {
      await git(root, ["worktree", "add", "--detach", worktree, head]);
      if (nodeModules) await symlink(path.join(root, "node_modules"), path.join(worktree, "node_modules"), "dir").catch(() => undefined);
      if (options.setup) {
        emit(`${contestant.name}: setup`);
        const setup = await exec(options.setup, [], worktree, { shell: true, timeoutMs: 20 * 60_000 });
        if (setup.exitCode !== 0) return { ...base, status: "error", reason: `Setup failed: ${setup.output.trim().slice(-300)}`, durationMs: Date.now() - started };
      }
      const loop: LoopRecord = await runVerifiedLoop({
        projectPath: worktree,
        goal,
        checks,
        agent: contestant.agent,
        ...(contestant.agentCommand ? { agentCommand: contestant.agentCommand } : {}),
        ...(contestant.agentArgs ? { agentArgs: contestant.agentArgs } : {}),
        ...(options.maxIterations ? { maxIterations: options.maxIterations } : {}),
        ...(options.agentTimeoutMs ? { agentTimeoutMs: options.agentTimeoutMs } : {}),
        ...(options.checkTimeoutMs ? { checkTimeoutMs: options.checkTimeoutMs } : {}),
        allowDirty: true,
        now,
        onEvent: message => emit(`${contestant.name}: ${message}`),
      });
      const last = loop.iterations.at(-1);
      const stat = await diffStat(worktree, head);
      const finalChecks = last?.checks ?? loop.baseline.checks;
      return {
        ...base,
        status: loop.status,
        reason: loop.reason,
        loopId: loop.id,
        iterations: loop.iterations.length,
        durationMs: Date.now() - started,
        filesChanged: stat.files,
        linesAdded: stat.added,
        linesRemoved: stat.removed,
        checksPassed: finalChecks.filter(c => c.passed).length,
        integrity: [...new Set(loop.iterations.flatMap(i => i.integrity.map(issue => `${issue.kind}: ${issue.file}`)))],
      };
    } catch (error) {
      return { ...base, status: "error", reason: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started };
    }
  }));

  record.entries = rankEntries(results);
  const top = record.entries[0];
  if (top && top.status === "passed") record.winner = top.name;
  record.finishedAt = now().toISOString();
  await saveRace(root, record);
  return record;
}

export async function listRaces(projectPath: string): Promise<RaceRecord[]> {
  const dir = path.join(path.resolve(projectPath), RACES_DIR);
  const names = await readdir(dir).catch(() => [] as string[]);
  const races: RaceRecord[] = [];
  for (const name of names.filter(n => /^race-[\w-]+\.json$/.test(n))) {
    try { races.push(JSON.parse(await readFile(path.join(dir, name), "utf8")) as RaceRecord); } catch { /* skip */ }
  }
  return races.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function readRace(projectPath: string, id?: string): Promise<RaceRecord | undefined> {
  const races = await listRaces(projectPath);
  return id ? races.find(r => r.id === id) : races[0];
}

/** Apply a contestant's diff to the main working tree (3-way, so local edits are merged, not overwritten). */
export async function pickRace(projectPath: string, id: string | undefined, name?: string): Promise<{ race: RaceRecord; entry: RaceEntry; files: string[] }> {
  const root = await realpath(path.resolve(projectPath));
  const race = await readRace(root, id);
  if (!race) throw new Error("No race found. Start one with: forge race --goal \"...\" --check \"npm test\" --agents claude,codex");
  const chosen = name ?? race.winner;
  if (!chosen) throw new Error("No contestant passed, so there is no winner to pick. Name one explicitly after reviewing its worktree: forge race pick " + race.id + " <name>");
  const entry = race.entries.find(e => e.name === chosen);
  if (!entry) throw new Error(`No contestant "${chosen}" in ${race.id}.`);
  const worktree = path.resolve(root, entry.worktree);
  if (!worktree.startsWith(path.join(root, RACES_DIR) + path.sep)) throw new Error("Race worktree path is outside .forge/races.");
  await lstat(worktree).catch(() => { throw new Error(`The worktree for ${chosen} was removed. Its changes are no longer available.`); });
  await git(worktree, ["add", "-A", "--", ".", ":(exclude).forge", ":(exclude)node_modules"]);
  const patch = await git(worktree, ["diff", "--cached", "--binary", race.head]);
  if (!patch.trim()) throw new Error(`${chosen} made no changes.`);
  const patchFile = path.join(root, RACES_DIR, `${race.id}-${chosen}.patch`);
  await writeFile(patchFile, patch, "utf8");
  const applied = await exec("git", ["apply", "--3way", "--whitespace=nowarn", patchFile], root);
  if (applied.exitCode !== 0) throw new Error(`Could not apply ${chosen}'s changes cleanly: ${applied.output.trim().slice(-400)}\nThe patch is saved at ${path.relative(root, patchFile)}.`);
  race.picked = chosen;
  await saveRace(root, race);
  const files = (await git(worktree, ["diff", "--cached", "--name-only", race.head])).split("\n").filter(Boolean);
  return { race, entry, files };
}

/** Remove a race's worktrees (receipts are kept). */
export async function cleanRace(projectPath: string, id?: string): Promise<{ race: RaceRecord; removed: string[] }> {
  const root = await realpath(path.resolve(projectPath));
  const race = await readRace(root, id);
  if (!race) throw new Error("No race found.");
  const removed: string[] = [];
  for (const entry of race.entries) {
    const worktree = path.resolve(root, entry.worktree);
    if (!worktree.startsWith(path.join(root, RACES_DIR) + path.sep)) continue;
    if (!(await lstat(worktree).catch(() => undefined))) continue;
    await git(root, ["worktree", "remove", "--force", worktree]).catch(async () => { await rm(worktree, { recursive: true, force: true }); });
    removed.push(entry.name);
  }
  await git(root, ["worktree", "prune"]).catch(() => "");
  await rm(path.join(root, RACES_DIR, race.id), { recursive: true, force: true });
  return { race, removed };
}

const STATUS_ICON: Record<LoopStatus, string> = { passed: "✓", failed: "✗", stalled: "…", "needs-review": "⚠", error: "!", running: "·", "dry-run": "·" };

export function formatRace(race: RaceRecord): string {
  const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;
  const width = Math.max(...race.entries.map(e => e.name.length), 6);
  const lines = [
    `FORGE race ${race.id}`,
    `  goal    ${race.goal.split("\n")[0]?.slice(0, 90)}`,
    `  checks  ${race.checks.join(" · ")}`,
    "",
    `  #  ${"agent".padEnd(width)}  result        checks  iter  diff          time`,
    ...race.entries.map(e => `  ${e.rank}  ${e.name.padEnd(width)}  ${(STATUS_ICON[e.status] + " " + e.status).padEnd(13)} ${`${e.checksPassed}/${e.checksTotal}`.padStart(6)}  ${String(e.iterations).padStart(4)}  ${`+${e.linesAdded} -${e.linesRemoved}`.padEnd(12)}  ${seconds(e.durationMs)}`),
  ];
  for (const e of race.entries) {
    if (e.integrity.length) lines.push(`     ⚠ ${e.name}: ${e.integrity.slice(0, 3).join("; ")}`);
    else if (e.status === "error") lines.push(`     ! ${e.name}: ${e.reason.slice(0, 160)}`);
  }
  lines.push("");
  if (race.winner) lines.push(`Winner: ${race.winner}, verified by FORGE. Review: git -C ${race.entries.find(e => e.name === race.winner)?.worktree} diff ${race.head.slice(0, 8)}`, `Apply it:  forge race pick ${race.id}`, `Clean up:  forge race clean ${race.id}`);
  else lines.push("No contestant passed every check. Review the worktrees, then `forge race pick " + race.id + " <name>` or `forge race clean " + race.id + "`.");
  if (race.picked) lines.push(`Picked: ${race.picked}`);
  return lines.join("\n");
}
