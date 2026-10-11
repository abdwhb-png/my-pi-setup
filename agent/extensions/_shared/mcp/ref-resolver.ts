import {
    createMcpToolName,
    mcpNamespace,
    type ToolInfo,
} from "@earendil-works/pi-coding-agent";

type RegisteredMcpTool = Pick<ToolInfo, "name" | "namespace" | "exposure">;

/** Read the live registry: MCP tools can arrive after session_start or disappear on reconnect. */
export function createMcpRefResolver(
    registered: () => readonly RegisteredMcpTool[],
): (reference: string) => string[] {
    return (reference) => {
        if (!reference.startsWith("mcp:")) return [reference];
        const match = /^mcp:([A-Za-z0-9_-]+)(?:\/(.+))?$/.exec(reference);
        if (!match) return [];
        const [, server, tool] = match;
        if (!server) return [];
        const namespace = mcpNamespace(server);
        const tools = registered().filter(
            (entry) =>
                entry.namespace?.name === namespace &&
                entry.exposure !== "hidden",
        );
        if (!tool) return tools.map((entry) => entry.name);
        const names = new Set([
            tool,
            createMcpToolName(server, tool),
            createMcpToolName(server, tool, () => true),
        ]);
        const matches = tools.filter((entry) => names.has(entry.name));
        return matches.length === 1 ? [matches[0]!.name] : [];
    };
}
