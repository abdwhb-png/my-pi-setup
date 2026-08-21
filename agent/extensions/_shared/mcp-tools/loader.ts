/**
 * File-system loader for the shared MCP resolver — reads the same MCP config
 * sources and metadata cache the pi-mcp-adapter/pic-subagents use.
 *
 * Paths are resolved through `getAgentDir()` so home is never hardcoded.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { McpConfig, MetadataCache } from "./types.ts";

const GENERIC_GLOBAL_CONFIG_PATH = join(homedir(), ".config", "mcp", "mcp.json");

function resolveConfigPaths(cwd: string): string[] {
  const agentDir = getAgentDir();
  const sources: string[] = [];
  if (GENERIC_GLOBAL_CONFIG_PATH !== join(agentDir, "mcp.json")) {
    sources.push(GENERIC_GLOBAL_CONFIG_PATH);
  }
  sources.push(join(agentDir, "mcp.json"));
  sources.push(join(cwd, ".mcp.json"));
  sources.push(join(cwd, ".pi", "mcp.json"));
  return sources;
}

function readJsonIfExists(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function validateConfig(raw: unknown): McpConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const servers = obj.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return null;
  const settings =
    obj.settings && typeof obj.settings === "object" && !Array.isArray(obj.settings)
      ? (obj.settings as McpConfig["settings"])
      : undefined;
  return { mcpServers: servers as McpConfig["mcpServers"], settings };
}

/**
 * Load the merged MCP config across the standard discovery sources.
 * Higher-precedence sources (project override) win over global.
 */
export function loadMcpConfig(cwd: string = process.cwd()): McpConfig | null {
  let merged: Record<string, unknown> | null = null;
  let settings: McpConfig["settings"] | undefined;

  for (const path of resolveConfigPaths(cwd)) {
    const loaded = validateConfig(readJsonIfExists(path));
    if (!loaded) continue;
    if (!merged) merged = {};
    merged = { ...merged, ...loaded.mcpServers };
    if (loaded.settings) settings = { ...settings, ...loaded.settings };
  }

  if (!merged) return null;
  return { mcpServers: merged as McpConfig["mcpServers"], settings };
}

const CACHE_VERSION = 1;

/** Load the metadata cache (mirrors the adapter's `loadMetadataCache`). */
export function loadMetadataCache(): MetadataCache | null {
  const cachePath = join(getAgentDir(), "mcp-cache.json");
  const raw = readJsonIfExists(cachePath);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== CACHE_VERSION || !obj.servers || typeof obj.servers !== "object" || Array.isArray(obj.servers)) {
    return null;
  }
  return raw as MetadataCache;
}
