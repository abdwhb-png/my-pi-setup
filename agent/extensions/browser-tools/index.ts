import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createWidget } from "../_shared/fancy-footer.ts";
import { registerToolPolicyContribution } from "../_shared/tool-policy/index.ts";
import { loadBrowserToolsConfig } from "./config.ts";
import {
    BROWSER_TOOLS_WIDGET_ID,
    BROWSER_TOOLS_WIDGET_LABEL,
    renderBrowserToolsWidget,
    type BrowserToolsStatus,
} from "./widget.ts";

const PRIMARY_TOOL = "agent_browser";
const BROWSER_NAMESPACE = "browser";

/** Session entry recording the user's Browser Tools grant for this session. */
const GRANT_ENTRY = "browser-tools:grant";

interface GrantEntryData {
    granted: boolean | null;
}

/**
 * Session-start reasons that re-apply a grant recorded in this session's
 * entries. `new` and `fork` resolve the configured default instead.
 */
const GRANT_RESTORING_REASONS: ReadonlySet<string> = new Set([
    "startup",
    "resume",
    "reload",
]);

/** Read `{ granted }` from an untrusted session entry payload. */
function readGranted(data: unknown): boolean | null | undefined {
    if (typeof data !== "object" || data === null) return undefined;
    const granted = (data as { granted?: unknown }).granted;
    return typeof granted === "boolean" || granted === null
        ? granted
        : undefined;
}

export default function browserToolsExtension(pi: ExtensionAPI): void {
    let sessionOverride: boolean | null = null;
    let configured = false;
    const enabled = () => sessionOverride ?? configured;
    /**
     * Whether the in-memory grant is authoritative. Stays false until the
     * session's entries yield a grant, so a later input can re-derive it.
     */
    let grantResolved = false;
    const visibility = registerToolPolicyContribution(
        pi,
        "browser-tools",
        ({ registered }) => {
            const available = registered.some(
                (tool) => tool.name === PRIMARY_TOOL,
            );
            const names = registered
                .filter((tool) => tool.namespace?.name === BROWSER_NAMESPACE)
                .map((tool) => tool.name);
            if (!enabled() || !available) return { deny: names };
            return sessionOverride === true
                ? { grants: names }
                : { defaults: names };
        },
    );

    function syncVisibility(): void {
        visibility.refresh();
    }

    /** Last grant recorded in this session's transcript, when one exists. */
    function recordedGrant(ctx: ExtensionContext): boolean | null | undefined {
        let recorded: boolean | null | undefined;
        for (const entry of ctx.sessionManager.getBranch()) {
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
        sessionOverride = recorded ?? null;
        grantResolved = recorded !== undefined;
    }

    /** Persist explicit choices separately from the configured default. */
    function setGrant(granted: boolean): void {
        if (sessionOverride !== granted) {
            pi.appendEntry<GrantEntryData>(GRANT_ENTRY, { granted });
        }
        sessionOverride = granted;
        grantResolved = true;
        syncVisibility();
    }

    function primaryAvailable(): boolean {
        return pi.getAllTools().some((tool) => tool.name === PRIMARY_TOOL);
    }

    function visibilityStatus(): BrowserToolsStatus {
        if (!primaryAvailable()) return "unavailable";
        if (!enabled()) return "hidden";
        const source = sessionOverride === true ? "manual" : "configured";
        const active = new Set(pi.getActiveTools());
        return pi
            .getAllTools()
            .some(
                (tool) =>
                    tool.namespace?.name === BROWSER_NAMESPACE &&
                    active.has(tool.name),
            )
            ? source
            : `${source} (restricted)`;
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
        configured = false;
        try {
            configured = loadBrowserToolsConfig(
                ctx.cwd,
                ctx.isProjectTrusted(),
            ).enabledByDefault;
        } catch (error) {
            ctx.ui.notify(
                `Browser tools configuration: ${error instanceof Error ? error.message : String(error)}`,
                "error",
            );
        }
        sessionOverride = null;
        if (GRANT_RESTORING_REASONS.has(event.reason)) {
            restoreGrant(ctx);
        } else {
            pi.appendEntry<GrantEntryData>(GRANT_ENTRY, { granted: null });
            grantResolved = true;
        }
        syncVisibility();
        pushWidget(ctx);
    });

    pi.on("input", (_event, ctx) => {
        refreshForTurn(ctx);
        return { action: "continue" as const };
    });

    // Later session_start handlers may register optional native browser tools.
    pi.on("resources_discover", (_event, ctx) => {
        syncVisibility();
        pushWidget(ctx);
    });

    pi.on("before_agent_start", (_event, ctx) => {
        refreshForTurn(ctx);
    });

    pi.on("tool_call", (event) => {
        if (
            !pi
                .getAllTools()
                .some(
                    (tool) =>
                        tool.name === event.toolName &&
                        tool.namespace?.name === BROWSER_NAMESPACE,
                )
        )
            return undefined;
        if (!enabled())
            return {
                block: true as const,
                reason: "Agent Browser is hidden. Ask the user to run /browser-tools on.",
            };
        if (!pi.getActiveTools().includes(event.toolName))
            return {
                block: true as const,
                reason: "Agent Browser is restricted by the current tool policy.",
            };
        return undefined;
    });

    pi.on("session_shutdown", (_event, ctx) => {
        sessionOverride = null;
        configured = false;
        grantResolved = false;
        widget.remove(ctx);
        visibility.dispose();
    });
}
