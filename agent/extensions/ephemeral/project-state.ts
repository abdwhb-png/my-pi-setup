import { readFile } from "node:fs/promises";
import type { CatalogData, ManifestEntry, ProjectMcpJson, ProjectSettingsJson, ProjectState } from "./types.ts";
import { readManifest } from "./manifest.ts";
import { readProjectMcp } from "./mcp.ts";
import { getCatalogManifestWarnings } from "./policy.ts";
import { getProjectPaths, isJsonObject, pathExists } from "./util.ts";

export async function readProjectState(cwd: string, catalog?: CatalogData): Promise<ProjectState> {
  const paths = getProjectPaths(cwd);

  const [manifest, settingsResult, mcpResult] = await Promise.all([
    readManifest(paths.manifestPath),
    loadProjectSettings(paths.settingsPath),
    loadProjectMcp(paths.projectMcpPath),
  ]);

  const [manifestWarnings, catalogWarnings] = await Promise.all([
    computeManifestWarnings(cwd, manifest.items, settingsResult.value, mcpResult.value),
    Promise.resolve(catalog ? getCatalogManifestWarnings(manifest.items, catalog) : []),
  ]);

  const warnings = [
    ...(settingsResult.error ? [`settings.json error: ${settingsResult.error}`] : []),
    ...(mcpResult.error ? [`mcp.json error: ${mcpResult.error}`] : []),
    ...manifestWarnings,
    ...catalogWarnings,
  ];

  return {
    cwd,
    paths,
    manifest,
    settingsJson: settingsResult.value,
    settingsError: settingsResult.error,
    mcpJson: mcpResult.value,
    mcpError: mcpResult.error,
    warnings,
  };
}

async function computeManifestWarnings(
  cwd: string,
  items: Record<string, ManifestEntry>,
  settingsJson?: ProjectSettingsJson,
  mcpJson?: ProjectMcpJson,
): Promise<string[]> {
  const warningGroups = await Promise.all(
    Object.values(items).map((entry) => computeManifestEntryWarnings(cwd, entry, settingsJson, mcpJson)),
  );
  return warningGroups.flat();
}

async function computeManifestEntryWarnings(
  cwd: string,
  entry: ManifestEntry,
  settingsJson?: ProjectSettingsJson,
  mcpJson?: ProjectMcpJson,
): Promise<string[]> {
  const warnings: string[] = [];

  switch (entry.type) {
    case "skill":
    case "prompt":
    case "extension": {
      const missingTargets = await Promise.all(
        entry.targetPaths.map(async (targetPath) => (
          (await pathExists(targetPath)) ? undefined : `drift detected: managed ${entry.type} '${entry.id}' missing target ${targetPath}`
        )),
      );
      warnings.push(...missingTargets.flatMap((warning) => (warning ? [warning] : [])));

      warnings.push(
        ...entry.settingsChanges.flatMap((change) => {
          const values = change.kind === "extensions" ? settingsJson?.extensions ?? [] : [];
          return values.includes(change.value)
            ? []
            : [`drift detected: managed ${entry.type} '${entry.id}' missing settings reference ${change.value}`];
        }),
      );
      break;
    }
    case "mcp": {
      const servers = mcpJson?.mcpServers ?? {};
      if (!entry.serverName || !servers[entry.serverName]) {
        warnings.push(`drift detected: managed mcp '${entry.id}' missing server entry ${entry.serverName ?? entry.id}`);
      }
      break;
    }
  }

  const isCatalogFragment = !entry.sourcePath.startsWith(cwd) && entry.sourcePath.includes("#");
  if (!isCatalogFragment) {
    const sourcePath = entry.sourcePath.split("#", 1)[0]!;
    if (!(await pathExists(sourcePath))) {
      warnings.push(`drift detected: managed ${entry.type} '${entry.id}' missing catalog source ${sourcePath}`);
    }
  }

  return warnings;
}

async function loadProjectSettings(settingsPath: string): Promise<LoadResult<ProjectSettingsJson>> {
  try {
    return { value: await readProjectSettings(settingsPath) };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

async function loadProjectMcp(projectMcpPath: string): Promise<LoadResult<ProjectMcpJson>> {
  try {
    return { value: await readProjectMcp(projectMcpPath) };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

async function readProjectSettings(settingsPath: string): Promise<ProjectSettingsJson | undefined> {
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isJsonObject(parsed)) {
    throw new Error(`Invalid project settings: ${settingsPath}`);
  }

  if (
    parsed.extensions !== undefined
    && (!Array.isArray(parsed.extensions) || !parsed.extensions.every((entry): entry is string => typeof entry === "string"))
  ) {
    throw new Error(`Invalid project settings: ${settingsPath}`);
  }

  return parsed as ProjectSettingsJson;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

type LoadResult<T> = {
  value?: T;
  error?: string;
};
