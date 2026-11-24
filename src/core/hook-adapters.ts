import { readFile } from "node:fs/promises";
import { runHarnessHook, type HookEventName, type HookInput, type HookOutput } from "./harness-hooks.js";

/**
 * Native hook adapters: FORGE Guard, the verification gate, memory, the prompt
 * secret guard and handoffs for Cursor, Codex and Gemini CLI.
 *
 * Each harness has its own event names, payloads and response schema. The
 * adapter translates the native payload into FORGE's hook input, runs the same
 * handler Claude Code uses, and translates the answer back. Policy lives in
 * one place; only the wire format differs.
 *
 * Differences that matter:
 * - Codex does not support "ask" in PreToolUse; Cursor does not enforce it in
 *   beforeReadFile; Gemini only has allow/deny. FORGE maps "ask" to "deny" there
 *   and tells the agent to get explicit approval from the user.
 * - Cursor permission hooks must always print valid JSON, or Cursor blocks the action.
 */

export type NativeHookHarness = "cursor" | "codex" | "gemini";
export const NATIVE_HOOK_HARNESSES: readonly NativeHookHarness[] = ["cursor", "codex", "gemini"];

type Json = Record<string, unknown>;

/** Native event name → FORGE event, per harness. */
export const NATIVE_EVENTS: Record<NativeHookHarness, Record<string, HookEventName>> = {
  cursor: {
    beforeShellExecution: "pre-tool",
    beforeReadFile: "pre-tool",
    afterFileEdit: "post-edit",
    beforeSubmitPrompt: "prompt-submit",
    stop: "stop",
    sessionStart: "session-start",
  },
  codex: {
    PreToolUse: "pre-tool",
    PostToolUse: "post-edit",
    UserPromptSubmit: "prompt-submit",
    Stop: "stop",
    SessionStart: "session-start",
    PreCompact: "pre-compact",
    SessionEnd: "session-end",
  },
  gemini: {
    BeforeTool: "pre-tool",
    AfterTool: "post-edit",
    BeforeAgent: "prompt-submit",
    AfterAgent: "stop",
    SessionStart: "session-start",
    PreCompress: "pre-compact",
    SessionEnd: "session-end",
  },
};

const str = (value: unknown): string | undefined => (typeof value === "string" && value.length ? value : undefined);
const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : {});

/** File paths touched by a Codex `apply_patch` call. */
export function patchFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) files.add((match[1] as string).trim());
  for (const match of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) files.add((match[1] as string).trim());
  return [...files];
}

interface Translated { inputs: HookInput[]; }

