/**
 * Policy helpers for the ephemeral extension.
 *
 * Decision logic (conflict detection, warnings, grouping) lives here.
 * Filesystem coupling is limited to a single `existsSync` check,
 * passed as an injected dependency.
 */

import { existsSync } from "node:fs";
import type { CatalogData, CatalogItem, ManifestEntry, ProjectState } from "./types.ts";
import { resolveProjectPath } from "./util.ts";

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

/**
 * Returns a human-readable conflict message if `item` cannot be installed,
 * or undefined if installation can proceed.
 */
export function getInstallConflict(item: CatalogItem, state: ProjectState): string | undefined {
  const managedEntry = state.manifest.items[item.key];
  if (managedEntry) return undefined;

  switch (item.type) {
    case "skill": {
      const targetPath = resolveProjectPath(state.cwd, ".pi", "skills", item.id);
      return targetExistsUnmanaged(targetPath, state)
        ? `skill '${item.label}' conflicts with local path ${targetPath}`
        : undefined;
    }
    case "prompt": {
      const targetPath = resolveProjectPath(state.cwd, ".pi", "prompts", item.fileName);
      return targetExistsUnmanaged(targetPath, state)
        ? `prompt '${item.label}' conflicts with local path ${targetPath}`
        : undefined;
    }
    case "extension": {
      if (item.extensionKind === "single-file") {
        const targetPath = resolveProjectPath(state.cwd, ".pi", "extensions", item.entryName);
        return targetExistsUnmanaged(targetPath, state)
          ? `extension '${item.label}' conflicts with local path ${targetPath}`
          : undefined;
      }

      if (state.settingsError) {
        return `extension '${item.label}' cannot be installed because .pi/settings.json is invalid`;
      }

      const targetPath = resolveProjectPath(state.cwd, ".pi", "ephemeral", "extensions", item.entryName);
      return targetExistsUnmanaged(targetPath, state)
        ? `extension '${item.label}' conflicts with local path ${targetPath}`
        : undefined;
    }
    case "mcp": {
      if (state.mcpError) {
        return `mcp '${item.label}' cannot be installed because .pi/mcp.json is invalid`;
      }
      const existing = state.mcpJson?.mcpServers ?? {};
      return existing[item.serverName]
        ? `mcp server '${item.serverName}' conflicts with existing project server`
        : undefined;
    }
  }
}

/**
 * Returns a conflict message if a managed entry cannot be removed,
 * or undefined if removal can proceed.
 */
export function getRemovalConflict(entry: ManifestEntry, state: ProjectState): string | undefined {
  if (entry.settingsChanges.length > 0 && state.settingsError) {
    return `managed extension '${entry.label}' cannot be removed because .pi/settings.json is invalid`;
  }
  if (entry.type === "mcp" && state.mcpError) {
    return `managed mcp server '${entry.label}' cannot be removed because .pi/mcp.json is invalid`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Warning helpers
// ---------------------------------------------------------------------------

/**
 * Returns warnings about items that are managed but missing from the catalog.
 */
export function getCatalogManifestWarnings(
  items: Record<string, ManifestEntry>,
  catalog: CatalogData,
): string[] {
  return Object.values(items).flatMap((entry) =>
    catalog.byKey.has(entry.key) ? [] : [`managed item missing from catalog: ${entry.key}`],
  );
}

/**
 * Computes live warnings for a desired set of changes, including:
 * - Any existing state/catalog warnings
 * - Conflicts for items that should be enabled but aren't yet installed
 */
export function getLiveWarnings(
  state: ProjectState,
  catalog: CatalogData,
  desiredKeys: Set<string>,
): string[] {
  const warnings = [...state.warnings, ...catalog.warnings];
  for (const item of catalog.items) {
    const isManaged = Boolean(state.manifest.items[item.key]);
    const shouldBeEnabled = desiredKeys.has(item.key);
    if (!shouldBeEnabled || isManaged) continue;

    const conflict = getInstallConflict(item, state);
    if (conflict) warnings.push(conflict);
  }

  return uniqueStrings(warnings);
}

// ---------------------------------------------------------------------------
// Grouping helpers
// ---------------------------------------------------------------------------

/**
 * Groups managed entries by category, optionally using catalog labels.
 */
export function getManagedEntriesByCategory(
  state: ProjectState,
  catalog?: CatalogData,
): Record<string, Array<{ key: string; label: string }>> {
  const grouped: Record<string, Array<{ key: string; label: string }>> = {
    skills: [],
    prompts: [],
    extensions: [],
    mcp: [],
  };

  for (const entry of Object.values(state.manifest.items)) {
    const label = catalog?.byKey.get(entry.key)?.label ?? entry.label ?? entry.id;
    grouped[entry.category].push({ key: entry.key, label });
  }

  for (const category of Object.keys(grouped)) {
    grouped[category].sort((left, right) => left.label.localeCompare(right.label));
  }

  return grouped;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function targetExistsUnmanaged(targetPath: string, state: ProjectState): boolean {
  if (!existsSync(targetPath)) return false;
  return !Object.values(state.manifest.items).some((entry) => entry.targetPaths.includes(targetPath));
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}