import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createWidget } from "../_shared/fancy-footer.ts";
import { registerToolPolicyContribution } from "../_shared/tool-policy/index.ts";
import {
    BROWSER_TOOLS_WIDGET_ID,
    BROWSER_TOOLS_WIDGET_LABEL,
    renderBrowserToolsWidget,
    type BrowserToolsStatus,
} from "./widget.ts";

const PRIMARY_TOOL = "agent_browser";
const OPTIONAL_SEARCH_TOOL = "agent_browser_web_search";
const MANAGED_TOOLS = [PRIMARY_TOOL, OPTIONAL_SEARCH_TOOL] as const;
const MANAGED_TOOL_SET = new Set<string>(MANAGED_TOOLS);

/** Session entry recording the user's Browser Tools grant for this session. */
const GRANT_ENTRY = "browser-tools:grant";

interface GrantEntryData {
    granted: boolean;
}

/**
 * Session-start reasons that re-apply a grant recorded in this session's
 * entries. `new` and `fork` deliberately start hidden.
 */
const GRANT_RESTORING_REASONS: ReadonlySet<string> = new Set([
    "startup",
    "resume",
    "reload",
]);

/** Read `{ granted }` from an untrusted session entry payload. */
function readGranted(data: unknown): boolean | undefined {
    if (typeof data !== "object" || data === null) return undefined;
    const granted = (data as { granted?: unknown }).granted;
    return typeof granted === "boolean" ? granted : undefined;
}

export default function browserToolsExtension(pi: ExtensionAPI): void {
    let manualGrant = false;
    /**
     * Whether the in-memory grant is authoritative. Stays false until the
     * session's entries yield a grant, so a later input can re-derive it.
     */
    let grantResolved = false;
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

    /** Last grant recorded in this session's transcript, when one exists. */
    function recordedGrant(ctx: ExtensionContext): boolean | undefined {
        let recorded: boolean | undefined;
        for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type !== "custom" || entry.customType !== GRANT_ENTRY) {
                continue;
            }
            const granted = readGranted(entry.data);
            if (granted !== undefined) recorded = granted;
        }
        return recorded;
    }

    /**
     * Re-apply the grant recorded for this session. An empty transcript may
     * simply not be loaded yet, so an absent entry keeps the grant unresolved
     * and the next input retries.
     */
    function restoreGrant(ctx: ExtensionContext): void {
        const recorded = recordedGrant(ctx);
        manualGrant = recorded ?? false;
        grantResolved = recorded !== undefined;
    }

    /** Record and apply a grant change. Only transitions are persisted. */
    function setGrant(granted: boolean): void {
        if (manualGrant !== granted) {
            pi.appendEntry<GrantEntryData>(GRANT_ENTRY, { granted });
        }
        manualGrant = granted;
        grantResolved = true;
        syncVisibility();
    }

    function primaryAvailable(): boolean {
        return pi.getAllTools().some((tool) => tool.name === PRIMARY_TOOL);
    }

    function visibilityStatus(): BrowserToolsStatus {
        if (!primaryAvailable()) return "unavailable";
        if (!manualGrant) return "hidden";
        return pi.getActiveTools().includes(PRIMARY_TOOL)
            ? "manual"
            : "manual (restricted)";
    }

    const widget = createWidget(pi, {
        id: BROWSER_TOOLS_WIDGET_ID,
        label: BROWSER_TOOLS_WIDGET_LABEL,
        description:
            "Shows whether Agent Browser is available to the model in this session.",
        row: 2,
        order: 3,
        align: "left",
        styled: true,
        render: (rctx) =>
            renderBrowserToolsWidget(rctx.theme, visibilityStatus()),
    });

    /**
     * Refresh the footer widget. The fallback text also feeds a non-fancy-footer
     * setup, where `createWidget` renders through ctx.ui.setWidget.
     */
    function pushWidget(ctx: ExtensionContext): void {
        widget.update(
            ctx,
            renderBrowserToolsWidget(ctx.ui?.theme, visibilityStatus()),
        );
    }

    pi.registerCommand("browser-tools", {
        description: "Temporarily show or hide Agent Browser for this session",
        handler: async (args, ctx) => {
            const action = args.trim() || "status";
            if (action === "on") {
                if (!primaryAvailable()) {
                    // Revoke a previous grant immediately: the native tool can
                    // disappear while a grant is still reflected in the policy.
                    setGrant(false);
                    pushWidget(ctx);
                    ctx.ui.notify("Browser tools: unavailable", "warning");
                    return;
                }
                setGrant(true);
            } else if (action === "off") {
                setGrant(false);
            } else if (action !== "status") {
                ctx.ui.notify(
                    "Usage: /browser-tools [on|off|status]",
                    "warning",
                );
                return;
            }
            pushWidget(ctx);
            ctx.ui.notify(`Browser tools: ${visibilityStatus()}`, "info");
        },
    });

    /**
     * Reconcile visibility before a turn. While the grant is still unresolved,
     * this is the retry point for a transcript that loaded late.
     */
    function refreshForTurn(ctx: ExtensionContext): void {
        if (!grantResolved) restoreGrant(ctx);
        syncVisibility();
        pushWidget(ctx);
    }

    pi.on("session_start", (event, ctx) => {
        manualGrant = false;
        if (GRANT_RESTORING_REASONS.has(event.reason)) {
            restoreGrant(ctx);
        } else {
            grantResolved = true;
        }
        syncVisibility();
        pushWidget(ctx);
    });

    pi.on("input", (_event, ctx) => {
        refreshForTurn(ctx);
        return { action: "continue" as const };
    });

    pi.on("before_agent_start", (_event, ctx) => {
        refreshForTurn(ctx);
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

    pi.on("session_shutdown", (_event, ctx) => {
        manualGrant = false;
        grantResolved = false;
        widget.remove(ctx);
        visibility.dispose();
    });
}
