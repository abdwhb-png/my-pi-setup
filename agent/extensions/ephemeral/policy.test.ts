/**
 * Tests for the extracted ephemeral policy module.
 *
 * All tests operate on pure data — no filesystem, no UI, no pi API.
 * Policy functions are injected with their dependencies.
 */

import { describe, it, expect } from "bun:test";
import {
  getInstallConflict,
  getRemovalConflict,
  getCatalogManifestWarnings,
  getLiveWarnings,
  getManagedEntriesByCategory,
} from "./policy.ts";
import type { CatalogData, CatalogItem, ManifestEntry, ProjectState } from "./types.ts";

// ===========================================================================
// Shared fixtures
// ===========================================================================

const emptyCatalog: CatalogData = {
  items: [],
  byKey: new Map(),
  byCategory: { skills: [], prompts: [], extensions: [], mcp: [] },
  warnings: [],
  catalogRoot: "/fake",
};

const emptyState: ProjectState = {
  cwd: "/project",
  paths: { manifestPath: "", settingsPath: "", projectMcpPath: "" },
  manifest: { version: 1, items: {} },
  warnings: [],
};

function makeSkillItem(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    key: "skill:test",
    id: "test",
    label: "test skill",
    description: "",
    type: "skill",
    category: "skills",
    sourcePath: "/catalog/skills/test/SKILL.md",
    sourceDir: "/catalog/skills/test",
    installMode: "copy",
    catalogFingerprint: "abc",
    previewTitle: "test skill",
    previewFormat: "markdown",
    previewContent: "# Test",
    sortText: "test skill",
    ...overrides,
  } as CatalogItem;
}


// ===========================================================================
// getInstallConflict
// ===========================================================================
describe("getInstallConflict", () => {
  it("returns undefined when item is already managed", () => {
    const state = {
      ...emptyState,
      manifest: { version: 1, items: { "skill:test": { key: "skill:test" } as ManifestEntry } },
    };
    expect(getInstallConflict(makeSkillItem(), state)).toBeUndefined();
  });

  // Note: filesystem-dependent test (targetExistsUnmanaged uses existsSync)
  // Tests in this suite focus on pure data-level logic instead.

  it("returns settings error for extension when settings are invalid", () => {
    const state = {
      ...emptyState,
      settingsError: "syntax error",
    };
    const extensionItem = makeSkillItem({
      type: "extension",
      category: "extensions",
      extensionKind: "package",
      entryName: "my-ext",
    } as any) as CatalogItem;
    const result = getInstallConflict(extensionItem, state);
    expect(result).toContain("settings.json is invalid");
  });

  it("returns mcp conflict when server already exists", () => {
    const state = {
      ...emptyState,
      mcpJson: { mcpServers: { existing: { command: "node" } } },
    };
    const mcpItem = {
      key: "mcp:existing",
      id: "existing",
      label: "existing",
      description: "",
      type: "mcp",
      category: "mcp",
      sourcePath: "/catalog/mcp/mcp.json#mcpServers.existing",
      serverName: "existing",
      serverConfig: { command: "node" },
      installMode: "merge",
      catalogFingerprint: "xyz",
      sourceFile: "/catalog/mcp/mcp.json",
      previewTitle: "existing",
      previewFormat: "json",
      previewContent: "{}",
      sortText: "existing",
    } as CatalogItem;
    const result = getInstallConflict(mcpItem, state);
    expect(result).toContain("conflicts with existing project server");
  });

  it("returns mcp error when mcp.json is invalid", () => {
    const state = { ...emptyState, mcpError: "parse error" };
    const mcpItem = {
      key: "mcp:new",
      id: "new",
      label: "new",
      description: "",
      type: "mcp",
      category: "mcp",
      sourcePath: "/catalog/mcp/mcp.json#mcpServers.new",
      serverName: "new",
      serverConfig: { command: "node" },
      installMode: "merge",
      catalogFingerprint: "xyz",
      sourceFile: "/catalog/mcp/mcp.json",
      previewTitle: "new",
      previewFormat: "json",
      previewContent: "{}",
      sortText: "new",
    } as CatalogItem;
    const result = getInstallConflict(mcpItem, state);
    expect(result).toContain("mcp.json is invalid");
  });

  it("returns undefined for mcp with no conflict", () => {
    const item = {
      key: "mcp:new",
      id: "new",
      label: "new",
      description: "",
      type: "mcp",
      category: "mcp",
      sourcePath: "/catalog/mcp/mcp.json#mcpServers.new",
      serverName: "new",
      serverConfig: { command: "node" },
      installMode: "merge",
      catalogFingerprint: "xyz",
      sourceFile: "/catalog/mcp/mcp.json",
      previewTitle: "new",
      previewFormat: "json",
      previewContent: "{}",
      sortText: "new",
    } as CatalogItem;
    expect(getInstallConflict(item, emptyState)).toBeUndefined();
  });
});

