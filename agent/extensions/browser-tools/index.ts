import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentBrowserExtension from "pi-agent-browser-native/dist/extensions/agent-browser/index.js";
import { registerToolPolicyContribution } from "../_shared/tool-policy/index.ts";

const PRIMARY_TOOL = "agent_browser";
const OPTIONAL_SEARCH_TOOL = "agent_browser_web_search";
const MANAGED_TOOLS = [PRIMARY_TOOL, OPTIONAL_SEARCH_TOOL] as const;
const MANAGED_TOOL_SET = new Set<string>(MANAGED_TOOLS);

export default function browserToolsExtension(pi: ExtensionAPI): void {
    agentBrowserExtension(pi);

    let manualGrant = false;
    const visibility = registerToolPolicyContribution(
        pi,
        "browser-tools",
        ({ registered }) => {
            const available = registered.includes(PRIMARY_TOOL);
            return manualGrant && available
                ? { grants: [PRIMARY_TOOL], deny: [OPTIONAL_SEARCH_TOOL] }
                : { deny: MANAGED_TOOLS };
        },
    );

    function syncVisibility(): void {
        visibility.refresh();
    }

    function primaryAvailable(): boolean {
        return pi.getAllTools().some((tool) => tool.name === PRIMARY_TOOL);
    }

    function visibilityStatus():
        | "hidden"
        | "manual"
        | "manual (restricted)"
        | "unavailable" {
        if (!primaryAvailable()) return "unavailable";
        if (!manualGrant) return "hidden";
        return pi.getActiveTools().includes(PRIMARY_TOOL)
            ? "manual"
            : "manual (restricted)";
    }

    pi.registerCommand("browser-tools", {
        description: "Temporarily show or hide Agent Browser for this session",
        handler: async (args, ctx) => {
            const action = args.trim() || "status";
            if (action === "on") {
                if (!primaryAvailable()) {
                    manualGrant = false;
                    ctx.ui.notify("Browser tools: unavailable", "warning");
                    return;
                }
                manualGrant = true;
                syncVisibility();
            } else if (action === "off") {
                manualGrant = false;
                syncVisibility();
            } else if (action !== "status") {
                ctx.ui.notify(
                    "Usage: /browser-tools [on|off|status]",
                    "warning",
                );
                return;
            }
            ctx.ui.notify(`Browser tools: ${visibilityStatus()}`, "info");
        },
    });

    pi.on("session_start", () => {
        manualGrant = false;
        syncVisibility();
    });

    pi.on("input", () => {
        syncVisibility();
        return { action: "continue" as const };
    });

    pi.on("before_agent_start", () => {
        syncVisibility();
    });

    pi.on("tool_call", (event) => {
        if (!MANAGED_TOOL_SET.has(event.toolName)) return undefined;
        if (event.toolName === OPTIONAL_SEARCH_TOOL) {
            return {
                block: true as const,
                reason: "Agent Browser Web Search is not enabled by browser-tools.",
            };
        }
        if (manualGrant) return undefined;
        return {
            block: true as const,
            reason: "Agent Browser is hidden. Ask the user to run /browser-tools on.",
        };
    });

    pi.on("session_shutdown", () => {
        manualGrant = false;
        visibility.dispose();
    });
}
