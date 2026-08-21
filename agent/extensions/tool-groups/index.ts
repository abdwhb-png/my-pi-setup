import type {
    ExtensionAPI,
    ExtensionContext,
    ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
    loadMcpConfig,
    loadMetadataCache,
} from "../_shared/mcp-tools/loader.ts";
import { resolveMcpToolReferences } from "../_shared/mcp-tools/resolver.ts";
import { loadToolGroupsConfig } from "../_shared/tool-groups/config.ts";
import { isToolGroupsPackageLast } from "../_shared/tool-groups/package-order.ts";
import { resolveToolAliases } from "../_shared/tool-groups/resolver.ts";
import {
    TOOL_GROUP_PREFIX,
    TOOL_GROUPS_REQUESTED_TOOLS_ENV,
    type ToolGroupsConfig,
    type ToolGroupDiagnostic,
} from "../_shared/tool-groups/types.ts";

function loadRequestedToolsFromEnv(): string[] | undefined {
    const raw = process.env[TOOL_GROUPS_REQUESTED_TOOLS_ENV];
    if (!raw) return undefined;
    delete process.env[TOOL_GROUPS_REQUESTED_TOOLS_ENV];

    try {
        const value: unknown = JSON.parse(raw);
        if (!Array.isArray(value)) return undefined;
        const names = value.filter(
            (name): name is string =>
                typeof name === "string" && name.trim().length > 0,
        );
        return names.some((name) => name.startsWith(TOOL_GROUP_PREFIX))
            ? names
            : undefined;
    } catch {
        return undefined;
    }
}

function diagnosticsKey(diags: ToolGroupDiagnostic[]): string {
    const entries = diags.map((d) => `${d.code}|${d.group}|${d.member}`);
    entries.sort();
    return entries.join(",");
}

function formatDiagnostics(diags: ToolGroupDiagnostic[]): string {
    const lines = diags.map((d) => `  [${d.code}] ${d.message}`);
    return `Tool-group diagnostics:\n${lines.join("\n")}`;
}

function checkToolGroupsPackageOrder(cwd: string): void {
    try {
        const agentDir = getAgentDir();
        const sm = SettingsManager.create(cwd, agentDir);
        const packages = sm.getPackages();
        if (
            packages.length > 0 &&
            !isToolGroupsPackageLast(packages, agentDir)
        ) {
            console.warn(
                "[tool-groups] Package order drift detected: tool-groups package is not loaded last. " +
                    "Run /reload to ensure tool-group configuration is applied correctly.",
            );
        }
    } catch {
        // Silently ignore — settings may not be available during early startup.
    }
}

/**
 * Build an MCP `mcp:` reference resolver bound to the merged config cache.
 * Returns a function that maps a single `mcp:` reference to concrete tool
 * names, or [] when unresolvable. Non-mcp refs pass through unchanged.
 */
function buildMcpResolver(cwd: string): (ref: string) => string[] {
    let config: ReturnType<typeof loadMcpConfig> = null;
    let cache: ReturnType<typeof loadMetadataCache> = null;
    try {
        config = loadMcpConfig(cwd);
        cache = loadMetadataCache();
    } catch {
        // Fall through to a no-op resolver if config/cache cannot be read.
    }
    return (ref: string): string[] => {
        if (!ref.startsWith("mcp:")) return [ref];
        if (!config) return [];
        const result = resolveMcpToolReferences([ref], config, cache);
        return result.names;
    };
}

export function createToolGroupsExtension(
    loadConfig: (cwd: string) => ToolGroupsConfig = loadToolGroupsConfig,
    loadRequestedTools: () => string[] | undefined = loadRequestedToolsFromEnv,
): ExtensionFactory {
    return (pi: ExtensionAPI) => {
        const cwd =
            typeof process !== "undefined" && typeof process.cwd === "function"
                ? process.cwd()
                : ".";
        const config = loadConfig(cwd);
        const groups = config.groups;
        const requestedTools = loadRequestedTools();
        const resolveMcp = buildMcpResolver(cwd);

        if (Object.keys(groups).length === 0 && !requestedTools?.length) {
            return;
        }

        for (const [groupName] of Object.entries(groups)) {
            const toolName = `${TOOL_GROUP_PREFIX}${groupName}`;
            pi.registerTool({
                name: toolName,
                label: `Group: ${groupName}`,
                description: `Tool group alias for @${groupName}. Register member tools in tool-groups config.`,
                parameters: Type.Object({}),
                execute() {
                    throw new Error(
                        `Tool @${groupName} is a group alias and cannot be executed directly. Use /reload after configuring group members in tool-groups config.`,
                    );
                },
            });
        }

        let lastDiagKey: string | undefined;
        let appliedRequestedTools = false;

        function reportDiagnostics(
            diagnostics: ToolGroupDiagnostic[],
            ctx: ExtensionContext,
        ): void {
            if (diagnostics.length > 0) {
                const key = diagnosticsKey(diagnostics);
                if (key !== lastDiagKey) {
                    lastDiagKey = key;
                    const msg = formatDiagnostics(diagnostics);
                    if (ctx.hasUI) {
                        ctx.ui.notify(msg, "warning");
                    } else {
                        console.warn(msg);
                    }
                }
            } else {
                lastDiagKey = undefined;
            }
        }

        function applyRequestedTools(ctx: ExtensionContext): void {
            if (appliedRequestedTools) return;
            appliedRequestedTools = true;
            if (!requestedTools?.length) return;

            const allToolNames = pi.getAllTools().map((tool) => tool.name);
            const currentlyAllowed = resolveToolAliases(
                pi.getActiveTools(),
                allToolNames,
                groups,
                resolveMcp,
            );
            const allowedNames = new Set(currentlyAllowed.names);
            const requested = resolveToolAliases(
                requestedTools,
                allToolNames,
                groups,
                resolveMcp,
            );

            pi.setActiveTools(
                requested.names.filter((name) => allowedNames.has(name)),
            );
            reportDiagnostics(requested.diagnostics, ctx);
        }

        function expandAliases(
            _event: unknown,
            ctx: ExtensionContext,
        ): { action: "continue" } | void {
            const active = pi.getActiveTools();
            const hasAliases = active.some((name) =>
                name.startsWith(TOOL_GROUP_PREFIX),
            );
            if (!hasAliases) {
                return;
            }

            const allToolNames = pi.getAllTools().map((t) => t.name);
            const result = resolveToolAliases(
                active,
                allToolNames,
                groups,
                resolveMcp,
            );

            pi.setActiveTools(result.names);

            reportDiagnostics(result.diagnostics, ctx);
        }

        pi.on("session_start", (event, ctx) => {
            applyRequestedTools(ctx);
            expandAliases(event, ctx);
            checkToolGroupsPackageOrder(cwd);
        });

        pi.on("input", (event, ctx) => {
            expandAliases(event, ctx);
            return { action: "continue" as const };
        });

        pi.on("before_agent_start", (event, ctx) => {
            expandAliases(event, ctx);
        });
    };
}

export default createToolGroupsExtension();
