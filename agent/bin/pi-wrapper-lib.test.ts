import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function createActiveRuntime(homeDir: string): string {
  const runtimeRoot = join(homeDir, ".pi", "runtime", "pi-core");
  const releaseRoot = join(runtimeRoot, "releases", "release-a");
  const packageRoot = join(releaseRoot, "package");
  const executable = join(packageRoot, "dist", "pi");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
  writeFileSync(executable, "#!/usr/bin/env bun\n");
  chmodSync(executable, 0o755);
  writeFileSync(
    join(releaseRoot, "runtime-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      releaseId: "release-a",
      createdAt: "2026-09-21T00:00:00.000Z",
      source: { repository: "/src/pi-core", commit: "abc123", dirty: false },
      executable: "package/dist/pi",
      packageRoot: "package",
      packages: [],
    }),
  );
  symlinkSync(releaseRoot, join(runtimeRoot, "current"));
  return executable;
}

describe("pi-wrapper-lib", () => {
  it("resolves only the promoted runtime unless explicitly overridden", async () => {
    const mod = await import("./pi-wrapper-lib.ts");
    const homeDir = mkdtempSync(join(tmpdir(), "pi-fw-home-"));
    const executable = createActiveRuntime(homeDir);

    expect(mod.resolveRealPiPath(undefined, homeDir)).toBe(executable);
    expect(mod.resolveRealPiPath("/opt/custom/pi", homeDir)).toBe("/opt/custom/pi");
  });

  it("finds the owning Pi package for a compiled launcher", async () => {
    const mod = await import("./pi-wrapper-lib.ts");
    const root = mkdtempSync(join(tmpdir(), "pi-fw-package-root-"));
    const binary = join(root, "dist", "pi");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent" }),
    );
    writeFileSync(binary, "#!/usr/bin/env bun\n");

    expect(mod.findPiPackageRootFromExecutable(binary)).toBe(root);
  });

  it("prefers the outer coding-agent package over a nested dist manifest", async () => {
    const mod = await import("./pi-wrapper-lib.ts");
    const root = mkdtempSync(join(tmpdir(), "pi-fw-outer-root-"));
    const binary = join(root, "dist", "pi");
    mkdirSync(join(root, "dist"), { recursive: true });
    const manifest = JSON.stringify({ name: "@earendil-works/pi-coding-agent" });
    writeFileSync(join(root, "package.json"), manifest);
    writeFileSync(join(root, "dist", "package.json"), manifest);
    writeFileSync(binary, "#!/usr/bin/env bun\n");

    expect(mod.findPiPackageRootFromExecutable(binary)).toBe(root);
  });

  it("blocks self-update forms but allows explicit non-core updates", async () => {
    const mod = await import("./pi-wrapper-lib.ts");
    for (const args of [
      ["update"],
      ["update", "self"],
      ["update", "pi"],
      ["update", "--self"],
      ["update", "--force"],
      ["update", "--all"],
    ]) {
      expect(mod.classifyUpdateCommand(args).allowed).toBe(false);
    }
    for (const args of [
      ["update", "--extensions"],
      ["update", "github:owner/extension"],
      ["update", "--extension", "github:owner/extension"],
      ["update", "--models"],
      ["update", "--help"],
      ["list"],
    ]) {
      expect(mod.classifyUpdateCommand(args)).toEqual({ allowed: true });
    }
  });

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

  it("leaves concrete-only CLI args unchanged but forwards their policy ceiling", async () => {
    const mod = await import("./pi-wrapper-lib.ts");
    const args = ["--tools", "read,grep", "-p", "task"];
    expect(mod.prepareToolGroupArgs(args)).toEqual({ args, requestedTools: ["read", "grep"] });
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

  it("runs the managed package's Bun entry instead of its Node bundle", async () => {
    const mod = await import("./pi-wrapper-lib.ts");
    const cwd = mkdtempSync(join(tmpdir(), "pi-fw-bun-entry-"));
    const packageRoot = join(cwd, "pi-package");
    const bundle = join(packageRoot, "dist", "bundle", "cli.js");
    const bunEntry = join(packageRoot, "dist", "bun", "cli.js");
    const output = join(cwd, "capture.json");
    mkdirSync(join(packageRoot, "dist", "bundle"), { recursive: true });
    mkdirSync(join(packageRoot, "dist", "bun"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
    writeFileSync(bundle, "#!/usr/bin/env node\nprocess.exit(42);\n");
    writeFileSync(
      bunEntry,
      `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(output)}, JSON.stringify({ bun: process.versions.bun, args: process.argv.slice(2) }));\n`,
    );
    chmodSync(bundle, 0o755);

    expect(mod.runRealPi(bundle, ["--version"], cwd)).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf-8"))).toEqual({
      bun: process.versions.bun,
      args: ["--version"],
    });
  });

  it("blocks self-update before invoking real Pi", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-fw-update-block-"));
    const marker = join(cwd, "invoked");
    const executable = join(cwd, "capture.ts");
    const wrapper = resolve(import.meta.dir, "../../bin/pi");
    writeFileSync(
      executable,
      `#!/usr/bin/env bun\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "invoked");\n`,
    );
    chmodSync(executable, 0o755);

    const result = spawnSync(wrapper, ["update"], {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, PI_PACKAGE_FINALIZER_ACTIVE: "1", PI_REAL_BIN: executable },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Pi self-update is disabled");
    expect(existsSync(marker)).toBe(false);
  });

  it("fails closed with deploy guidance when no release is active", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-fw-no-runtime-cwd-"));
    const homeDir = mkdtempSync(join(tmpdir(), "pi-fw-no-runtime-home-"));
    const wrapper = resolve(import.meta.dir, "../../bin/pi");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      PI_PACKAGE_FINALIZER_ACTIVE: "1",
    };
    delete env.PI_REAL_BIN;

    const result = spawnSync(wrapper, ["--version"], { cwd, encoding: "utf-8", env });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Run: pi-fork deploy");
  });

  it("makes subagents relaunch through the wrapper", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-fw-subagent-"));
    const output = join(cwd, "capture.json");
    const executable = join(cwd, "capture.ts");
    const wrapper = resolve(import.meta.dir, "../../bin/pi");
    writeFileSync(
      executable,
      `#!/usr/bin/env bun\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(output)}, JSON.stringify({ subagentPiBinary: process.env.PI_SUBAGENT_PI_BINARY }));\n`,
    );
    chmodSync(executable, 0o755);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PI_PACKAGE_FINALIZER_ACTIVE: "1",
      PI_REAL_BIN: executable,
    };
    delete env.PI_SUBAGENT_PI_BINARY;

    const result = spawnSync(wrapper, ["-p", "task"], {
      cwd,
      encoding: "utf-8",
      env,
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf-8"))).toEqual({
      subagentPiBinary: wrapper,
    });
  });
});