/** Native payload → one or more FORGE hook inputs (apply_patch can touch several files). */
export function translateInput(harness: NativeHookHarness, event: string, payload: Json): Translated {
  const base: HookInput = { forge_harness: harness };
  const cwd = str(payload.cwd) ?? (Array.isArray(payload.workspace_roots) ? str(payload.workspace_roots[0]) : undefined);
  if (cwd) base.cwd = cwd;
  const session = str(payload.session_id) ?? str(payload.conversation_id);
  if (session) base.session_id = session;
  const transcript = str(payload.transcript_path);
  if (transcript) base.transcript_path = transcript;
  if (typeof payload.prompt === "string") base.prompt = payload.prompt;
  const toolInput = obj(payload.tool_input);

  if (harness === "cursor") {
    switch (event) {
      case "beforeShellExecution": return { inputs: [{ ...base, tool_name: "Bash", tool_input: { command: str(payload.command) ?? "" } }] };
      case "beforeReadFile": return { inputs: [{ ...base, tool_name: "Read", tool_input: { file_path: str(payload.file_path) ?? "" } }] };
      case "afterFileEdit": return { inputs: [{ ...base, tool_name: "Write", tool_input: { file_path: str(payload.file_path) ?? "" } }] };
      case "stop": return { inputs: [{ ...base, stop_hook_active: typeof payload.loop_count === "number" && payload.loop_count > 0 }] };
      default: return { inputs: [base] };
    }
  }

  if (harness === "codex") {
    const tool = str(payload.tool_name) ?? "";
    if (event === "PreToolUse" || event === "PostToolUse") {
      if (tool === "apply_patch") {
        const files = patchFiles(str(toolInput.command) ?? str(toolInput.patch) ?? str(toolInput.input) ?? "");
        return { inputs: files.map(file => ({ ...base, tool_name: "Edit", tool_input: { file_path: file } })) };
      }
      if (tool === "Bash" || tool === "exec_command") return { inputs: event === "PreToolUse" ? [{ ...base, tool_name: "Bash", tool_input: { command: str(toolInput.command) ?? (Array.isArray(toolInput.command) ? (toolInput.command as unknown[]).join(" ") : "") } }] : [] };
      return { inputs: [] };
    }
    if (event === "Stop") return { inputs: [{ ...base, stop_hook_active: payload.stop_hook_active === true }] };
    if (event === "SessionEnd") return { inputs: [{ ...base, reason: str(payload.reason) ?? "other" }] };
    if (event === "SessionStart") return { inputs: [{ ...base, source: str(payload.source) ?? "startup" }] };
    return { inputs: [base] };
  }

  // gemini
  const tool = str(payload.tool_name) ?? "";
  if (event === "BeforeTool" || event === "AfterTool") {
    if (tool === "run_shell_command") return { inputs: event === "BeforeTool" ? [{ ...base, tool_name: "Bash", tool_input: { command: str(toolInput.command) ?? "" } }] : [] };
    const file = str(toolInput.file_path) ?? str(toolInput.absolute_path) ?? str(toolInput.path);
    if (!file) return { inputs: [] };
    if (tool === "read_file" || tool === "read_many_files") return { inputs: event === "BeforeTool" ? [{ ...base, tool_name: "Read", tool_input: { file_path: file } }] : [] };
    if (tool === "write_file" || tool === "replace" || tool === "edit") return { inputs: [{ ...base, tool_name: "Write", tool_input: { file_path: file } }] };
    return { inputs: [] };
  }
  if (event === "AfterAgent") return { inputs: [{ ...base, stop_hook_active: payload.stop_hook_active === true }] };
  if (event === "PreCompress") return { inputs: [{ ...base, trigger: str(payload.trigger) ?? "auto" }] };
  return { inputs: [base] };
}

interface Verdict { decision: "allow" | "ask" | "deny"; reason?: string; block?: string; context?: string }

/** Pull FORGE's decision out of a Claude-shaped hook output. */
function readVerdict(output: HookOutput): Verdict {
  const json = output.json ?? {};
  const specific = obj(json.hookSpecificOutput);
  const decision = str(specific.permissionDecision);
  const reason = str(specific.permissionDecisionReason);
  const context = str(specific.additionalContext);
  const block = json.decision === "block" ? str(json.reason) ?? "Blocked by FORGE." : undefined;
  return {
    decision: decision === "deny" || decision === "ask" ? decision : "allow",
    ...(reason ? { reason } : {}),
    ...(block ? { block } : {}),
    ...(context ? { context } : {}),
  };
}

function mergeVerdicts(verdicts: Verdict[]): Verdict {
  const rank = { allow: 0, ask: 1, deny: 2 } as const;
  const merged: Verdict = { decision: "allow" };
  const reasons: string[] = [];
  const blocks: string[] = [];
  const contexts: string[] = [];
  for (const v of verdicts) {
    if (rank[v.decision] > rank[merged.decision]) merged.decision = v.decision;
    if (v.reason) reasons.push(v.reason);
    if (v.block) blocks.push(v.block);
    if (v.context) contexts.push(v.context);
  }
  if (reasons.length) merged.reason = reasons.join("\n");
  if (blocks.length) merged.block = blocks.join("\n");
  if (contexts.length) merged.context = contexts.join("\n\n");
  return merged;
}

const askAsDeny = (reason: string | undefined) => `${reason ?? "FORGE Guard needs approval."} This tool cannot pause for approval, so FORGE blocked it: ask the user to confirm explicitly, then let them run it or allow it in .forge/harness-hooks.json.`;

