import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { QUALITY_CONFIG } from "./harness-hooks.js";
import { activeInstincts, formatInstinctContext } from "./instincts.js";

/**
 * Verified agent loop.
 *
 * FORGE runs a coding agent non-interactively, then runs the user's checks
 * itself. It repeats until every check passes, the iteration budget is spent
 * or the agent stalls. Success is decided by FORGE's own check runs, never by
 * what the agent says. Every iteration leaves a receipt in .forge/loops/.
 *
 * Integrity gate: if the agent deletes tests, adds skip/only markers, loosens
 * lint/format configs, edits package.json scripts or CI workflows, the loop
 * stops with `needs-review` instead of counting a pass.
 */

export const LOOPS_DIR = ".forge/loops";
export const LOOP_SCHEMA_VERSION = 1 as const;

export type LoopAgent = "claude" | "codex" | "gemini" | "opencode" | "command";
export const LOOP_AGENTS: readonly LoopAgent[] = ["claude", "codex", "gemini", "opencode", "command"];
export type LoopStatus = "running" | "passed" | "failed" | "stalled" | "needs-review" | "error" | "dry-run";

export interface CheckResult { command: string; exitCode: number | null; passed: boolean; durationMs: number; timedOut: boolean; outputTail: string }
export interface IntegrityIssue { kind: "deleted-test" | "skip-marker" | "quality-config" | "package-scripts" | "ci-workflow" | "check-file"; file: string; detail: string }

export interface LoopIteration {
  n: number;
  startedAt: string;
  durationMs: number;
  agent: { exitCode: number | null; timedOut: boolean; outputTail: string };
  filesChanged: string[];
  checks: CheckResult[];
  integrity: IntegrityIssue[];
}

export interface LoopRecord {
  schemaVersion: typeof LOOP_SCHEMA_VERSION;
  id: string;
  goal: string;
  agent: LoopAgent;
  agentCommand: string[];
  checks: string[];
  maxIterations: number;
  createdAt: string;
  finishedAt?: string;
  status: LoopStatus;
  reason: string;
  baseline: { head?: string; checks: CheckResult[] };
  iterations: LoopIteration[];
}

export interface LoopOptions {
  projectPath: string;
  goal: string;
  checks: string[];
  agent?: LoopAgent;
  /** For agent "command": argv; the prompt is passed on stdin and in FORGE_LOOP_PROMPT. */
  agentCommand?: string[];
  /** Extra arguments appended to the built-in agent command. */
  agentArgs?: string[];
  maxIterations?: number;
  agentTimeoutMs?: number;
  checkTimeoutMs?: number;
  allowDirty?: boolean;
  dryRun?: boolean;
  now?: () => Date;
  onEvent?: (message: string) => void;
}

const MAX_TAIL = 4000;
const tail = (text: string, size = MAX_TAIL) => (text.length > size ? "…" + text.slice(-size) : text);

interface Exec { exitCode: number | null; output: string; timedOut: boolean; durationMs: number }

