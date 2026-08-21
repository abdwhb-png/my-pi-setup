/**
 * Naming helpers mirrored from the pi-mcp-adapter (`types.ts`, `resource-tools.ts`)
 * so the shared resolver produces the SAME concrete tool names the adapter
 * registers. Replicated here (not imported from the external package) so
 * tool-groups and slow-mode stay independent of the adapter's package layout.
 */
import type { ToolPrefix } from "./types.ts";

export function resourceNameToToolName(name: string): string {
  let result = name
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "")
    .toLowerCase();

  if (!result || /^\d/.test(result)) {
    result = "resource" + (result ? "_" + result : "");
  }

  return result;
}

export function getServerPrefix(serverName: string, mode: ToolPrefix): string {
  if (mode === "none") return "";
  if (mode === "short") {
    let short = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_");
    if (!short) short = "mcp";
    return short;
  }
  if (mode === "mcp") return `mcp__${serverName.replace(/-/g, "_")}`;
  return serverName.replace(/-/g, "_");
}

export function formatToolName(
  toolName: string,
  serverName: string,
  prefix: ToolPrefix,
): string {
  const p = getServerPrefix(serverName, prefix);
  const sanitized = toolName.replace(/\./g, "_");
  return p ? `${p}_${sanitized}` : sanitized;
}

export function resolveToolPrefix(
  definition?: { toolPrefix?: ToolPrefix },
  globalPrefix?: ToolPrefix,
): ToolPrefix {
  return definition?.toolPrefix ?? globalPrefix ?? "server";
}

function normalizeToolName(value: string): string {
  return value.replace(/-/g, "_");
}

function getToolNameCandidates(toolName: string, serverName: string, prefix: ToolPrefix): Set<string> {
  return new Set<string>([
    normalizeToolName(toolName),
    normalizeToolName(formatToolName(toolName, serverName, prefix)),
    normalizeToolName(formatToolName(toolName, serverName, "server")),
    normalizeToolName(formatToolName(toolName, serverName, "short")),
    normalizeToolName(formatToolName(toolName, serverName, "mcp")),
  ]);
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function matchesToolPattern(candidates: Set<string>, patterns?: unknown): boolean {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;

  for (const pattern of patterns) {
    if (typeof pattern !== "string") continue;
    const normalized = normalizeToolName(pattern);
    if (!normalized.includes("*") && !normalized.includes("?") && candidates.has(normalized)) {
      return true;
    }
    if ((normalized.includes("*") || normalized.includes("?")) && [...candidates].some((candidate) => globToRegExp(normalized).test(candidate))) {
      return true;
    }
  }

  return false;
}

export function isToolIncluded(
  toolName: string,
  serverName: string,
  prefix: ToolPrefix,
  includeTools?: unknown,
): boolean {
  if (!Array.isArray(includeTools) || includeTools.length === 0) return true;
  return matchesToolPattern(getToolNameCandidates(toolName, serverName, prefix), includeTools);
}

export function isToolExcluded(
  toolName: string,
  serverName: string,
  prefix: ToolPrefix,
  excludeTools?: unknown,
): boolean {
  return matchesToolPattern(getToolNameCandidates(toolName, serverName, prefix), excludeTools);
}

export function isToolAllowed(
  toolName: string,
  serverName: string,
  prefix: ToolPrefix,
  includeTools?: unknown,
  excludeTools?: unknown,
): boolean {
  return isToolIncluded(toolName, serverName, prefix, includeTools)
    && !isToolExcluded(toolName, serverName, prefix, excludeTools);
}
