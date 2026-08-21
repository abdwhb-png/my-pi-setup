/**
 * Shared MCP reference resolution — types mirroring the subset of the
 * pi-mcp-adapter metadata cache + config contracts that tool-groups and
 * slow-mode need to resolve `mcp:`-prefixed tool references.
 *
 * Kept intentionally small and self-contained (no dependency on the external
 * pi-mcp-adapter npm package) so both consumers share one source of truth.
 */

export type ToolPrefix = "server" | "none" | "short" | "mcp";

export interface McpServerEntry {
  command?: string;
  args?: string[];
  socket?: string;
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: "oauth" | "bearer" | false;
  bearerToken?: string;
  bearerTokenEnv?: string;
  lifecycle?: "keep-alive" | "lazy" | "lazy-keep-alive" | "eager";
  exposeResources?: boolean;
  directTools?: boolean | string[];
  toolPrefix?: ToolPrefix;
  includeTools?: string[];
  excludeTools?: string[];
  disabled?: boolean;
}

export interface McpSettings {
  toolPrefix?: ToolPrefix;
  directTools?: boolean;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
  settings?: McpSettings;
}

export interface CachedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface CachedResource {
  uri: string;
  name: string;
  description?: string;
}

export interface ServerCacheEntry {
  configHash: string;
  tools: CachedTool[];
  resources: CachedResource[];
  cachedAt: number;
}

export interface MetadataCache {
  version: number;
  servers: Record<string, ServerCacheEntry>;
}

export interface McpToolReference {
  /** Full original reference, e.g. "mcp:context7" or "mcp:context7/query_docs". */
  raw: string;
  /** Server name when the reference targets a server (or server/tool). */
  server?: string;
  /** Tool name when the reference targets a specific tool (server/tool). */
  tool?: string;
}

export interface McpToolResolution {
  /** Concrete registered tool names, order-preserving, deduplicated. */
  names: string[];
  /** Human-readable reasons for references that could not be resolved. */
  diagnostics: string[];
}

export type McpRefResolver = (
  refs: string[],
) => McpToolResolution;
