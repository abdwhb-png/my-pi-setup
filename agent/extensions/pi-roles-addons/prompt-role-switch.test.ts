/**
 * Tests for prompt-role-switch pure helpers.
 *
 * The extension's handler (input event listener) delegates to
 * `writeRoleSwitchRequest` from pi-roles/protocol. The testable surface is:
 *   - `resolvePromptFile` — resolve a prompt name to its absolute path
 *     across Pi's prompt directories.
 */

import { describe, expect, it, mock, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { resolvePromptFile, loadPromptPathsFromSettings } from "./prompt-role-switch";

// ── Mock shared pi-roles bridge before dynamic import ──
let writeRoleSwitchRequestSpy = mock(() => {});
mock.module("../_shared/pi-roles", () => ({
  writeRoleSwitchRequest: writeRoleSwitchRequestSpy,
}));

// ---------------------------------------------------------------------------
// resolvePromptFile
// ---------------------------------------------------------------------------

describe("resolvePromptFile", () => {
  let tmpDir: string;
  let globalPrompts: string;
  let projectPrompts: string;
  let cwd: string;

  function setup() {
    tmpDir = mkdtempSync(join(tmpdir(), "prompt-role-switch-test-"));
    cwd = join(tmpDir, "workspace");
    globalPrompts = join(tmpDir, "agent", "prompts");
    projectPrompts = join(cwd, ".pi", "prompts");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(globalPrompts, { recursive: true });
    mkdirSync(projectPrompts, { recursive: true });
  }

  function teardown() {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  it("returns global path when only global has the file", () => {
    setup();
    writeFileSync(join(globalPrompts, "myplan.md"), "---\nrole: plan\n---\n# Plan");
    const result = resolvePromptFile("myplan", cwd, join(tmpDir, "agent"));
    expect(result).toBe(join(globalPrompts, "myplan.md"));
    teardown();
  });

  it("returns project path when only project has the file", () => {
    setup();
    writeFileSync(join(projectPrompts, "myplan.md"), "---\nrole: plan\n---\n# Plan");
    const result = resolvePromptFile("myplan", cwd, join(tmpDir, "agent"));
    expect(result).toBe(join(projectPrompts, "myplan.md"));
    teardown();
  });

  it("returns global path on collision (global wins — mirrors Pi's first-match semantics)", () => {
    setup();
    writeFileSync(join(globalPrompts, "myplan.md"), "---\nrole: plan\n---\n# Global");
    writeFileSync(join(projectPrompts, "myplan.md"), "---\nrole: ask\n---\n# Project");
    const result = resolvePromptFile("myplan", cwd, join(tmpDir, "agent"));
    expect(result).toBe(join(globalPrompts, "myplan.md"));
    teardown();
  });

  it("returns null when no file exists in any dir", () => {
    setup();
    const result = resolvePromptFile("nonexistent", cwd, join(tmpDir, "agent"));
    expect(result).toBeNull();
    teardown();
  });

  it("supports .mdx extension", () => {
    setup();
    writeFileSync(join(projectPrompts, "myplan.mdx"), "---\nrole: plan\n---\n# Plan");
    // Global also has a candidate dir but no file — project .mdx should match
    const result = resolvePromptFile("myplan", cwd, join(tmpDir, "agent"));
    expect(result).toBe(join(projectPrompts, "myplan.mdx"));
    teardown();
  });

  it("prefers .md over .mdx in the same dir (global first)", () => {
    setup();
    writeFileSync(join(globalPrompts, "myplan.md"), "---\nrole: plan\n---\n# MD");
    writeFileSync(join(globalPrompts, "myplan.mdx"), "---\nrole: ask\n---\n# MDX");
    const result = resolvePromptFile("myplan", cwd, join(tmpDir, "agent"));
    // .md is tried first within global dir
    expect(result).toBe(join(globalPrompts, "myplan.md"));
    teardown();
  });

  describe("with additionalPaths from prompts setting", () => {
    let tmpDir: string;
    let customFile: string;
    let customDir: string;
    let cwd: string;
    let agentDir: string;

    function setup() {
      tmpDir = mkdtempSync(join(tmpdir(), "prompt-role-switch-custom-"));
      cwd = join(tmpDir, "workspace");
      agentDir = join(tmpDir, "agent");
      customDir = join(tmpDir, "custom-prompts");
      mkdirSync(customDir, { recursive: true });
      mkdirSync(cwd, { recursive: true });
      mkdirSync(join(agentDir, "prompts"), { recursive: true });
      writeFileSync(join(customDir, "myplan.md"), "---\nrole: plan\n---\n# Plan");
      customFile = join(tmpDir, "myplan.md");
      writeFileSync(customFile, "---\nrole: plan\n---\n# Plan");
    }

    function teardown() {
      rmSync(tmpDir, { recursive: true, force: true });
    }

    it("finds prompt in a custom file path", () => {
      setup();
      const result = resolvePromptFile("myplan", cwd, agentDir, [customFile]);
      expect(result).toBe(customFile);
      teardown();
    });

    it("finds prompt in a custom directory path", () => {
      setup();
      const result = resolvePromptFile("myplan", cwd, agentDir, [customDir]);
      expect(result).toBe(join(customDir, "myplan.md"));
      teardown();
    });

    it("prefers standard dirs over custom paths", () => {
      setup();
      writeFileSync(join(agentDir, "prompts", "myplan.md"), "---\nrole: ask\n---\n# Global");
      const result = resolvePromptFile("myplan", cwd, agentDir, [customFile]);
      expect(result).toBe(join(agentDir, "prompts", "myplan.md"));
      teardown();
    });

    it("returns null when prompt not found in any path", () => {
      setup();
      const result = resolvePromptFile("nonexistent", cwd, agentDir, [customDir, customFile]);
      expect(result).toBeNull();
      teardown();
    });
  });
});

// ---------------------------------------------------------------------------
// loadPromptPathsFromSettings
// ---------------------------------------------------------------------------

describe("loadPromptPathsFromSettings", () => {
  let tmpDir: string;
  let agentDir: string;
  let cwd: string;
  let globalSettingsDir: string;
  let projectSettingsDir: string;

  function setup() {
    tmpDir = mkdtempSync(join(tmpdir(), "prompt-role-switch-settings-"));
    agentDir = join(tmpDir, "agent");
    cwd = join(tmpDir, "workspace");
    globalSettingsDir = agentDir;
    projectSettingsDir = join(cwd, ".pi");
    mkdirSync(globalSettingsDir, { recursive: true });
    mkdirSync(projectSettingsDir, { recursive: true });
  }

  function teardown() {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  it("returns empty array when no settings files exist", () => {
    setup();
    const result = loadPromptPathsFromSettings(agentDir, cwd);
    expect(result).toEqual([]);
    teardown();
  });

  it("reads prompts array from global settings.json", () => {
    setup();
    writeFileSync(
      join(globalSettingsDir, "settings.json"),
      JSON.stringify({ prompts: ["/custom/path/myplan.md"] }),
    );
    const result = loadPromptPathsFromSettings(agentDir, cwd);
    expect(result).toEqual(["/custom/path/myplan.md"]);
    teardown();
  });

  it("reads prompts array from project settings.json", () => {
    setup();
    writeFileSync(
      join(projectSettingsDir, "settings.json"),
      JSON.stringify({ prompts: ["/project/prompt.md"] }),
    );
    const result = loadPromptPathsFromSettings(agentDir, cwd);
    expect(result).toEqual(["/project/prompt.md"]);
    teardown();
  });

  it("merges global and project paths (global first)", () => {
    setup();
    writeFileSync(
      join(globalSettingsDir, "settings.json"),
      JSON.stringify({ prompts: ["/global/a.md"] }),
    );
    writeFileSync(
      join(projectSettingsDir, "settings.json"),
      JSON.stringify({ prompts: ["/project/b.md"] }),
    );
    const result = loadPromptPathsFromSettings(agentDir, cwd);
    expect(result).toEqual(["/global/a.md", "/project/b.md"]);
    teardown();
  });

  it("gracefully handles malformed settings.json", () => {
    setup();
    writeFileSync(join(globalSettingsDir, "settings.json"), "not valid json");
    const result = loadPromptPathsFromSettings(agentDir, cwd);
    expect(result).toEqual([]);
    teardown();
  });

  it("ignores settings.json without prompts key", () => {
    setup();
    writeFileSync(
      join(globalSettingsDir, "settings.json"),
      JSON.stringify({ otherKey: ["/path.md"] }),
    );
    const result = loadPromptPathsFromSettings(agentDir, cwd);
    expect(result).toEqual([]);
    teardown();
  });
});
// ---------------------------------------------------------------------------

describe("promptRoleSwitch handler", () => {
  let tmpDir: string;
  let projectPrompts: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "prompt-role-switch-handler-"));
    // Use project prompt dir (cwd/.pi/prompts/) which resolvePromptFile checks
    // and which the handler can resolve via ctx.cwd
    projectPrompts = join(tmpDir, ".pi", "prompts");
    mkdirSync(projectPrompts, { recursive: true });
    // Create a prompt file with role: ask in the project prompts dir
    writeFileSync(
      join(projectPrompts, "myplan.md"),
      "---\ndescription: Test plan\nrole: ask\n---\n\n# Plan body",
    );
  });

  it("calls writeRoleSwitchRequest when /prompt-name is used (event.text)", async () => {
    writeRoleSwitchRequestSpy.mockClear();

    // Dynamic import after mock.module() — bun mock.module is not hoisted
    const { default: promptRoleSwitch } = await import("./prompt-role-switch");

    const handlers: Record<string, Function> = {};
    const fakePi = {
      on: mock((event: string, handler: Function) => {
        handlers[event] = handler;
      }),
      appendEntry: mock(() => {}),
    };

    promptRoleSwitch(fakePi as any);

    // Verify "input" handler was registered
    expect(handlers["input"]).toBeDefined();

    // Fire the handler with event.text set to "/myplan"
    await handlers["input"]!(
      {
        type: "input",
        text: "/myplan",
        source: "interactive",
      },
      { cwd: tmpDir },
    );

    // Assert writeRoleSwitchRequest was called with correct args
    expect(writeRoleSwitchRequestSpy).toHaveBeenCalledTimes(1);
    expect(writeRoleSwitchRequestSpy).toHaveBeenCalledWith(
      fakePi,
      { targetRole: "ask", reason: "prompt:myplan" },
    );
  });

  it("does NOT call writeRoleSwitchRequest when input has no slash command", async () => {
    writeRoleSwitchRequestSpy.mockClear();
    const { default: promptRoleSwitch } = await import("./prompt-role-switch");

    const handlers: Record<string, Function> = {};
    const fakePi = {
      on: mock((event: string, handler: Function) => {
        handlers[event] = handler;
      }),
    };

    promptRoleSwitch(fakePi as any);

    await handlers["input"]!(
      { type: "input", text: "just a regular message", source: "interactive" },
      { cwd: tmpDir },
    );

    expect(writeRoleSwitchRequestSpy).toHaveBeenCalledTimes(0);
  });

  it("does NOT call writeRoleSwitchRequest when prompt file is not found", async () => {
    writeRoleSwitchRequestSpy.mockClear();
    const { default: promptRoleSwitch } = await import("./prompt-role-switch");

    const handlers: Record<string, Function> = {};
    const fakePi = {
      on: mock((event: string, handler: Function) => {
        handlers[event] = handler;
      }),
    };

    promptRoleSwitch(fakePi as any);

    await handlers["input"]!(
      { type: "input", text: "/nonexistent", source: "interactive" },
      { cwd: tmpDir },
    );

    expect(writeRoleSwitchRequestSpy).toHaveBeenCalledTimes(0);
  });

  it("does NOT call writeRoleSwitchRequest when prompt has no role frontmatter", async () => {
    // Create a prompt without role frontmatter in project dir
    writeFileSync(
      join(projectPrompts, "norole.md"),
      "---\ndescription: No role field\n---\n\n# No role",
    );

    writeRoleSwitchRequestSpy.mockClear();
    const { default: promptRoleSwitch } = await import("./prompt-role-switch");

    const handlers: Record<string, Function> = {};
    const fakePi = {
      on: mock((event: string, handler: Function) => {
        handlers[event] = handler;
      }),
    };

    promptRoleSwitch(fakePi as any);

    await handlers["input"]!(
      { type: "input", text: "/norole", source: "interactive" },
      { cwd: tmpDir },
    );

    expect(writeRoleSwitchRequestSpy).toHaveBeenCalledTimes(0);
  });

  it("uses event.text (not event.input) — validates the fix for the bug", async () => {
    // This is the regression test for the root cause:
    // event.input was undefined, causing silent no-op.
    // event.text is the correct InputEvent field in Pi v0.80.2.
    writeRoleSwitchRequestSpy.mockClear();
    const { default: promptRoleSwitch } = await import("./prompt-role-switch");

    const handlers: Record<string, Function> = {};
    const fakePi = {
      on: mock((event: string, handler: Function) => {
        handlers[event] = handler;
      }),
    };

    promptRoleSwitch(fakePi as any);

    // Fire with ONLY event.text (no event.input) — the old buggy code
    // would fail silently here because event.input was undefined.
    await handlers["input"]!(
      {
        type: "input",
        text: "/myplan",
        // event.input is intentionally absent — this is the bug scenario
        source: "interactive",
      } as any,
      { cwd: tmpDir },
    );

    expect(writeRoleSwitchRequestSpy).toHaveBeenCalledTimes(1);
    expect(writeRoleSwitchRequestSpy).toHaveBeenCalledWith(
      fakePi,
      { targetRole: "ask", reason: "prompt:myplan" },
    );
  });
});