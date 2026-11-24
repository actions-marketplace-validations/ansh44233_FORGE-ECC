import { describe, expect, it } from "vitest";
import {
  HARNESS_CAPABILITIES,
  HARNESS_CAPABILITY_SCHEMA_VERSION,
  getHarnessCapability,
  listHarnessCapabilities,
  formatHarnessCapabilities,
} from "../src/core/harness-capabilities.js";

describe("harness capability manifest", () => {
  it("has one versioned entry for every supported installer target", () => {
    expect(HARNESS_CAPABILITIES.map(item => item.target).sort()).toEqual(
      ["claude", "cline", "codex", "copilot", "cursor", "gemini", "kiro", "opencode", "windsurf", "zed"].sort(),
    );
    for (const item of HARNESS_CAPABILITIES) {
      expect(item.schemaVersion).toBe(HARNESS_CAPABILITY_SCHEMA_VERSION);
      expect(Object.keys(item.capabilities).sort()).toEqual(
        ["agents", "commands", "hooks", "rules", "skills"].sort(),
      );
      for (const support of Object.values(item.capabilities)) {
        expect(["native", "shared", "unsupported"]).toContain(support);
      }
    }
  });

  it("does not overstate the current hook integration", () => {
    for (const target of ["claude", "cursor", "codex", "gemini"] as const) expect(getHarnessCapability(target).capabilities.hooks).toBe("native");
    for (const target of ["opencode", "copilot", "windsurf", "kiro", "cline", "zed"] as const) {
      expect(getHarnessCapability(target).capabilities.hooks).toBe("unsupported");
    }
  });

  it("returns defensive copies for consumer mutation", () => {
    const listed = listHarnessCapabilities();
    listed[0]!.notes.push("consumer mutation");
    expect(HARNESS_CAPABILITIES[0]!.notes).not.toContain("consumer mutation");
  });
  it("formats a readable capability matrix for CLI consumers", () => {
    const output = formatHarnessCapabilities();
    expect(output).toContain("native = native format");
    expect(output).toContain("Claude Code");
    expect(output).toContain("unsupported");
    expect(output).toContain("Manifest schema: 1");
  });
});
