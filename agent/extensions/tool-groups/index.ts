import type {
    ExtensionAPI,
    ExtensionContext,
    ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createMcpRefResolver } from "pi-mcp-adapter";
import type { RoleToolPolicyPayload } from "../_shared/pi-roles/index.ts";
import { getSharedVisibilityBroker } from "../_shared/tool-groups/broker.ts";
import { loadToolGroupsConfig } from "../_shared/tool-groups/config.ts";
import {
    SUBAGENT_EXTENSION_BINDINGS_ENV,
    TOOL_GROUP_PREFIX,
    TOOL_GROUPS_CHILD_POLICY_BINDING,
    TOOL_GROUPS_REQUESTED_TOOLS_ENV,
    type ToolGroupsChildPolicy,
    type ToolGroupsConfig,
    type ToolGroupDiagnostic,
} from "../_shared/tool-groups/types.ts";
import {
    getToolPolicy,
    registerToolPolicyContribution,
} from "../_shared/tool-policy/index.ts";
import { registerProviderCatalogFinalizer } from "../_shared/tool-policy/provider-catalog-finalizer.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function loadChildToolPolicyFromEnv(): ToolGroupsChildPolicy | undefined {
    const raw = process.env[SUBAGENT_EXTENSION_BINDINGS_ENV];
    if (!raw) return undefined;

    try {
        const bindings: unknown = JSON.parse(raw);
        if (!isRecord(bindings)) return { allowedTools: [] };
        const policy = bindings[TOOL_GROUPS_CHILD_POLICY_BINDING];
        if (policy === undefined) return undefined;
        if (!isRecord(policy) || !Array.isArray(policy.allowedTools)) {
            return { allowedTools: [] };
        }
        const allowedTools = policy.allowedTools;
        if (
            allowedTools.length > 256 ||
            allowedTools.some(
                (name) => typeof name !== "string" || !name.trim(),
            )
        ) {
            return { allowedTools: [] };
        }
        return { allowedTools: [...new Set(allowedTools)] };
    } catch {
        return { allowedTools: [] };
    }
}

const REQUESTED_TOOLS_KEY = Symbol.for("pi.tool-policy.cli-requested.v1");
type RequestedToolsRegistry = typeof globalThis & {
    [REQUESTED_TOOLS_KEY]?: string[];
};

