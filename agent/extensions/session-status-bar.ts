import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse, relative, sep } from "node:path";
import { loadExtensionConfig } from "./_shared/config-loader.ts";
/**
 * Session Status Bar Extension
 *
 * Renders a compact session status line as seven independently-positioned
 * pi-fancy-footer widgets: cwd / branch / session-name on the left,
 * context / tokens / cost / model on the right. The footer's layout engine handles
 * alignment and spacing; this extension only builds state and declares where
 * each segment sits (align + order + placement).
 *
 * Pure rendering lives in ./_shared/status-segments.ts (unit-tested).
 *
 * Config: ~/.pi/agent/config/session-status-bar.json
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
    SessionEntry,
    SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

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
    renderTokenCounts,
    renderCost,
    renderModel,
} from "./_shared/status-segments";
import { createUiColors } from "./_shared/ui/ui-colors";

const WIDGET_ID = "session-status-bar";
const DEFAULT_REFRESH_MS = 3000;
const MAX_BRANCH_WIDTH = 18;
const CWD_CACHE_MS = 30_000;
const PATH_ANCHORS = new Set([
    ".git",
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "composer.json",
]);

type CwdDisplay = { shortCwd: string; compactCwd: string };

async function directoryEntries(path: string) {
    try {
        return await readdir(path, { withFileTypes: true });
    } catch (error) {
        if (
            error instanceof Error &&
            "code" in error &&
            ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(
                String(error.code),
            )
        ) {
            // Keep full segments when uniqueness cannot be established safely.
            return undefined;
        }
        throw error;
    }
}

async function prepareCwd(cwd: string): Promise<CwdDisplay> {
    const home = homedir();
    const inHome = cwd === home || cwd.startsWith(home + sep);
    const root = inHome ? home : parse(cwd).root;
    const parts = relative(root, cwd).split(sep).filter(Boolean);
    const parentPaths: string[] = [];
    let parent = root;
    for (const part of parts) {
        parentPaths.push(parent);
        parent = join(parent, part);
    }
    const directories = await Promise.all(parentPaths.map(directoryEntries));
    const compact: string[] = [];
    for (const [index, part] of parts.entries()) {
        const siblings = directories[index];
        const children = directories[index + 1];
        let short = part;
        if (
            siblings &&
            children &&
            !children.some((entry) => PATH_ANCHORS.has(entry.name))
        ) {
            const names = siblings
                .filter(
                    (entry) => entry.isDirectory() || entry.isSymbolicLink(),
                )
                .map((entry) => entry.name);
            let prefix = "";
            for (const character of part) {
                prefix += character;
                if (
                    !names.some(
                        (name) => name !== part && name.startsWith(prefix),
                    )
                ) {
                    short = prefix;
                    break;
                }
            }
        }
        compact.push(short);
    }
    const prefix = inHome ? "~" : root.replaceAll(sep, "/");
    const display = (segments: string[]) =>
        prefix +
        (segments.length && !prefix.endsWith("/") ? "/" : "") +
        segments.join("/");
    return { shortCwd: display(parts), compactCwd: display(compact) };
}

type StatusBarConfig = {
    enabled: boolean;
    showContext: boolean;
    showTokenCounts: boolean;
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
    showTokenCounts: true,
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
        id: `${WIDGET_ID}.tokens`,
        label: "Tokens",
        align: "right",
        order: 1,
        show: (c) => c.showTokenCounts,
        render: renderTokenCounts,
    },
    {
        id: `${WIDGET_ID}.cost`,
        label: "Cost",
        align: "right",
        order: 2,
        show: (c) => c.showCost,
        render: renderCost,
    },
    {
        id: `${WIDGET_ID}.model`,
        label: "Model",
        align: "right",
        order: 3,
        show: (c) => c.showModel,
        render: renderModel,
    },
];

function loadConfig(cwd: string): StatusBarConfig {
    return loadExtensionConfig(cwd, {
        owner: "sessionStatusBar",
        defaults: DEFAULT_CONFIG,
        normalize: (raw) => raw as Partial<StatusBarConfig>,
    });
}

function isSessionMessageEntry(e: SessionEntry): e is SessionMessageEntry {
    return e.type === "message";
}

function buildState(
    ctx: ExtensionContext,
    branchName: string | null,
    config: StatusBarConfig,
    cwdDisplay: CwdDisplay,
    sessionLabel: string,
): StatusBarState {
    const messages = ctx.sessionManager
        .getBranch()
        .filter(isSessionMessageEntry)
        .map((e) => e.message as AssistantMessage)
        .filter((m) => m.role === "assistant" && m.stopReason !== "aborted");

    const lastMessage = messages[messages.length - 1];
    const totals = messages.reduce(
        (sum, message) => {
            const usage = message.usage;
            return {
                input: sum.input + (usage?.input ?? 0),
                output: sum.output + (usage?.output ?? 0),
                cacheRead: sum.cacheRead + (usage?.cacheRead ?? 0),
                cacheWrite: sum.cacheWrite + (usage?.cacheWrite ?? 0),
                cost: sum.cost + (usage?.cost?.total ?? 0),
            };
        },
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    );

    const lastUsage = lastMessage?.usage;
    const contextTokens = lastUsage
        ? lastUsage.input +
          lastUsage.output +
          lastUsage.cacheRead +
          lastUsage.cacheWrite
        : 0;
    const contextWindow = ctx.model?.contextWindow || 0;
    const percent =
        contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;

    const branch = config.showBranch ? branchName : null;
    const shortBranch = branch ? shortenMiddle(branch, MAX_BRANCH_WIDTH) : "";

    return {
        workspace: { ...cwdDisplay, shortBranch },
        context: { tokens: contextTokens, window: contextWindow, percent },
        model: {
            id: ctx.model?.id || "no-model",
            provider: ctx.model?.provider,
        },
        session: { name: sessionLabel },
        cost: { totalUsd: totals.cost },
        tokens: {
            input: totals.input,
            output: totals.output,
            cacheRead: totals.cacheRead,
            cacheWrite: totals.cacheWrite,
        },
    };
}

function tryBuildStateFromBridge(
    ctx: ExtensionContext,
    branchName: string | null,
    config: StatusBarConfig,
    cwdDisplay: CwdDisplay,
    sessionLabel: string,
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

        const branch = config.showBranch ? branchName : null;
        const shortBranch = branch
            ? shortenMiddle(branch, MAX_BRANCH_WIDTH)
            : "";

        return {
            workspace: { ...cwdDisplay, shortBranch },
            context: { tokens: contextTokens, window: contextWindow, percent },
            model: {
                id: ctx.model?.id || "no-model",
                provider: ctx.model?.provider,
            },
            session: { name: sessionLabel },
            cost: { totalUsd: metrics.totalCost },
            tokens: {
                input: metrics.total.input,
                output: metrics.total.output,
                cacheRead: metrics.total.cacheRead,
                cacheWrite: metrics.total.cacheWrite,
            },
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
    let messageTimer: ReturnType<typeof setTimeout> | undefined;
    let firstUserText: string | undefined;
    let cwdCache:
        | { cwd: string; expiresAt: number; display: CwdDisplay }
        | undefined;
    let refreshSequence = 0;
    let lastError: string | undefined;

    function sessionLabel(ctx: ExtensionContext): string {
        const name = ctx.sessionManager.getSessionName();
        if (name !== undefined) return name;
        if (firstUserText === undefined) {
            // /resume uses the first user text across the file, not only the active branch.
            for (const entry of ctx.sessionManager.getEntries()) {
                if (entry.type !== "message" || entry.message.role !== "user")
                    continue;
                const content = entry.message.content;
                const text =
                    typeof content === "string"
                        ? content
                        : content
                              .flatMap((block) =>
                                  block.type === "text" ? [block.text] : [],
                              )
                              .join(" ");
                if (text) {
                    firstUserText = text;
                    break;
                }
            }
        }
        return firstUserText ?? "(no messages)";
    }

    function updateSessionLabel(ctx: ExtensionContext): void {
        if (!latestState) return;
        latestState.session.name = sessionLabel(ctx);
        redrawWidgets(ctx);
    }

    const widgets = SEGMENTS.map((seg) =>
        createWidget(pi, {
            id: seg.id,
            label: seg.label,
            description: `${seg.label} segment of the session status bar.`,
            row: 0,
            order: seg.order,
            align: seg.align,
            placement: "belowEditor",
            styled: true,
            grow:
                seg.id === `${WIDGET_ID}.cwd` ||
                seg.id === `${WIDGET_ID}.session`,
            minWidth: 12,
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

    function redrawWidgets(ctx: ExtensionContext): void {
        if (!ctx.hasUI) return;
        const width = process.stdout.columns || 120;
        const colors = createUiColors(ctx.ui.theme);
        const fallbackText = latestState
            ? buildFallbackLine(latestState, width, config, colors)
            : colors.warning("Session Status Bar disabled in config");
        for (const widget of widgets) widget.update(ctx, fallbackText);
    }

    async function updateWidget(): Promise<void> {
        const ctx = latestCtx;
        if (!ctx?.hasUI) return;
        const sequence = ++refreshSequence;
        try {
            config = loadConfig(ctx.cwd);
            const branchName = config.showBranch
                ? await getBranch(ctx.cwd).catch(() => null)
                : null;
            if (
                !cwdCache ||
                cwdCache.cwd !== ctx.cwd ||
                cwdCache.expiresAt <= Date.now()
            ) {
                const display = await prepareCwd(ctx.cwd);
                cwdCache = {
                    cwd: ctx.cwd,
                    display,
                    expiresAt: Date.now() + CWD_CACHE_MS,
                };
            }
            if (sequence !== refreshSequence) return;
            const label = sessionLabel(ctx);
            latestState = config.enabled
                ? (tryBuildStateFromBridge(
                      ctx,
                      branchName,
                      config,
                      cwdCache.display,
                      label,
                  ) ??
                  buildState(ctx, branchName, config, cwdCache.display, label))
                : null;
            redrawWidgets(ctx);
            lastError = undefined;
        } catch (error) {
            if (sequence !== refreshSequence) return;
            const message =
                error instanceof Error ? error.message : String(error);
            if (message !== lastError) {
                ctx.ui.notify(
                    `Session status bar refresh failed: ${message}`,
                    "warning",
                );
                lastError = message;
            }
        }
    }

    pi.on("session_start", async (_event, ctx) => {
        latestCtx = ctx;
        firstUserText = undefined;
        cwdCache = undefined;
        if (messageTimer !== undefined) clearTimeout(messageTimer);
        await updateWidget();
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = setInterval(updateWidget, config.refreshMs);
    });

    pi.on("session_info_changed", (_event, ctx) => {
        latestCtx = ctx;
        updateSessionLabel(ctx);
    });

    pi.on("message_end", (event, ctx) => {
        if (event.message.role !== "user" || firstUserText !== undefined)
            return;
        latestCtx = ctx;
        if (messageTimer !== undefined) clearTimeout(messageTimer);
        // message_end precedes Pi's appendMessage; read the persisted entry on the next tick.
        messageTimer = setTimeout(() => {
            messageTimer = undefined;
            if (latestCtx) updateSessionLabel(latestCtx);
        }, 0);
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
        refreshSequence++;
        if (messageTimer !== undefined) clearTimeout(messageTimer);
        messageTimer = undefined;
        latestCtx = null;
        latestState = null;
        firstUserText = undefined;
        cwdCache = undefined;
        for (const w of widgets) w.remove(ctx);
    });
}
