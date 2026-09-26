import { parseMcpReference, resolveMcpToolReferences } from "pi-mcp-adapter";
import { loadMcpConfig } from "pi-mcp-adapter/config";
import {
    loadMetadataCache,
    type MetadataCache,
} from "pi-mcp-adapter/metadata-cache";
import {
    formatToolName,
    resolveToolPrefix,
    type McpConfig,
} from "pi-mcp-adapter/types";

interface McpRefResolverSources {
    loadConfig?: (cwd: string) => McpConfig;
    loadCache?: () => MetadataCache | null;
    envDirectTools?: string[];
}

/** Bind MCP references to one config/cache snapshot for a consumer lifecycle. */
export function createMcpRefResolver(
    cwd = process.cwd(),
    sources: McpRefResolverSources = {},
): (ref: string) => string[] {
    const loadConfig =
        sources.loadConfig ?? ((dir: string) => loadMcpConfig(undefined, dir));
    const loadCache = sources.loadCache ?? loadMetadataCache;
    const selectors =
        sources.envDirectTools ??
        process.env.MCP_DIRECT_TOOLS?.split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    let snapshot:
        | { config: McpConfig; cache: MetadataCache | null }
        | undefined;

    return (ref) => {
        if (!ref.startsWith("mcp:")) return [ref];
        // An exception leaves the snapshot unset: the next call can retry.
        snapshot ??= { config: loadConfig(cwd), cache: loadCache() };
        const { config, cache } = snapshot;
        const names = resolveMcpToolReferences(
            [ref],
            config,
            cache,
            selectors,
        ).names;
        if (names.length > 0) return names;

        // The official resolver expects a registered name for proxy server/tool
        // references; older configs use the server's original tool name.
        const { server, tool } = parseMcpReference(ref);
        const definition = server && config.mcpServers[server];
        if (!server || !tool || !definition) return names;
        const registered = formatToolName(
            tool,
            server,
            resolveToolPrefix(definition, config.settings?.toolPrefix),
        );
        return registered === tool
            ? names
            : resolveMcpToolReferences(
                  [`mcp:${server}/${registered}`],
                  config,
                  cache,
                  selectors,
              ).names;
    };
}