function run(command: string, args: string[], options: { cwd: string; timeoutMs: number; input?: string; shell?: boolean; env?: NodeJS.ProcessEnv }): Promise<Exec> {
  return new Promise(resolve => {
    const started = Date.now();
    let output = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(command, args, { cwd: options.cwd, shell: options.shell ?? false, env: { ...process.env, ...options.env }, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ exitCode: null, output: String(error), timedOut: false, durationMs: 0 });
      return;
    }
    const collect = (chunk: Buffer) => { output += chunk.toString("utf8"); if (output.length > 256 * 1024) output = output.slice(-128 * 1024); };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000).unref(); }, options.timeoutMs);
    child.on("error", error => { output += String(error); });
    child.on("close", code => { clearTimeout(timer); resolve({ exitCode: code, output, timedOut, durationMs: Date.now() - started }); });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input ?? "");
  });
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await run("git", args, { cwd: root, timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${tail(result.output, 300)}`);
  return result.output;
}

/** Built-in non-interactive agent invocations. None of them bypass the agent's own permission system. */
export function agentInvocation(agent: LoopAgent, prompt: string, extra: string[] = [], custom: string[] = []): { command: string; args: string[]; input?: string } {
  switch (agent) {
    case "claude": return { command: "claude", args: ["-p", prompt, "--permission-mode", "acceptEdits", ...extra] };
    case "codex": return { command: "codex", args: ["exec", "--sandbox", "workspace-write", ...extra, prompt] };
    case "gemini": return { command: "gemini", args: ["-p", prompt, ...extra] };
    case "opencode": return { command: "opencode", args: ["run", ...extra, prompt] };
    case "command": {
      const [command, ...args] = custom;
      if (!command) throw new Error("--agent command requires --agent-cmd \"program arg...\".");
      return { command, args: [...args, ...extra], input: prompt };
    }
  }
}

export function buildLoopPrompt(goal: string, checks: string[], previous: LoopIteration | undefined, baseline: CheckResult[], instincts: string): string {
  const failing = previous ? previous.checks.filter(c => !c.passed) : baseline.filter(c => !c.passed);
  const lines = [
    `Goal: ${goal}`,
    "",
    "You are running inside a FORGE verified loop. After you finish, FORGE runs these checks itself and decides whether the goal is met:",
    ...checks.map(c => `- \`${c}\``),
    "",
    "Rules:",
    "- Make real changes that satisfy the goal. Do not delete or skip tests, add .only/.skip markers, loosen lint/format/type configs, or edit package.json scripts or CI workflows to make checks pass — FORGE detects this and stops the loop.",
    "- Keep the change focused on the goal; do not commit, push or publish.",
  ];
  if (failing.length) {
    lines.push("", previous ? `Iteration ${previous.n} result — these checks still fail:` : "Current state — these checks fail before any change:");
    for (const check of failing) lines.push("", `$ ${check.command}  (exit ${check.exitCode ?? "timeout"})`, "```", tail(check.outputTail, 2500), "```");
  }
  if (instincts) lines.push("", instincts);
  return lines.join("\n");
}

async function runChecks(root: string, checks: string[], timeoutMs: number): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const command of checks) {
    const r = await run(command, [], { cwd: root, timeoutMs, shell: true, env: { CI: "1", FORCE_COLOR: "0" } });
    results.push({ command, exitCode: r.exitCode, passed: r.exitCode === 0 && !r.timedOut, durationMs: r.durationMs, timedOut: r.timedOut, outputTail: tail(r.output) });
  }
  return results;
}