/** FORGE verdict → native response JSON. */
export function translateOutput(harness: NativeHookHarness, event: string, verdict: Verdict): Json | undefined {
  if (harness === "cursor") {
    switch (event) {
      case "beforeShellExecution":
        return verdict.decision === "allow" ? { permission: "allow" } : { permission: verdict.decision, user_message: verdict.reason, agent_message: verdict.reason };
      case "beforeReadFile":
        return verdict.decision === "allow" ? { permission: "allow" } : { permission: "deny", user_message: askAsDeny(verdict.reason) };
      case "beforeSubmitPrompt":
        return verdict.block ? { continue: false, user_message: verdict.block } : { continue: true };
      case "stop":
        return verdict.block ? { followup_message: verdict.block } : {};
      case "sessionStart":
        return verdict.context ? { additional_context: verdict.context } : {};
      default:
        return {};
    }
  }
  if (harness === "codex") {
    switch (event) {
      case "PreToolUse":
        return verdict.decision === "allow" ? undefined : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: verdict.decision === "ask" ? askAsDeny(verdict.reason) : verdict.reason } };
      case "PostToolUse":
        return verdict.block ? { decision: "block", reason: verdict.block } : undefined;
      case "UserPromptSubmit":
      case "Stop":
        return verdict.block ? { decision: "block", reason: verdict.block } : undefined;
      case "SessionStart":
        return verdict.context ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: verdict.context } } : undefined;
      default:
        return undefined;
    }
  }
  switch (event) {
    case "BeforeTool":
      return verdict.decision === "allow" ? { decision: "allow" } : { decision: "deny", reason: verdict.decision === "ask" ? askAsDeny(verdict.reason) : verdict.reason };
    case "AfterTool":
    case "BeforeAgent":
    case "AfterAgent":
      return verdict.block ? { decision: "deny", reason: verdict.block } : {};
    case "SessionStart":
      return verdict.context ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: verdict.context } } : {};
    default:
      return {};
  }
}

/** Run a FORGE hook for a native harness event. Always returns exit code 0 with the native JSON (or none). */
export async function runNativeHook(harness: NativeHookHarness, event: string, rawInput: string, options: { cwd?: string; now?: () => Date } = {}): Promise<HookOutput> {
  const forgeEvent = NATIVE_EVENTS[harness]?.[event];
  if (!forgeEvent) return { exitCode: 0, ...(harness === "cursor" && /^before/.test(event) ? { json: { permission: "allow" } } : {}) };
  let payload: Json = {};
  try { payload = rawInput.trim() ? obj(JSON.parse(rawInput)) : {}; } catch { /* malformed input: fail open */ }
  const { inputs } = translateInput(harness, event, payload);
  const verdicts: Verdict[] = [];
  for (const input of inputs) {
    const output = await runHarnessHook(forgeEvent, JSON.stringify(input), options);
    verdicts.push(readVerdict(output));
  }
  const json = translateOutput(harness, event, mergeVerdicts(verdicts));
  return { exitCode: 0, ...(json ? { json } : {}) };
}

// ---------------------------------------------------------------------------
// Native hook configuration (used by `forge install --hooks`)
// ---------------------------------------------------------------------------

export const NATIVE_HOOK_FILES: Record<NativeHookHarness, string> = {
  cursor: ".cursor/hooks.json",
  codex: ".codex/hooks.json",
  gemini: ".gemini/settings.json",
};

interface NativeEntry { event: string; matcher?: string; command: string; timeout: number }

export function nativeHookEntries(harness: NativeHookHarness, hookCommand = "forge"): NativeEntry[] {
  const base = `${hookCommand.trim() || "forge"} hook --harness ${harness}`;
  if (harness === "cursor") {
    return [
      { event: "beforeShellExecution", command: `${base} beforeShellExecution`, timeout: 10 },
      { event: "beforeReadFile", command: `${base} beforeReadFile`, timeout: 10 },
      { event: "afterFileEdit", command: `${base} afterFileEdit`, timeout: 30 },
      { event: "beforeSubmitPrompt", command: `${base} beforeSubmitPrompt`, timeout: 5 },
      { event: "stop", command: `${base} stop`, timeout: 600 },
      { event: "sessionStart", command: `${base} sessionStart`, timeout: 15 },
    ];
  }
  if (harness === "codex") {
    return [
      { event: "PreToolUse", matcher: "Bash|apply_patch", command: `${base} PreToolUse`, timeout: 10 },
      { event: "PostToolUse", matcher: "apply_patch", command: `${base} PostToolUse`, timeout: 30 },
      { event: "UserPromptSubmit", command: `${base} UserPromptSubmit`, timeout: 5 },
      { event: "Stop", command: `${base} Stop`, timeout: 600 },
      { event: "SessionStart", command: `${base} SessionStart`, timeout: 15 },
      { event: "PreCompact", command: `${base} PreCompact`, timeout: 15 },
      { event: "SessionEnd", command: `${base} SessionEnd`, timeout: 3 },
    ];
  }
  // Gemini timeouts are milliseconds.
  return [
    { event: "BeforeTool", matcher: "run_shell_command|write_file|replace|read_file", command: `${base} BeforeTool`, timeout: 10_000 },
    { event: "AfterTool", matcher: "write_file|replace", command: `${base} AfterTool`, timeout: 30_000 },
    { event: "BeforeAgent", command: `${base} BeforeAgent`, timeout: 5_000 },
    { event: "AfterAgent", command: `${base} AfterAgent`, timeout: 600_000 },
    { event: "SessionStart", command: `${base} SessionStart`, timeout: 15_000 },
    { event: "PreCompress", command: `${base} PreCompress`, timeout: 15_000 },
    { event: "SessionEnd", command: `${base} SessionEnd`, timeout: 30_000 },
  ];
}