function loadRequestedToolsFromEnv(): string[] | undefined {
    const registry = globalThis as RequestedToolsRegistry;
    const raw = process.env[TOOL_GROUPS_REQUESTED_TOOLS_ENV];
    // Consume the environment to avoid leaking the parent ceiling to children,
    // but retain launch intent across separately loaded /reload generations.
    if (!raw) return registry[REQUESTED_TOOLS_KEY]?.slice();
    delete process.env[TOOL_GROUPS_REQUESTED_TOOLS_ENV];

    try {
        const value: unknown = JSON.parse(raw);
        if (!Array.isArray(value)) return undefined;
        const names = value.filter(
            (name): name is string =>
                typeof name === "string" && name.trim().length > 0,
        );
        registry[REQUESTED_TOOLS_KEY] = [...names];
        return names;
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

/**
 * Build an MCP `mcp:` reference resolver bound to the merged config cache.
 * Returns a function that maps a single `mcp:` reference to concrete tool
 * names, or [] when unresolvable. Non-mcp refs pass through unchanged.
 */
function buildMcpResolver(cwd: string): (ref: string) => string[] {
    return createMcpRefResolver(cwd);
}

const ROLE_TOOL_POLICY_EVENT = "pi-roles:tool-policy";

interface RoleToolPolicy {
    version: 1;
    roleName: string;
    handoffGuard?: string;
    mode: "all" | "set";
    toolNames: string[];
}

function parseRoleToolPolicy(
    value: unknown,
): RoleToolPolicyPayload | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const candidate = value as Partial<RoleToolPolicy>;
    if (
        candidate.version !== 1 ||
        typeof candidate.roleName !== "string" ||
        (candidate.mode !== "all" && candidate.mode !== "set") ||
        !Array.isArray(candidate.toolNames) ||
        !candidate.toolNames.every((name) => typeof name === "string")
    ) {
        return undefined;
    }
    return candidate.mode === "all"
        ? {
              version: 1,
              roleName: candidate.roleName,
              handoffGuard:
                  typeof candidate.handoffGuard === "string"
                      ? candidate.handoffGuard
                      : undefined,
              mode: "all",
              toolNames: [],
          }
        : {
              version: 1,
              roleName: candidate.roleName,
              handoffGuard:
                  typeof candidate.handoffGuard === "string"
                      ? candidate.handoffGuard
                      : undefined,
              mode: "set",
              toolNames: [...candidate.toolNames],
          };
}

export function createToolGroupsExtension(
    loadConfig: (cwd: string) => ToolGroupsConfig = loadToolGroupsConfig,
    loadRequestedTools: () => string[] | undefined = loadRequestedToolsFromEnv,
    loadChildToolPolicy: () =>
        | ToolGroupsChildPolicy
        | undefined = loadChildToolPolicyFromEnv,
): ExtensionFactory {
    return (pi: ExtensionAPI) => {
        const cwd =
            typeof process !== "undefined" && typeof process.cwd === "function"
                ? process.cwd()
                : ".";
        const config = loadConfig(cwd);
        const groups = config.groups;
        const requestedTools = loadRequestedTools();
        const childToolPolicy = loadChildToolPolicy();
        const childAllowedTools = childToolPolicy
            ? new Set(childToolPolicy.allowedTools)
            : undefined;
        const resolveMcp = buildMcpResolver(cwd);

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

        const policy = getToolPolicy();
        const broker = getSharedVisibilityBroker();
        const workflow = registerToolPolicyContribution(
            pi,
            "workflows",
            ({ registered }) => broker.contribution(registered),
        );
        const detach = policy.bind(
            {
                registered: () => pi.getAllTools().map((tool) => tool.name),
                active: () => pi.getActiveTools(),
                apply: (names) => pi.setActiveTools(names),
            },
            {
                groups,
                requested: requestedTools,
                childAllowed: childAllowedTools
                    ? [...childAllowedTools]
                    : undefined,
                resolveMcp,
                onSessionStart: () => broker.resetSession(),
            },
        );
        let lastDiagnosticKey: string | undefined;
        let lastDrift: string | undefined;
        const report = (ctx: ExtensionContext) => {
            const result = policy.refresh();
            if (!result) return;
            const key = diagnosticsKey(result.diagnostics);
            if (key && key !== lastDiagnosticKey)
                ctx.ui.notify(formatDiagnostics(result.diagnostics), "warning");
            lastDiagnosticKey = key;
            const drift = JSON.stringify(result.externalDrift);
            if (result.externalDrift && drift !== lastDrift)
                ctx.ui.notify(
                    "Tool visibility changed outside the coordinator (Plannotator/Pi Lens are not migrated). See /context.",
                    "warning",
                );
            lastDrift = drift;
        };
        const unsubscribe = pi.events.on(ROLE_TOOL_POLICY_EVENT, (payload) => {
            const parsed = parseRoleToolPolicy(payload);
            if (parsed) policy.setRole(parsed);
        });
        pi.on("session_start", (_event, ctx) => {
            policy.beginSession(ctx.sessionManager.getSessionId());
            policy.start();
            report(ctx);
        });
        pi.on("input", (_event, ctx) => {
            report(ctx);
            return { action: "continue" };
        });
        pi.on("before_agent_start", (_event, ctx) => {
            report(ctx);
        });
        pi.on("tool_call", (event) => {
            const result = policy.refresh();
            if (!result || result.names.includes(event.toolName)) return;
            return {
                block: true,
                reason: `Tool "${event.toolName}" is not allowed by ${result.excluded[event.toolName] ?? "active role / workflow tool policy"}.`,
            };
        });
        pi.on("session_shutdown", () => {
            unsubscribe();
            workflow.dispose();
            detach();
        });
        // Keep this last: tool-groups is pinned as the final package and owns
        // the final view of the provider payload after every earlier hook.
        registerProviderCatalogFinalizer(pi);
    };
}

export default createToolGroupsExtension();