const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py)$|(?:^|\/)test_[^/]+\.py$/;
const SKIP_MARKER = /\b(?:it|test|describe|context)\.(?:skip|only|todo)\s*\(|\bx(?:it|describe|test)\s*\(|\bf(?:it|describe)\s*\(|@pytest\.mark\.(?:skip|xfail)|\bpytest\.skip\s*\(|\bt\.Skip(?:Now|f)?\s*\(|#\[ignore\]|@Disabled\b|@Ignore\b|\bunittest\.skip/;

/** Files that are allowed to change silently. Everything else is part of the agent's diff. */
const IGNORED = /^(?:\.forge\/|node_modules\/|dist\/|build\/|coverage\/|\.next\/|target\/)/;

async function changedFiles(root: string): Promise<Array<{ status: string; file: string }>> {
  const out = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const entries: Array<{ status: string; file: string }> = [];
  const parts = out.split("\0").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] as string;
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    if (status.startsWith("R") || status.startsWith("C")) i += 1; // rename/copy: next part is the source
    if (!IGNORED.test(file)) entries.push({ status, file });
  }
  return entries;
}

function scriptsOf(text: string | undefined): string {
  try { return JSON.stringify((JSON.parse(text ?? "{}") as { scripts?: unknown }).scripts ?? {}); } catch { return "invalid"; }
}

async function fileHash(root: string, file: string): Promise<string | undefined> {
  try { return createHash("sha256").update(await readFile(path.join(root, file))).digest("hex"); } catch { return undefined; }
}

/** Compare the working tree with the loop's starting point and report ways an agent could game the checks. */
export async function checkIntegrity(root: string, start: { head?: string; packageScripts: string; checkFiles: Map<string, string | undefined> }): Promise<{ files: string[]; issues: IntegrityIssue[] }> {
  const entries = await changedFiles(root);
  const issues: IntegrityIssue[] = [];
  for (const { status, file } of entries) {
    if (status.includes("D") && TEST_FILE.test(file)) issues.push({ kind: "deleted-test", file, detail: "test file deleted" });
    if (QUALITY_CONFIG.test(file) || /(?:^|\/)(?:tsconfig[\w.-]*\.json|jest\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|pytest\.ini|setup\.cfg|\.coveragerc)$/.test(file)) issues.push({ kind: "quality-config", file, detail: "lint/format/type/test config changed" });
    if (file.startsWith(".github/workflows/")) issues.push({ kind: "ci-workflow", file, detail: "CI workflow changed" });
  }
  // Skip/only markers added in this loop (diff against the starting commit plus new files).
  const tracked = entries.filter(e => !e.status.includes("D") && !e.status.startsWith("??") && TEST_FILE.test(e.file)).map(e => e.file);
  if (tracked.length && start.head) {
    const diff = await git(root, ["diff", "--unified=0", "--no-color", start.head, "--", ...tracked]).catch(() => "");
    let current = "";
    for (const line of diff.split("\n")) {
      if (line.startsWith("+++ b/")) current = line.slice(6);
      else if (line.startsWith("+") && !line.startsWith("+++") && SKIP_MARKER.test(line)) issues.push({ kind: "skip-marker", file: current, detail: `added: ${line.slice(1).trim().slice(0, 120)}` });
    }
  }
  for (const { status, file } of entries.filter(e => e.status.startsWith("??") && TEST_FILE.test(e.file))) {
    void status;
    const text = await readFile(path.join(root, file), "utf8").catch(() => "");
    const marker = text.split("\n").find(line => SKIP_MARKER.test(line));
    if (marker) issues.push({ kind: "skip-marker", file, detail: `new test file contains: ${marker.trim().slice(0, 120)}` });
  }
  const pkg = await readFile(path.join(root, "package.json"), "utf8").catch(() => undefined);
  if (scriptsOf(pkg) !== start.packageScripts) issues.push({ kind: "package-scripts", file: "package.json", detail: "package.json scripts changed" });
  for (const [file, hash] of start.checkFiles) {
    if (await fileHash(root, file) !== hash) issues.push({ kind: "check-file", file, detail: "a file named in a check command changed" });
  }
  const unique = new Map(issues.map(i => [`${i.kind}|${i.file}|${i.detail}`, i]));
  return { files: entries.map(e => e.file).sort(), issues: [...unique.values()] };
}

function newLoopId(now: Date): string {
  return `loop-${now.toISOString().slice(0, 19).replace(/[-:T]/g, "")}-${randomBytes(3).toString("hex")}`;
}

async function saveLoop(root: string, record: LoopRecord): Promise<void> {
  const file = path.join(root, LOOPS_DIR, `${record.id}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", "utf8");
  try { await rename(temporary, file); } catch (error) { await rm(temporary, { force: true }); throw error; }
}

/** Files referenced directly by check commands (e.g. `node scripts/check.mjs`) are protected too. */
function checkFilePaths(checks: string[]): string[] {
  const files = new Set<string>();
  for (const check of checks) for (const token of check.split(/\s+/)) if (/^\.?[\w./-]+\.(?:[cm]?[jt]s|py|sh|rb|go)$/.test(token) && !token.startsWith("/") && !token.includes("..")) files.add(token.replace(/^\.\//, ""));
  return [...files];
}

export async function runVerifiedLoop(options: LoopOptions): Promise<LoopRecord> {
  const root = await realpath(path.resolve(options.projectPath));
  const now = options.now ?? (() => new Date());
  const emit = options.onEvent ?? (() => undefined);
  const goal = options.goal.trim();
  if (!goal || goal.length > 4000) throw new Error("--goal must be 1-4000 characters.");
  const checks = options.checks.map(c => c.trim()).filter(Boolean);
  if (!checks.length) throw new Error("Give at least one --check command; FORGE decides success by running it.");
  if (checks.length > 10) throw new Error("At most 10 checks.");
  const agent = options.agent ?? "claude";
  if (!LOOP_AGENTS.includes(agent)) throw new Error(`Unknown agent "${agent}". Use ${LOOP_AGENTS.join(", ")}.`);
  const maxIterations = Math.max(1, Math.min(20, Math.floor(options.maxIterations ?? 5)));
  const agentTimeoutMs = options.agentTimeoutMs ?? 20 * 60_000;
  const checkTimeoutMs = options.checkTimeoutMs ?? 10 * 60_000;

  const head = (await git(root, ["rev-parse", "HEAD"]).catch(() => "")).trim() || undefined;
  if (!head) throw new Error("The verified loop needs a git repository with at least one commit, so every change can be reviewed and reverted.");
  const dirty = await changedFiles(root);
  if (dirty.length && !options.allowDirty) throw new Error(`The working tree has ${dirty.length} uncommitted change(s). Commit or stash them first (or pass --allow-dirty) so the loop's diff is only the agent's work.`);

  const instincts = formatInstinctContext(await activeInstincts(root, { includeGlobal: true }).catch(() => []));
  const preview = agentInvocation(agent, "<prompt>", options.agentArgs, options.agentCommand);
  const record: LoopRecord = {
    schemaVersion: LOOP_SCHEMA_VERSION,
    id: newLoopId(now()),
    goal,
    agent,
    agentCommand: [preview.command, ...preview.args],
    checks,
    maxIterations,
    createdAt: now().toISOString(),
    status: "running",
    reason: "",
    baseline: { head, checks: [] },
    iterations: [],
  };
  if (options.dryRun) {
    record.status = "dry-run";
    record.reason = "Dry run: nothing was executed. Remove --dry-run to start the loop.";
    return record;
  }

  emit(`baseline: running ${checks.length} check(s)`);
  record.baseline.checks = await runChecks(root, checks, checkTimeoutMs);
  await saveLoop(root, record);
  if (record.baseline.checks.every(c => c.passed)) {
    record.status = "passed";
    record.reason = "All checks already pass; nothing for the agent to do.";
    record.finishedAt = now().toISOString();
    await saveLoop(root, record);
    return record;
  }

  const start = {
    head,
    packageScripts: scriptsOf(await readFile(path.join(root, "package.json"), "utf8").catch(() => undefined)),
    checkFiles: new Map(await Promise.all(checkFilePaths(checks).map(async f => [f, await fileHash(root, f)] as const))),
  };
  let unchangedStreak = 0;
  let lastFingerprint = "";
  for (let n = 1; n <= maxIterations; n++) {
    const started = Date.now();
    const previous = record.iterations.at(-1);
    const prompt = buildLoopPrompt(goal, checks, previous, record.baseline.checks, instincts);
    const call = agentInvocation(agent, prompt, options.agentArgs, options.agentCommand);
    emit(`iteration ${n}/${maxIterations}: running ${agent}`);
    const result = await run(call.command, call.args, { cwd: root, timeoutMs: agentTimeoutMs, ...(call.input !== undefined ? { input: call.input } : {}), env: { FORGE_LOOP_ID: record.id, FORGE_LOOP_ITERATION: String(n), FORGE_LOOP_PROMPT: prompt } });
    if (result.exitCode === null && !result.timedOut && /ENOENT/.test(result.output)) {
      record.status = "error";
      record.reason = `Could not start \`${call.command}\`. Is it installed and on PATH?`;
      break;
    }
    const integrity = await checkIntegrity(root, start);
    emit(`iteration ${n}: ${integrity.files.length} file(s) changed; running checks`);
    const checkResults = await runChecks(root, checks, checkTimeoutMs);
    const iteration: LoopIteration = {
      n,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      agent: { exitCode: result.exitCode, timedOut: result.timedOut, outputTail: tail(result.output, 2000) },
      filesChanged: integrity.files,
      checks: checkResults,
      integrity: integrity.issues,
    };
    record.iterations.push(iteration);
    await saveLoop(root, record);

    if (integrity.issues.length) {
      record.status = "needs-review";
      record.reason = `The agent changed what the checks measure (${[...new Set(integrity.issues.map(i => i.kind))].join(", ")}). Review the diff before trusting any result.`;
      break;
    }
    if (checkResults.every(c => c.passed)) {
      record.status = "passed";
      record.reason = `All ${checks.length} check(s) passed after ${n} iteration(s), verified by FORGE.`;
      break;
    }
    const fingerprint = createHash("sha256").update((await git(root, ["diff", "--no-color", head]).catch(() => "")) + integrity.files.join("\n")).digest("hex");
    unchangedStreak = fingerprint === lastFingerprint ? unchangedStreak + 1 : 0;
    lastFingerprint = fingerprint;
    if (unchangedStreak >= 1) {
      record.status = "stalled";
      record.reason = `Iteration ${n} made no new changes; stopping instead of spending more budget.`;
      break;
    }
    if (n === maxIterations) {
      record.status = "failed";
      record.reason = `Checks still fail after ${maxIterations} iteration(s).`;
    }
  }
  if (record.status === "running") { record.status = "failed"; record.reason ||= "Loop ended without passing checks."; }
  record.finishedAt = now().toISOString();
  await saveLoop(root, record);
  return record;
}

export async function listLoops(projectPath: string): Promise<LoopRecord[]> {
  const dir = path.join(path.resolve(projectPath), LOOPS_DIR);
  let names: string[] = [];
  try { names = (await readdir(dir)).filter(n => /^loop-[\w-]+\.json$/.test(n)); } catch { return []; }
  const records: LoopRecord[] = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, name), "utf8")) as LoopRecord;
      if (parsed.schemaVersion === LOOP_SCHEMA_VERSION && typeof parsed.id === "string") records.push(parsed);
    } catch { /* skip unreadable receipts */ }
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function readLoop(projectPath: string, id?: string): Promise<LoopRecord | undefined> {
  const loops = await listLoops(projectPath);
  return id ? loops.find(l => l.id === id) : loops[0];
}

