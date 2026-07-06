import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { loadExtensionConfig } from "./config-loader.ts";

// ── Helpers ────────────────────────────────────────────

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

// ── normalize: Record<string, boolean> ─────────────────

interface TestConfig {
  tools: Record<string, boolean>;
  maxRetries?: number;
}

const DEFAULT_TEST_CONFIG: TestConfig = {
  tools: {},
};

function normalizeTestConfig(raw: unknown): Partial<TestConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const tools: Record<string, boolean> = {};
  if (obj.tools && typeof obj.tools === "object" && !Array.isArray(obj.tools)) {
    for (const [key, value] of Object.entries(obj.tools as Record<string, unknown>)) {
      if (typeof value === "boolean") tools[key] = value;
    }
  }
  const result: Partial<TestConfig> = { tools };
  if (typeof obj.maxRetries === "number") result.maxRetries = obj.maxRetries;
  return result;
}

function deepMerge(base: TestConfig, overlay: Partial<TestConfig>): TestConfig {
  return {
    tools: { ...base.tools, ...(overlay.tools ?? {}) },
    maxRetries: overlay.maxRetries ?? base.maxRetries,
  };
}

// ── Tests ──────────────────────────────────────────────

describe("loadExtensionConfig", () => {
  let agentDir: string;
  let cwd: string;

  beforeEach(() => {
    agentDir = makeTempDir("pi-agent-");
    cwd = makeTempDir("pi-cwd-");
  });

  afterEach(() => {
    try { rmSync(agentDir, { recursive: true }); } catch {}
    try { rmSync(cwd, { recursive: true }); } catch {}
  });

  // ── Defaults only ────────────────────────────────────

  it("returns defaults when no sources produce results", () => {
    const config = loadExtensionConfig(cwd, {
      defaults: DEFAULT_TEST_CONFIG,
      normalize: normalizeTestConfig,
      sources: [{ legacyFilename: "nonexistent.json" }],
      agentDir,
    });
    expect(config).toEqual(DEFAULT_TEST_CONFIG);
  });

  it("returns defaults when sources array is empty", () => {
    const config = loadExtensionConfig(cwd, {
      defaults: DEFAULT_TEST_CONFIG,
      normalize: normalizeTestConfig,
      sources: [],
      agentDir,
    });
    expect(config).toEqual(DEFAULT_TEST_CONFIG);
  });

  // ── Legacy file loading ──────────────────────────────

  it("loads global legacy file", () => {
    writeJson(join(agentDir, "my-ext.json"), {
      tools: { write: true, edit: false },
    });

    const config = loadExtensionConfig(cwd, {
      defaults: DEFAULT_TEST_CONFIG,
      normalize: normalizeTestConfig,
      sources: [{ legacyFilename: "my-ext.json" }],
      agentDir,
    });

    expect(config.tools).toEqual({ write: true, edit: false });
    expect(config.maxRetries).toBeUndefined();
  });

  it("loads project-local legacy file and merges over global (deep merge)", () => {
    writeJson(join(agentDir, "my-ext.json"), {
      tools: { write: true, edit: false },
    });
    writeJson(join(cwd, ".pi", "my-ext.json"), {
      tools: { edit: true, grep: true },
    });

    const config = loadExtensionConfig(cwd, {
      defaults: DEFAULT_TEST_CONFIG,
      normalize: normalizeTestConfig,
      sources: [{ legacyFilename: "my-ext.json" }],
      merge: deepMerge,
      agentDir,
    });

    expect(config.tools).toEqual({ write: true, edit: true, grep: true });
  });

  it("project-local legacy disabled via projectLocal: false", () => {
    writeJson(join(agentDir, "my-ext.json"), {
      tools: { write: true },
    });
    writeJson(join(cwd, ".pi", "my-ext.json"), {
      tools: { edit: true },
    });

    const config = loadExtensionConfig(cwd, {
      defaults: DEFAULT_TEST_CONFIG,
      normalize: normalizeTestConfig,
      sources: [{ legacyFilename: "my-ext.json", projectLocal: false }],
      agentDir,
    });

    expect(config.tools).toEqual({ write: true });
  });

  it("returns defaults for malformed JSON in legacy file", () => {
    writeFileSync(join(agentDir, "bad.json"), "not json {{{");

    const config = loadExtensionConfig(cwd, {
      defaults: DEFAULT_TEST_CONFIG,
      normalize: normalizeTestConfig,
      sources: [{ legacyFilename: "bad.json" }],
      agentDir,
    });

    expect(config).toEqual(DEFAULT_TEST_CONFIG);
  });

  it("returns defaults for nonexistent legacy file", () => {
    const config = loadExtensionConfig(cwd, {
      defaults: DEFAULT_TEST_CONFIG,
      normalize: normalizeTestConfig,
      sources: [{ legacyFilename: "no-such-file.json" }],
      agentDir,
    });

    expect(config).toEqual(DEFAULT_TEST_CONFIG);
  });

  // ── SettingsManager loading ──────────────────────────

  it("loads from SettingsManager (in-memory)", () => {
    const sm = SettingsManager.inMemory({
      myExtension: { tools: { write: true, bash: false } },
    } as any);

    const config = loadExtensionConfig(cwd, {
      defaults: DEFAULT_TEST_CONFIG,
      normalize: normalizeTestConfig,
      sources: [{ settingsKey: "myExtension" }],
      _settingsManager: sm,
    });

    expect(config.tools).toEqual({ write: true, bash: false });
  });

  // ── Cascade: settings wins, legacy falls back ────────

  it("cascades: legacy only used when settings is empty (not set)", () => {
    const sm = SettingsManager.inMemory({} as any);

    writeJson(join(agentDir, "my-ext.json"), {
      tools: { write: true, grep: true },
    });

    const config = loadExtensionConfig(cwd, {
      defaults: DEFAULT_TEST_CONFIG,
      normalize: normalizeTestConfig,
      sources: [{ settingsKey: "myExtension", legacyFilename: "my-ext.json" }],
      agentDir,
      _settingsManager: sm,
    });

    expect(config.tools).toEqual({ write: true, grep: true });
  });

  it("cascades: legacy skipped when settings has data", () => {
    const sm = SettingsManager.inMemory({
      myExtension: { tools: { fromSettings: true } },
    } as any);

    writeJson(join(agentDir, "my-ext.json"), {
      tools: { fromLegacy: true },
    });

    const config = loadExtensionConfig(cwd, {
      defaults: DEFAULT_TEST_CONFIG,
      normalize: normalizeTestConfig,
      sources: [{ settingsKey: "myExtension", legacyFilename: "my-ext.json" }],
      agentDir,
      _settingsManager: sm,
    });

    expect(config.tools).toEqual({ fromSettings: true });
  });

  // ── Custom merge ─────────────────────────────────────

  it("uses custom merge function", () => {
    writeJson(join(agentDir, "my-ext.json"), {
      tools: { write: true },
      maxRetries: 3,
    });

    const config = loadExtensionConfig(cwd, {
      defaults: DEFAULT_TEST_CONFIG,
      normalize: normalizeTestConfig,
      sources: [{ legacyFilename: "my-ext.json" }],
      merge: deepMerge,
      agentDir,
    });

    expect(config.tools).toEqual({ write: true });
    expect(config.maxRetries).toBe(3);
  });

  // ── Multiple sources ─────────────────────────────────

  it("merges multiple sources in order", () => {
    writeJson(join(agentDir, "base.json"), {
      tools: { write: true, edit: false },
    });
    writeJson(join(agentDir, "override.json"), {
      tools: { edit: true, grep: true },
      maxRetries: 5,
    });

    const config = loadExtensionConfig(cwd, {
      defaults: DEFAULT_TEST_CONFIG,
      normalize: normalizeTestConfig,
      sources: [
        { legacyFilename: "base.json" },
        { legacyFilename: "override.json" },
      ],
      merge: deepMerge,
      agentDir,
    });

    expect(config.tools).toEqual({ write: true, edit: true, grep: true });
    expect(config.maxRetries).toBe(5);
  });

  // ── normalize filters invalid data ───────────────────

  it("normalize filters out non-boolean tool values", () => {
    writeJson(join(agentDir, "my-ext.json"), {
      tools: { write: true, edit: "yes", grep: 1, find: false },
    });

    const config = loadExtensionConfig(cwd, {
      defaults: DEFAULT_TEST_CONFIG,
      normalize: normalizeTestConfig,
      sources: [{ legacyFilename: "my-ext.json" }],
      agentDir,
    });

    expect(config.tools).toEqual({ write: true, find: false });
  });

  it("normalize handles null raw value", () => {
    writeFileSync(join(agentDir, "null-config.json"), "null");

    const config = loadExtensionConfig(cwd, {
      defaults: DEFAULT_TEST_CONFIG,
      normalize: normalizeTestConfig,
      sources: [{ legacyFilename: "null-config.json" }],
      agentDir,
    });

    expect(config).toEqual(DEFAULT_TEST_CONFIG);
  });

  it("normalize handles array raw value", () => {
    writeJson(join(agentDir, "array-config.json"), [1, 2, 3]);

    const config = loadExtensionConfig(cwd, {
      defaults: DEFAULT_TEST_CONFIG,
      normalize: normalizeTestConfig,
      sources: [{ legacyFilename: "array-config.json" }],
      agentDir,
    });

    expect(config).toEqual(DEFAULT_TEST_CONFIG);
  });

  // ── Default merge strategy (shallow spread) ──────────

  it("default merge does shallow spread", () => {
    writeJson(join(agentDir, "my-ext.json"), {
      tools: { write: true },
    });

    const config = loadExtensionConfig(cwd, {
      defaults: { tools: { defaultTool: true } } as TestConfig,
      normalize: normalizeTestConfig,
      sources: [{ legacyFilename: "my-ext.json" }],
      agentDir,
    });

    // With shallow spread, the legacy tools object *replaces* default tools entirely.
    expect(config.tools).toEqual({ write: true });
  });
});
