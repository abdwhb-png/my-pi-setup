import type {
    ExtensionAPI,
    ExtensionContext,
    ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createMcpRefResolver } from "pi-mcp-adapter";
import { getSharedVisibilityBroker } from "../_shared/tool-groups/broker.ts";
import { loadToolGroupsConfig } from "../_shared/tool-groups/config.ts";
import { isToolGroupsPackageLast } from "../_shared/tool-groups/package-order.ts";
import { resolveToolAliases } from "../_shared/tool-groups/resolver.ts";
import {
    SUBAGENT_EXTENSION_BINDINGS_ENV,
    TOOL_GROUP_PREFIX,
    TOOL_GROUPS_CHILD_POLICY_BINDING,
    TOOL_GROUPS_REQUESTED_TOOLS_ENV,
    type ToolGroupsChildPolicy,
    type ToolGroupsConfig,
    type ToolGroupDiagnostic,
} from "../_shared/tool-groups/types.ts";

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
    return createMcpRefResolver(cwd);
}

const ROLE_TOOL_POLICY_EVENT = "pi-roles:tool-policy";

interface RoleToolPolicy {
    version: 1;
    roleName: string;
    mode: "all" | "set";
    toolNames: string[];
}

function parseRoleToolPolicy(value: unknown): RoleToolPolicy | undefined {
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
    return {
        version: 1,
        roleName: candidate.roleName,
        mode: candidate.mode,
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

        if (
            Object.keys(groups).length === 0 &&
            !requestedTools?.length &&
            !childToolPolicy
        ) {
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
        let cliToolPolicy: string[] | undefined;
        let roleToolPolicy: RoleToolPolicy | undefined;

        const unsubscribeRoleToolPolicy = pi.events.on(
            ROLE_TOOL_POLICY_EVENT,
            (payload) => {
                const parsed = parseRoleToolPolicy(payload);
                if (parsed) {
                    roleToolPolicy = parsed;
                    expandAliases(undefined);
                    enforceConfiguredPolicy();
                }
            },
        );

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

            const candidates = requested.names.filter(
                (name) =>
                    allowedNames.has(name) &&
                    (!childAllowedTools || childAllowedTools.has(name)),
            );
            // Workflow-group members are only visible while their workflow owns
            // the session; the broker strips them otherwise (sole chokepoint).
            const reconciled = getSharedVisibilityBroker().reconcileWithLease(
                pi,
                candidates,
            );
            cliToolPolicy = [...reconciled];
            pi.setActiveTools(reconciled);
            reportDiagnostics(requested.diagnostics, ctx);
        }

        function expandAliases(
            _event: unknown,
            ctx?: ExtensionContext,
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

            const reconciled = getSharedVisibilityBroker().reconcileWithLease(
                pi,
                result.names,
            );
            pi.setActiveTools(reconciled);

            if (ctx) reportDiagnostics(result.diagnostics, ctx);
        }

        /**
         * Workflow visibility guard that runs unconditionally, not just when the
         * active set holds @aliases. Strips workflow-group members (brainstorm_*,
         * sdd_*) unless their workflow holds the lease. Without this, those tools
         * stay in the active list after a reload because no alias is present to
         * trigger expandAliases.
         */
        function resolveConfiguredPolicy():
            | {
                  names: string[];
                  diagnostics: ToolGroupDiagnostic[];
              }
            | undefined {
            const allToolNames = pi.getAllTools().map((tool) => tool.name);
            const diagnostics: ToolGroupDiagnostic[] = [];
            let names: string[] | undefined;

            if (roleToolPolicy?.mode === "set") {
                const resolvedRole = resolveToolAliases(
                    roleToolPolicy.toolNames,
                    allToolNames,
                    groups,
                    resolveMcp,
                );
                names = resolvedRole.names;
                diagnostics.push(...resolvedRole.diagnostics);
            }

            let cliAllowed: Set<string> | undefined;
            if (cliToolPolicy) {
                cliAllowed = new Set(cliToolPolicy);
                names = names
                    ? names.filter((name) => cliAllowed!.has(name))
                    : [...cliToolPolicy];
            }

            if (childAllowedTools) {
                if (!names) {
                    const resolvedActive = resolveToolAliases(
                        pi.getActiveTools(),
                        allToolNames,
                        groups,
                        resolveMcp,
                    );
                    names = resolvedActive.names;
                    diagnostics.push(...resolvedActive.diagnostics);
                }
                names = names.filter((name) => childAllowedTools.has(name));
            }

            if (!names) return undefined;

            const broker = getSharedVisibilityBroker();
            const activeWorkflow = broker.getActiveWorkflow(pi);
            if (activeWorkflow) {
                for (const name of pi.getActiveTools()) {
                    if (
                        broker.isMemberOf(activeWorkflow, name) &&
                        (!cliAllowed || cliAllowed.has(name)) &&
                        (!childAllowedTools || childAllowedTools.has(name)) &&
                        !names.includes(name)
                    ) {
                        names.push(name);
                    }
                }
            }

            return {
                names: broker.reconcileWithLease(pi, names),
                diagnostics,
            };
        }

        function enforceConfiguredPolicy(ctx?: ExtensionContext): void {
            const policy = resolveConfiguredPolicy();
            if (!policy) return;
            const active = pi.getActiveTools();
            if (
                policy.names.length !== active.length ||
                policy.names.some((name, index) => name !== active[index])
            ) {
                pi.setActiveTools(policy.names);
            }
            if (ctx) reportDiagnostics(policy.diagnostics, ctx);
        }

        function reconcileWorkflowVisibility(): void {
            const active = pi.getActiveTools();
            const reconciled = getSharedVisibilityBroker().reconcileWithLease(
                pi,
                active,
            );
            if (
                reconciled.length !== active.length ||
                reconciled.some((n, i) => n !== active[i])
            ) {
                pi.setActiveTools(reconciled);
            }
        }

        pi.on("session_start", (event, ctx) => {
            applyRequestedTools(ctx);
            expandAliases(event, ctx);
            enforceConfiguredPolicy(ctx);
            reconcileWorkflowVisibility();
            checkToolGroupsPackageOrder(cwd);
        });

        pi.on("input", (event, ctx) => {
            expandAliases(event, ctx);
            enforceConfiguredPolicy(ctx);
            reconcileWorkflowVisibility();
            return { action: "continue" as const };
        });

        pi.on("before_agent_start", (event, ctx) => {
            expandAliases(event, ctx);
            enforceConfiguredPolicy(ctx);
            reconcileWorkflowVisibility();
        });

        pi.on("tool_call", (event) => {
            const policy = resolveConfiguredPolicy();
            if (!policy || policy.names.includes(event.toolName)) {
                return undefined;
            }
            if (!roleToolPolicy && childAllowedTools) {
                return {
                    block: true as const,
                    reason: `Tool "${event.toolName}" is not allowed by child tool policy.`,
                };
            }
            const roleName = roleToolPolicy?.roleName ?? "CLI tool policy";
            return {
                block: true as const,
                reason: `Tool "${event.toolName}" is not allowed by active role "${roleName}".`,
            };
        });

        pi.on("session_shutdown", () => {
            unsubscribeRoleToolPolicy();
            roleToolPolicy = undefined;
            cliToolPolicy = undefined;
        });
    };
}

export default createToolGroupsExtension();