export function formatLoop(record: LoopRecord, options: { verbose?: boolean } = {}): string {
  const icon: Record<string, string> = { passed: "✓", failed: "✗", stalled: "■", "needs-review": "⚠", error: "!", running: "…", "dry-run": "○" };
  const lines = [
    `FORGE loop ${record.id} — ${icon[record.status] ?? ""} ${record.status}`,
    `  goal      ${record.goal.split("\n")[0]?.slice(0, 120)}`,
    `  agent     ${record.agentCommand.join(" ")}`,
    `  checks    ${record.checks.join("  ·  ")}`,
    `  baseline  ${record.baseline.checks.map(c => `${c.passed ? "✓" : "✗"} ${c.command}`).join("  ") || "not run"}`,
  ];
  for (const it of record.iterations) {
    lines.push(`  #${it.n}  ${it.checks.map(c => `${c.passed ? "✓" : "✗"} ${c.command}`).join("  ")}  · ${it.filesChanged.length} file(s) · ${(it.durationMs / 1000).toFixed(0)}s${it.integrity.length ? `  ⚠ ${it.integrity.length} integrity issue(s)` : ""}`);
    if (options.verbose) for (const issue of it.integrity) lines.push(`        ⚠ ${issue.kind}: ${issue.file} — ${issue.detail}`);
  }
  lines.push("", record.reason);
  return lines.join("\n");
}
