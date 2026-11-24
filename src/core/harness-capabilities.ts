/**
 * Versioned capability manifest for supported agent harnesses.
 *
 * These declarations describe FORGE's current renderer and hook integration,
 * not every feature the upstream harness may support. "shared" means FORGE
 * installs common Markdown/instructions rather than a native harness feature.
 */

import type { HarnessTarget } from "./harness-installer.js";

export const HARNESS_CAPABILITY_SCHEMA_VERSION = 1 as const;

export type CapabilitySupport = "native" | "shared" | "unsupported";

export interface HarnessCapability {
  target: HarnessTarget;
  displayName: string;
  schemaVersion: typeof HARNESS_CAPABILITY_SCHEMA_VERSION;
  capabilities: {
    agents: CapabilitySupport;
    skills: CapabilitySupport;
    commands: CapabilitySupport;
    rules: CapabilitySupport;
    hooks: CapabilitySupport;
  };
  notes: string[];
}

export const HARNESS_CAPABILITIES: readonly HarnessCapability[] = [
  {
    target: "claude",
    displayName: "Claude Code",
    schemaVersion: HARNESS_CAPABILITY_SCHEMA_VERSION,
    capabilities: { agents: "native", skills: "native", commands: "native", rules: "native", hooks: "native" },
    notes: ["FORGE can merge its runtime hooks into Claude Code settings when --hooks is enabled."],
  },
  {
    target: "cursor",
    displayName: "Cursor",
    schemaVersion: HARNESS_CAPABILITY_SCHEMA_VERSION,
    capabilities: { agents: "shared", skills: "shared", commands: "native", rules: "native", hooks: "unsupported" },
    notes: ["Agents and skills are rendered as Cursor rules; they are not installed as native subagents or skill packages.", "FORGE runtime hooks are not installed for this target."],
  },
  {
    target: "codex",
    displayName: "Codex",
    schemaVersion: HARNESS_CAPABILITY_SCHEMA_VERSION,
    capabilities: { agents: "shared", skills: "shared", commands: "shared", rules: "shared", hooks: "unsupported" },
    notes: ["Shared project instructions are referenced from AGENTS.md; skills use the shared .agents/skills layout.", "FORGE runtime hooks are not installed for this target."],
  },
  {
    target: "opencode",
    displayName: "OpenCode",
    schemaVersion: HARNESS_CAPABILITY_SCHEMA_VERSION,
    capabilities: { agents: "native", skills: "shared", commands: "native", rules: "shared", hooks: "unsupported" },
    notes: ["Rules are exposed through shared FORGE Markdown and project instructions.", "FORGE runtime hooks are not installed for this target."],
  },
  {
    target: "gemini",
    displayName: "Gemini CLI",
    schemaVersion: HARNESS_CAPABILITY_SCHEMA_VERSION,
    capabilities: { agents: "shared", skills: "shared", commands: "native", rules: "shared", hooks: "unsupported" },
    notes: ["Shared instructions are referenced from GEMINI.md; skills use the shared .agents/skills layout.", "FORGE runtime hooks are not installed for this target."],
  },
  {
    target: "copilot",
    displayName: "GitHub Copilot",
    schemaVersion: HARNESS_CAPABILITY_SCHEMA_VERSION,
    capabilities: { agents: "native", skills: "shared", commands: "native", rules: "native", hooks: "unsupported" },
    notes: ["Rules become .github/instructions/*.instructions.md with applyTo globs; workflows become .github/prompts/*.prompt.md; agents become .github/agents/*.agent.md.", "A managed block in .github/copilot-instructions.md indexes the shared harness.", "Opt-in target: install with --target copilot, or FORGE adds it when .github/copilot-instructions.md exists."],
  },
  {
    target: "windsurf",
    displayName: "Windsurf",
    schemaVersion: HARNESS_CAPABILITY_SCHEMA_VERSION,
    capabilities: { agents: "shared", skills: "shared", commands: "native", rules: "native", hooks: "unsupported" },
    notes: ["Rules become .windsurf/rules with always_on, glob or model_decision triggers; workflows become .windsurf/workflows.", "Agents and skills are indexed from AGENTS.md.", "Opt-in target: FORGE adds it when .windsurf/ exists."],
  },
  {
    target: "kiro",
    displayName: "Kiro",
    schemaVersion: HARNESS_CAPABILITY_SCHEMA_VERSION,
    capabilities: { agents: "shared", skills: "shared", commands: "shared", rules: "native", hooks: "unsupported" },
    notes: ["Rules become .kiro/steering files with always, fileMatch or manual inclusion.", "Agents and workflows become manual steering files you pull in with #forge-<kind>-<id>.", "Opt-in target: FORGE adds it when .kiro/ exists."],
  },
  {
    target: "cline",
    displayName: "Cline",
    schemaVersion: HARNESS_CAPABILITY_SCHEMA_VERSION,
    capabilities: { agents: "shared", skills: "shared", commands: "native", rules: "native", hooks: "unsupported" },
    notes: ["Rules become .clinerules/*.md (with paths frontmatter when scoped); workflows become .clinerules/workflows.", "A managed .clinerules/forge-harness.md indexes agents and skills.", "Opt-in target: FORGE adds it when .clinerules exists."],
  },
  {
    target: "zed",
    displayName: "Zed",
    schemaVersion: HARNESS_CAPABILITY_SCHEMA_VERSION,
    capabilities: { agents: "shared", skills: "shared", commands: "shared", rules: "shared", hooks: "unsupported" },
    notes: ["Zed's agent reads AGENTS.md, so FORGE installs the shared harness and its managed AGENTS.md block.", "If the project has a .rules file, Zed prefers it over AGENTS.md; add a pointer to AGENTS.md there.", "Opt-in target: FORGE adds it when .zed/ or .rules exists."],
  },
] as const;

export function getHarnessCapability(target: HarnessTarget): HarnessCapability {
  const capability = HARNESS_CAPABILITIES.find(item => item.target === target);
  if (!capability) throw new Error(`No capability manifest exists for harness "${target}".`);
  return capability;
}

export function listHarnessCapabilities(): HarnessCapability[] {
  return HARNESS_CAPABILITIES.map(item => ({
    ...item,
    capabilities: { ...item.capabilities },
    notes: [...item.notes],
  }));
}

/** Human-readable capability matrix for `forge harnesses`. */
export function formatHarnessCapabilities(): string {
  const rows = listHarnessCapabilities();
  const columns = ["agents", "skills", "commands", "rules", "hooks"] as const;
  const lines = [
    "FORGE harness capability matrix (native = native format; shared = shared Markdown; unsupported = not integrated)",
    "",
    "Harness".padEnd(16) + columns.map(column => column.padEnd(13)).join(""),
  ];
  for (const item of rows) {
    lines.push(item.displayName.padEnd(16) + columns.map(column => item.capabilities[column].padEnd(13)).join(""));
  }
  for (const item of rows) {
    lines.push("", item.displayName + ":");
    for (const note of item.notes) lines.push("  - " + note);
  }
  lines.push("", "Manifest schema: " + HARNESS_CAPABILITY_SCHEMA_VERSION);
  return lines.join("\n");
}