// ===========================================================================
// getRemovalConflict
// ===========================================================================
describe("getRemovalConflict", () => {
  it("returns undefined when no settings changes and type is not mcp", () => {
    const entry: ManifestEntry = {
      key: "skill:test",
      type: "skill",
      category: "skills",
      id: "test",
      label: "test",
      installMode: "copy",
      sourcePath: "/catalog",
      targetPaths: [],
      settingsChanges: [],
      installedAt: "now",
      catalogFingerprint: "abc",
    };
    expect(getRemovalConflict(entry, emptyState)).toBeUndefined();
  });

  it("returns conflict when settings changes exist and settings are invalid", () => {
    const entry: ManifestEntry = {
      key: "ext:my",
      type: "extension",
      category: "extensions",
      id: "my",
      label: "my",
      installMode: "reference",
      sourcePath: "/catalog",
      targetPaths: [],
      settingsChanges: [{ file: "settings.json", kind: "extensions", value: "/path" }],
      installedAt: "now",
      catalogFingerprint: "abc",
    };
    const state = { ...emptyState, settingsError: "invalid" };
    const result = getRemovalConflict(entry, state);
    expect(result).toContain("settings.json is invalid");
  });

  it("returns conflict for mcp type with invalid mcp.json", () => {
    const entry: ManifestEntry = {
      key: "mcp:srv",
      type: "mcp",
      category: "mcp",
      id: "srv",
      label: "srv",
      installMode: "merge",
      sourcePath: "/catalog",
      targetPaths: [],
      settingsChanges: [],
      installedAt: "now",
      catalogFingerprint: "abc",
      serverName: "srv",
    };
    const state = { ...emptyState, mcpError: "parse error" };
    const result = getRemovalConflict(entry, state);
    expect(result).toContain("mcp.json is invalid");
  });
});

// ===========================================================================
// getCatalogManifestWarnings
// ===========================================================================
describe("getCatalogManifestWarnings", () => {
  it("returns empty when all items exist in catalog", () => {
    const catalog = {
      ...emptyCatalog,
      byKey: new Map([["skill:test", makeSkillItem()]]),
    };
    const items = { "skill:test": { key: "skill:test" } as ManifestEntry };
    expect(getCatalogManifestWarnings(items, catalog)).toEqual([]);
  });

  it("warns about items missing from catalog", () => {
    const items = { "skill:orphan": { key: "skill:orphan" } as ManifestEntry };
    const warnings = getCatalogManifestWarnings(items, emptyCatalog);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("missing from catalog");
    expect(warnings[0]).toContain("skill:orphan");
  });
});

// ===========================================================================
// getLiveWarnings
// ===========================================================================
describe("getLiveWarnings", () => {
  it("includes state and catalog warnings", () => {
    const state = { ...emptyState, warnings: ["state warning"] };
    const catalog = { ...emptyCatalog, warnings: ["catalog warning"] };
    expect(getLiveWarnings(state, catalog, new Set())).toEqual([
      "state warning",
      "catalog warning",
    ]);
  });

  it("deduplicates warnings", () => {
    const state = { ...emptyState, warnings: ["dup"] };
    const catalog = { ...emptyCatalog, warnings: ["dup"] };
    const result = getLiveWarnings(state, catalog, new Set());
    expect(result).toEqual(["dup"]);
  });
});

// ===========================================================================
// getManagedEntriesByCategory
// ===========================================================================
describe("getManagedEntriesByCategory", () => {
  it("returns empty groups for empty manifest", () => {
    const groups = getManagedEntriesByCategory(emptyState);
    expect(groups.skills).toEqual([]);
    expect(groups.prompts).toEqual([]);
    expect(groups.extensions).toEqual([]);
    expect(groups.mcp).toEqual([]);
  });

  it("groups entries by category and sorts by label", () => {
    const state: ProjectState = {
      ...emptyState,
      manifest: {
        version: 1,
        items: {
          b: { key: "b", category: "skills", id: "b", label: "B" } as ManifestEntry,
          a: { key: "a", category: "skills", id: "a", label: "A" } as ManifestEntry,
        },
      },
    };
    const groups = getManagedEntriesByCategory(state);
    expect(groups.skills.map((e) => e.label)).toEqual(["A", "B"]);
  });

  it("uses catalog label when available", () => {
    const state: ProjectState = {
      ...emptyState,
      manifest: {
        version: 1,
        items: {
          x: { key: "skill:x", category: "skills", id: "x", label: "old" } as ManifestEntry,
        },
      },
    };
    const catalog: CatalogData = {
      ...emptyCatalog,
      byKey: new Map([["skill:x", makeSkillItem({ label: "new label from catalog" })]]),
    };
    const groups = getManagedEntriesByCategory(state, catalog);
    expect(groups.skills[0].label).toBe("new label from catalog");
  });
});