import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("pi-wrapper-lib", () => {
  it("detects package mutation commands", async () => {
    const mod = await import("./pi-wrapper-lib.ts");
    expect(mod.isPackageMutationCommand(["install", "x"])).toBe(true);
    expect(mod.isPackageMutationCommand(["remove", "x"])).toBe(true);
    expect(mod.isPackageMutationCommand(["uninstall", "x"])).toBe(true);
    expect(mod.isPackageMutationCommand(["update"])).toBe(true);
    expect(mod.isPackageMutationCommand(["list"])).toBe(false);
    expect(mod.isPackageMutationCommand(["--role", "ask"])).toBe(false);
  });

  it("runPackageFinalizer pins tool-groups last via real settings", async () => {
    const mod = await import("./pi-wrapper-lib.ts");
    const agentDir = mkdtempSync(join(tmpdir(), "pi-fw-agent-"));
    const cwd = mkdtempSync(join(tmpdir(), "pi-fw-cwd-"));

    // Create minimal settings with tool-groups not last.
    mkdirSync(join(agentDir, "extensions", "tool-groups"), { recursive: true });
    mkdirSync(join(agentDir, "extensions", "other-pkg"), { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        packages: ["./extensions/tool-groups", "./extensions/other-pkg"],
      }),
    );

    await mod.runPackageFinalizer(cwd, { agentDir, quiet: true });

    const raw = readFileSync(join(agentDir, "settings.json"), "utf-8");
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(raw);
    } catch {
      /* test-wrote valid JSON; parse failure is a test bug */
    }
    expect(settings.packages).toEqual([
      "./extensions/other-pkg",
      "./extensions/tool-groups",
    ]);
    expect(mod.isToolGroupsPackageConfigured(cwd, agentDir)).toBe(true);
  });

  it("defers aliased --tools filtering until the extension has the full registry", async () => {
    const mod = await import("./pi-wrapper-lib.ts");
    expect(mod.prepareToolGroupArgs(["--tools", "@review,write", "-p", "task"])).toEqual({
      args: ["-p", "task"],
      requestedTools: ["@review", "write"],
    });
  });

  it("supports the short -t tool option", async () => {
    const mod = await import("./pi-wrapper-lib.ts");
    expect(mod.prepareToolGroupArgs(["-t", "@inspect,edit"])).toEqual({
      args: [],
      requestedTools: ["@inspect", "edit"],
    });
  });

  it("leaves concrete-only tool filters unchanged", async () => {
    const mod = await import("./pi-wrapper-lib.ts");
    const args = ["--tools", "read,grep", "-p", "task"];
    expect(mod.prepareToolGroupArgs(args)).toEqual({ args, requestedTools: undefined });
  });

  it("does not defer aliases when extensions are disabled", async () => {
    const mod = await import("./pi-wrapper-lib.ts");
    const args = ["--no-extensions", "--tools", "@inspect"];
    expect(mod.prepareToolGroupArgs(args)).toEqual({ args, requestedTools: undefined });
  });

  it("does not defer aliases when the tool-groups package is unavailable", async () => {
    const mod = await import("./pi-wrapper-lib.ts");
    const args = ["--tools", "@inspect"];
    expect(mod.prepareToolGroupArgs(args, false)).toEqual({ args, requestedTools: undefined });
  });

  it("runRealPi forwards deferred tools through the private environment", async () => {
    const mod = await import("./pi-wrapper-lib.ts");
    const cwd = mkdtempSync(join(tmpdir(), "pi-fw-spawn-"));
    const output = join(cwd, "capture.json");
    const executable = join(cwd, "capture.ts");
    writeFileSync(
      executable,
      `#!/usr/bin/env bun\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(output)}, JSON.stringify({ args: process.argv.slice(2), requested: process.env.PI_TOOL_GROUPS_REQUESTED_TOOLS }));\n`,
    );
    chmodSync(executable, 0o755);

    expect(mod.runRealPi(executable, ["-p", "task"], cwd, ["@inspect", "write"])).toBe(0);
    let captured: unknown;
    try {
      captured = JSON.parse(readFileSync(output, "utf-8"));
    } catch (cause) {
      throw new Error("capture process wrote invalid JSON", { cause });
    }
    expect(captured).toEqual({
      args: ["-p", "task"],
      requested: JSON.stringify(["@inspect", "write"]),
    });
  });
});
