/**
 * Shared MCP `mcp:`-reference resolver.
 *
 * Translates `mcp:<server>`, `mcp:<server>/<tool>`, and `mcp:<tool>` references
 * into the concrete tool names the pi-mcp-adapter registers (per its
 * `formatToolName` naming) so tool-groups and slow-mode can validate them
 * against the live registry instead of flagging them as unknown.
 *
 * Pure — config and metadata cache are injected for testability.
 */
import { formatToolName, isToolAllowed, resolveToolPrefix, resourceNameToToolName } from "./naming.ts";
import type { McpConfig, MetadataCache, McpSettings, McpServerEntry, ServerCacheEntry, ToolPrefix } from "./types.ts";

export function parseMcpReference(raw: string): { server?: string; tool?: string; raw: string } {
  if (!raw.startsWith("mcp:")) return { raw };
  const rest = raw.slice("mcp:".length).trim();
  if (!rest) return { raw };

  if (rest.includes("/")) {
    const slash = rest.indexOf("/");
    const server = rest.slice(0, slash).trim();
    const tool = rest.slice(slash + 1).trim();
    return { raw, server: server || undefined, tool: tool || undefined };
  }
  return { raw, server: rest };
}

/** Whether the toolPrefix/effective naming uses the `server` mode. */
function effectivePrefix(settings: McpSettings | undefined, def: McpServerEntry | undefined): ToolPrefix {
  return resolveToolPrefix(def, settings?.toolPrefix);
}

/**
 * Whether a server's tools are exposed under direct-tool names. Proxy-only
 * servers (no directTools) expose their tools ONLY through the proxy `mcp`
 * tool, so a bare reference cannot map to a concrete registered tool name.
 */
export function isProxyOnlyServer(def: McpServerEntry | undefined, settings: McpSettings | undefined): boolean {
  if (!def) return true;
  if (def.disabled === true) return false;
  const direct = def.directTools !== undefined ? def.directTools : settings?.directTools;
  return !(direct === true || (Array.isArray(direct) && direct.length > 0));
}

/** Namespace-proxy tool name for a proxy-only server (D2). */
export function namespaceProxyName(serverName: string): string {
  return `mcp__${serverName.replace(/-/g, "_")}`;
}

function isServerCacheUsable(entry: ServerCacheEntry | undefined): entry is ServerCacheEntry {
  return !!entry && Array.isArray(entry.tools);
}