type Doc = Record<string, unknown>;

function hooksOf(doc: Doc): Record<string, unknown[]> {
  return doc.hooks && typeof doc.hooks === "object" && !Array.isArray(doc.hooks) ? doc.hooks as Record<string, unknown[]> : {};
}

/** Remove FORGE's commands from a native hook document, keeping everything else. */
export function removeNativeHooks(harness: NativeHookHarness, doc: Doc, commands: readonly string[]): Doc {
  const next = structuredClone(doc);
  const hooks = hooksOf(next);
  const ours = (value: unknown) => Boolean(value && typeof value === "object" && commands.includes(String((value as Doc).command)));
  for (const event of Object.keys(hooks)) {
    const list = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = harness === "cursor"
      ? list.filter(item => !ours(item))
      : list
        .map(group => (group && typeof group === "object" && Array.isArray((group as Doc).hooks) ? { ...(group as Doc), hooks: ((group as Doc).hooks as unknown[]).filter(item => !ours(item)) } : group))
        .filter(group => !(group && typeof group === "object" && Array.isArray((group as Doc).hooks) && ((group as Doc).hooks as unknown[]).length === 0));
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (next.hooks !== undefined) {
    if (Object.keys(hooks).length) next.hooks = hooks;
    else delete next.hooks;
  }
  if (harness === "cursor" && next.hooks === undefined && Object.keys(next).every(key => key === "version")) delete next.version;
  return next;
}

/** Add FORGE's entries idempotently, after removing any older FORGE entries. */
export function addNativeHooks(harness: NativeHookHarness, doc: Doc, entries: readonly NativeEntry[], previousCommands: readonly string[] = []): Doc {
  const next = removeNativeHooks(harness, doc, [...previousCommands, ...entries.map(e => e.command)]);
  const hooks = hooksOf(next);
  for (const entry of entries) {
    const list = Array.isArray(hooks[entry.event]) ? hooks[entry.event] as unknown[] : [];
    if (harness === "cursor") list.push({ command: entry.command, timeout: entry.timeout, ...(entry.matcher ? { matcher: entry.matcher } : {}) });
    else list.push({ ...(entry.matcher ? { matcher: entry.matcher } : {}), hooks: [{ ...(harness === "gemini" ? { name: `forge-${entry.event.toLowerCase()}` } : {}), type: "command", command: entry.command, timeout: entry.timeout, ...(harness === "gemini" ? { description: "FORGE Guard, verification and memory" } : { statusMessage: "FORGE" }) }] });
    hooks[entry.event] = list;
  }
  next.hooks = hooks;
  if (harness === "cursor" && typeof next.version !== "number") next.version = 1;
  return next;
}

export function nativeHookCommandsPresent(doc: Doc, commands: readonly string[]): string[] {
  const text = JSON.stringify(doc.hooks ?? {});
  return commands.filter(command => !text.includes(JSON.stringify(command)));
}

export async function readNativeHookFile(file: string): Promise<Doc | undefined> {
  try { const parsed: unknown = JSON.parse(await readFile(file, "utf8")); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Doc : undefined; } catch { return undefined; }
}
