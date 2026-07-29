/**
 * Session Status Bar Extension
 *
 * Renders a compact session status line as six independently-positioned
 * pi-fancy-footer widgets: cwd / branch / session-name on the left,
 * context / cost / model on the right. The footer's layout engine handles
 * alignment and spacing; this extension only builds state and declares where
 * each segment sits (align + order + placement).
 *
 * Pure rendering lives in ./_shared/status-segments.ts (unit-tested).
 *
 * Config: ~/.pi/agent/session-status-bar.json
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
    SessionEntry,
    SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createWidget, getSessionUsageMetrics } from "./_shared/fancy-footer";
import { getBranch } from "./_shared/git-helper";
import {
    type StatusBarState,
    type StatusBarColors,
    shortenMiddle,
    renderCwd,
    renderBranch,
    renderSessionName,
    renderContext,
    renderCost,
    renderModel,
} from "./_shared/status-segments";
import { createUiColors } from "./_shared/ui/ui-colors";

const WIDGET_ID = "session-status-bar";
const DEFAULT_REFRESH_MS = 3000;
const MAX_BRANCH_WIDTH = 18;

type StatusBarConfig = {
    enabled: boolean;
    showContext: boolean;
    showCost: boolean;
    showModel: boolean;
    showCwd: boolean;
    showBranch: boolean;
    showSessionName: boolean;
    refreshMs: number;
};

const DEFAULT_CONFIG: StatusBarConfig = {
    enabled: true,
    showContext: true,
    showCost: true,
    showModel: true,
    showCwd: true,
    showBranch: true,
    showSessionName: true,
    refreshMs: DEFAULT_REFRESH_MS,
};

type FooterAlign = "left" | "right";

type SegmentDef = {
    id: string;
    label: string;
    align: FooterAlign;
    order: number;
    show: (c: StatusBarConfig) => boolean;
    render: (s: StatusBarState, w: number, c: StatusBarColors) => string;
};

const SEGMENTS: readonly SegmentDef[] = [
    {
        id: `${WIDGET_ID}.cwd`,
        label: "Cwd",
        align: "left",
        order: 0,
        show: (c) => c.showCwd,
        render: renderCwd,
    },
    {
        id: `${WIDGET_ID}.branch`,
        label: "Branch",
        align: "left",
        order: 1,
        show: (c) => c.showBranch,
        render: renderBranch,
    },
    {
        id: `${WIDGET_ID}.session`,
        label: "Session",
        align: "left",
        order: 2,
        show: (c) => c.showSessionName,
        render: renderSessionName,
    },
    {
        id: `${WIDGET_ID}.context`,
        label: "Context",
        align: "right",
        order: 0,
        show: (c) => c.showContext,
        render: renderContext,
    },
    {
        id: `${WIDGET_ID}.cost`,
        label: "Cost",
        align: "right",
        order: 1,
        show: (c) => c.showCost,
        render: renderCost,
    },
    {
        id: `${WIDGET_ID}.model`,
        label: "Model",
        align: "right",
        order: 2,
        show: (c) => c.showModel,
        render: renderModel,
    },
];

function getConfigPath(): string {
    return join(getAgentDir(), "session-status-bar.json");
}

function loadConfig(): StatusBarConfig {
    const path = getConfigPath();
    if (!existsSync(path)) return { ...DEFAULT_CONFIG };
    try {
        const raw = JSON.parse(
            readFileSync(path, "utf-8"),
        ) as Partial<StatusBarConfig>;
        return { ...DEFAULT_CONFIG, ...raw };
    } catch {
        return { ...DEFAULT_CONFIG };
    }
}

function isSessionMessageEntry(e: SessionEntry): e is SessionMessageEntry {
    return e.type === "message";
}

function buildState(
    ctx: ExtensionContext,
    branchName: string | null,
    config: StatusBarConfig,
): StatusBarState {
    const messages = ctx.sessionManager
        .getBranch()
        .filter(isSessionMessageEntry)
        .map((e) => e.message as AssistantMessage)
        .filter((m) => m.role === "assistant" && m.stopReason !== "aborted");

    const lastMessage = messages[messages.length - 1];
    const totalUsd = messages.reduce(
        (sum, m) => sum + (m.usage?.cost?.total ?? 0),
        0,
    );

    const contextTokens = lastMessage?.usage
        ? lastMessage.usage.input +
          lastMessage.usage.output +
          lastMessage.usage.cacheRead +
          lastMessage.usage.cacheWrite
        : 0;
    const contextWindow = ctx.model?.contextWindow || 0;
    const percent =
        contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;

    const cwd = ctx.cwd;
    const home = process.env.HOME || "";
    const shortCwd =
        home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;

    const branch = config.showBranch ? branchName : null;
    const shortBranch = branch ? shortenMiddle(branch, MAX_BRANCH_WIDTH) : "";

    return {
        workspace: { shortCwd, shortBranch },
        context: { tokens: contextTokens, window: contextWindow, percent },
        model: {
            id: ctx.model?.id || "no-model",
            provider: ctx.model?.provider,
        },
        session: { name: ctx.sessionManager.getSessionName() },
        cost: { totalUsd },
    };
}

function tryBuildStateFromBridge(
    ctx: ExtensionContext,
    branchName: string | null,
    config: StatusBarConfig,
): StatusBarState | undefined {
    try {
        const metrics = getSessionUsageMetrics(ctx);
        const contextTokens = metrics.latest
            ? metrics.latest.input +
              metrics.latest.output +
              metrics.latest.cacheRead +
              metrics.latest.cacheWrite
            : 0;
        const contextWindow = ctx.model?.contextWindow || 0;
        const percent =
            contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;

        const cwd = ctx.cwd;
        const home = process.env.HOME || "";
        const shortCwd =
            home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;

        const branch = config.showBranch ? branchName : null;
        const shortBranch = branch
            ? shortenMiddle(branch, MAX_BRANCH_WIDTH)
            : "";

        return {
            workspace: { shortCwd, shortBranch },
            context: { tokens: contextTokens, window: contextWindow, percent },
            model: {
                id: ctx.model?.id || "no-model",
                provider: ctx.model?.provider,
            },
            session: { name: ctx.sessionManager.getSessionName() },
            cost: { totalUsd: metrics.totalCost },
        };
    } catch {
        return undefined;
    }
}

/**
 * Fallback line for the non-fancy-footer path (pi's native setWidget).
 * Joins the visible left and right segments with a space pad between groups,
 * mirroring the footer's own left/right layout.
 */