function collectServerTools(
  serverName: string,
  def: McpServerEntry,
  entry: ServerCacheEntry,
  prefix: ToolPrefix,
  onlyTool?: string,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  const matches = (baseName: string): boolean =>
    onlyTool === undefined || baseName === onlyTool || formatToolName(baseName, serverName, prefix) === onlyTool;

  const push = (baseName: string): void => {
    if (!matches(baseName)) return;
    if (!isToolAllowed(baseName, serverName, prefix, def.includeTools, def.excludeTools)) return;
    const name = formatToolName(baseName, serverName, prefix);
    if (seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };

  for (const tool of entry.tools ?? []) {
    if (tool?.name) push(tool.name);
  }

  if (def.exposeResources !== false) {
    for (const resource of entry.resources ?? []) {
      if (resource?.name) push(`read_${resourceNameToToolName(resource.name)}`);
    }
  }

  return names;
}

/**
 * Resolve `mcp:`-prefixed references to concrete registered tool names.
 *
 * Mutually validates against config + metadata cache. For a proxy-only server
 * (no directTools), a bare server-level reference resolves to the server's
 * namespace-proxy name (D2) rather than failing — the caller decides whether
 * that proxy is actually registered.
 */
export function resolveMcpToolReferences(
  refs: string[],
  config: McpConfig | null,
  cache: MetadataCache | null,
): { names: string[]; diagnostics: string[] } {
  const names: string[] = [];
  const diagnostics: string[] = [];
  const seen = new Set<string>();

  const addName = (name: string): void => {
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  };

  for (const raw of refs) {
    if (!raw.startsWith("mcp:")) {
      // Non-mcp references are passed through untouched by this helper.
      addName(raw);
      continue;
    }

    const parsed = parseMcpReference(raw);
    if (!parsed.server) {
      diagnostics.push(`MCP reference "${raw}" is empty after the "mcp:" prefix`);
      continue;
    }

    if (!config) {
      diagnostics.push(`MCP reference "${raw}" cannot be resolved: no MCP config`);
      continue;
    }

    const def = config.mcpServers[parsed.server];
    if (!def) {
      // Bare tool reference (e.g. "mcp:ctx_execute"): seek the tool across servers.
      resolveBareToolReference(raw, parsed.server, config, cache, addName, diagnostics);
      continue;
    }
    if (def.disabled === true) {
      diagnostics.push(`MCP reference "${raw}" refers to disabled server "${parsed.server}"`);
      continue;
    }

    const prefix = effectivePrefix(config.settings, def);
    const entry = cache?.servers?.[parsed.server];

    if (!isServerCacheUsable(entry)) {
      diagnostics.push(`MCP reference "${raw}" cannot be resolved: no metadata for server "${parsed.server}"`);
      continue;
    }

    if (isProxyOnlyServer(def, config.settings)) {
      // Proxy-only server (D2): resolve to the namespace-proxy name.
      addName(namespaceProxyName(parsed.server));
      continue;
    }

    if (parsed.tool !== undefined) {
      const toolNames = collectServerTools(parsed.server, def, entry, prefix, parsed.tool);
      if (toolNames.length === 0) {
        diagnostics.push(`MCP reference "${raw}" refers to unknown tool "${parsed.tool}" on server "${parsed.server}"`);
        continue;
      }
      for (const n of toolNames) addName(n);
      continue;
    }

    // Server-level expansion à tous (D3).
    const allNames = collectServerTools(parsed.server, def, entry, prefix);
    if (allNames.length === 0) {
      diagnostics.push(`MCP reference "${raw}" resolves to no tools on server "${parsed.server}"`);
      continue;
    }
    for (const n of allNames) addName(n);
  }

  return { names, diagnostics };
}

/**
 * Resolve a bare tool reference ("mcp:<tool>") that matched no server name by
 * searching every configured server for a tool (or resource) that matches by
 * original name or registered prefixed name. Returns the concrete registered
 * name for direct servers, or the hosting server's namespace-proxy name for
 * proxy-only servers.
 */
function resolveBareToolReference(
  raw: string,
  toolName: string,
  config: McpConfig | null,
  cache: MetadataCache | null,
  addName: (name: string) => void,
  diagnostics: string[],
): void {
  if (!config || !cache) {
    diagnostics.push(`MCP reference "${raw}" cannot be resolved: no MCP config/cache`);
    return;
  }

  for (const [serverName, def] of Object.entries(config.mcpServers)) {
    if (!def || def.disabled === true) continue;
    const entry = cache.servers?.[serverName];
    if (!isServerCacheUsable(entry)) continue;

    const prefix = effectivePrefix(config.settings, def);
    const matchesTool = (baseName: string): boolean =>
      baseName === toolName || formatToolName(baseName, serverName, prefix) === toolName;
    const hasTool = (entry.tools ?? []).some((t) => t?.name && matchesTool(t.name));
    const hasResource = (def.exposeResources !== false && (entry.resources ?? []).some((r) => r?.name && matchesTool(`read_${resourceNameToToolName(r.name)}`)));

    if (!hasTool && !hasResource) continue;

    if (isProxyOnlyServer(def, config.settings)) {
      addName(namespaceProxyName(serverName));
      return;
    }

    const found = collectServerTools(serverName, def, entry, prefix, toolName);
    for (const n of found) addName(n);
    return;
  }

  diagnostics.push(`MCP reference "${raw}" refers to no matching server or tool`);
}
