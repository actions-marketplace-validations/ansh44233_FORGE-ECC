import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("npm package release metadata", () => {
  it("exposes the compiled FORGE CLI and includes release documentation", async () => {
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as {
      version?: string;
      bin?: Record<string, string>;
      files?: string[];
      engines?: { node?: string };
      scripts?: Record<string, string>;
      repository?: { url?: string };
    };

    expect(packageJson.version).toBe("3.0.0");
    expect(packageJson.bin?.forge).toBe("./dist/cli.js");
    expect(packageJson.files).toEqual(expect.arrayContaining(["dist", "README.md", "CHANGELOG.md", "LICENSE", "SECURITY.md"]));
    expect(packageJson.engines?.node).toBe(">=22");
    expect(packageJson.scripts?.prepack).toContain("npm run build");
    expect(packageJson.scripts?.prepublishOnly).toContain("npm run typecheck");
    expect(packageJson.scripts?.prepublishOnly).toContain("npm test");
    expect(packageJson.repository?.url).toContain("FORGE-ECC");
    const changelog = await readFile(path.join(process.cwd(), "CHANGELOG.md"), "utf8");
    expect(changelog).toContain("## 3.0.0 — Learn, loop and prove");
    expect(changelog).toContain("## 2.0.1 — Install and stability fixes");
    expect(changelog).toContain("## 2.0.0 — The verified agent harness");
    expect(changelog).toContain("## 1.0.0 — First major release");
    const cli = await readFile(path.join(process.cwd(), "src", "cli.ts"), "utf8");
    expect(cli).toContain(`const VERSION = "${packageJson.version}";`);
    expect(packageJson.files).toContain("catalog");
  });
});