function buildFallbackLine(
    state: StatusBarState,
    width: number,
    config: StatusBarConfig,
    colors: StatusBarColors,
): string {
    const renderGroup = (align: FooterAlign): string => {
        const parts = SEGMENTS.filter(
            (s) => s.align === align && s.show(config),
        )
            .map((s) => s.render(state, width, colors))
            .filter((t) => visibleWidth(t) > 0);
        return parts.join(" ");
    };
    const left = renderGroup("left");
    const right = renderGroup("right");
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    return `${left}${" ".repeat(gap)}${right}`;
}

export default function (pi: ExtensionAPI) {
    let config = DEFAULT_CONFIG;
    let latestCtx: ExtensionContext | null = null;
    let latestState: StatusBarState | null = null;
    let refreshTimer: ReturnType<typeof setInterval> | null = null;

    const widgets = SEGMENTS.map((seg) =>
        createWidget(pi, {
            id: seg.id,
            label: seg.label,
            description: `${seg.label} segment of the session status bar.`,
            row: 0,
            order: seg.order,
            align: seg.align,
            placement: "belowEditor",
            // Gated by config: empty render collapses the widget (footer drops it).
            render: (ctx, availableWidth) => {
                if (!latestState || !seg.show(config)) return "";
                const colors = createUiColors(ctx.theme);
                return seg.render(
                    latestState,
                    availableWidth ?? ctx.width,
                    colors,
                );
            },
        }),
    );

    async function refreshState(ctx: ExtensionContext): Promise<void> {
        config = loadConfig();
        if (!config.enabled) {
            latestState = null;
            return;
        }
        const branchName = await getBranch(ctx.cwd).catch(() => null);
        latestState =
            tryBuildStateFromBridge(ctx, branchName, config) ??
            buildState(ctx, branchName, config);
    }

    async function updateWidget(): Promise<void> {
        if (!latestCtx?.hasUI) return;
        try {
            await refreshState(latestCtx);
            const width = process.stdout.columns || 120;
            const colors = createUiColors(latestCtx.ui.theme);
            const fallbackText = latestState
                ? buildFallbackLine(latestState, width, config, colors)
                : colors.warning("Session Status Bar disabled in config");
            for (const w of widgets) w.update(latestCtx, fallbackText);
        } catch {
            // leave previous render in place
        }
    }

    pi.on("session_start", async (_event, ctx) => {
        latestCtx = ctx;
        await updateWidget();
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = setInterval(updateWidget, config.refreshMs);
    });

    pi.on("agent_end", async (_event, ctx) => {
        latestCtx = ctx;
        await updateWidget();
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }
        latestCtx = null;
        latestState = null;
        for (const w of widgets) w.remove(ctx);
    });
}
