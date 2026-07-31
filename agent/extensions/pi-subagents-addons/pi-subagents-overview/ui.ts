/**
 * Overlay ui components for subagents overview and detail views.
 *
 * - Implements Component interface from @earendil-works/pi-tui
 * - Uses ctx.ui.custom with overlay:true for centered, dismissible dialogs
 * - Uses shared box rendering for consistent header/footer styling
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import { BoxRenderer } from "../../_shared/ui/framed-box";
import type { LiveRun, LiveRunSnapshot } from "./fleet-store.ts";
import { formatDuration, formatTokens } from "./live-ui.ts";

export const icon = "👥";

// ── Types ──────────────────────────────────────────────

interface ScrollState {
    scrollOffset: number;
}

function isCloseInput(data: string): boolean {
    return matchesKey(data, "escape") || data === "q" || data === "Q";
}

function getScrollDelta(data: string): number | null {
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) return -1;
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) return 1;
    if (matchesKey(data, Key.pageUp)) return -10;
    if (matchesKey(data, Key.pageDown)) return 10;
    return null;
}

// ── SubagentsOverviewView ────────────────────────────

export class SubagentsOverviewView implements Component {
    private contentLines: string[];
    private state: ScrollState;
    private tab: "catalog" | "live" = "catalog";
    private selectedRun = 0;
    private detailOpen = false;
    private cancelRefreshTimer: (() => void) | undefined;

    constructor(
        private config: {
            theme: Theme;
            content: string;
            done: () => void;
            requestRender?: () => void;
            getLiveSnapshot?: () => LiveRunSnapshot;
            now?: () => number;
            onRefresh?: () => void | Promise<void>;
            onAction?: (
                action: "steer" | "interrupt" | "stop",
                run: LiveRun,
            ) => void | Promise<void>;
            onLiveVisibilityChange?: (visible: boolean) => void;
            refreshMs?: number;
        },
    ) {
        this.contentLines = config.content.split("\n");
        this.state = { scrollOffset: 0 };
        if (config.getLiveSnapshot && config.onRefresh) {
            const refreshTimer = setInterval(() => {
                void config.onRefresh?.();
                config.requestRender?.();
            }, config.refreshMs ?? 500);
            this.cancelRefreshTimer = () => clearInterval(refreshTimer);
            refreshTimer.unref?.();
        }
        if (config.getLiveSnapshot) config.onLiveVisibilityChange?.(false);
    }

    handleInput(data: string): void {
        if (isCloseInput(data)) {
            if (this.detailOpen) {
                this.detailOpen = false;
                this.state.scrollOffset = 0;
                this.config.requestRender?.();
                return;
            }
            this.config.done();
            return;
        }

        if (
            this.config.getLiveSnapshot &&
            (matchesKey(data, "tab") || data === "\t" || matchesKey(data, Key.left) || matchesKey(data, Key.right))
        ) {
            this.tab = this.tab === "catalog" ? "live" : "catalog";
            this.detailOpen = false;
            this.state.scrollOffset = 0;
            this.config.onLiveVisibilityChange?.(this.tab === "live");
            this.config.requestRender?.();
            return;
        }

        if (this.tab === "live" && this.config.getLiveSnapshot) {
            const snapshot = this.config.getLiveSnapshot();
            if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
                this.selectedRun = Math.max(0, this.selectedRun - 1);
                this.detailOpen = false;
                this.config.requestRender?.();
                return;
            }
            if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
                this.selectedRun = Math.min(
                    Math.max(0, snapshot.runs.length - 1),
                    this.selectedRun + 1,
                );
                this.detailOpen = false;
                this.config.requestRender?.();
                return;
            }
            if (matchesKey(data, "return")) {
                if (snapshot.runs[this.selectedRun]) {
                    this.detailOpen = !this.detailOpen;
                    this.state.scrollOffset = 0;
                    this.config.requestRender?.();
                }
                return;
            }
            const action =
                data === "s"
                    ? "steer"
                    : data === "i"
                      ? "interrupt"
                      : data === "x"
                        ? "stop"
                        : undefined;
            const run = snapshot.runs[this.selectedRun];
            if (action && run?.source === "async" && run.controllable) {
                void this.config.onAction?.(action, run);
                return;
            }
        }

        const delta = getScrollDelta(data);
        if (delta !== null) {
            this.state = {
                ...this.state,
                scrollOffset: Math.max(0, this.state.scrollOffset + delta),
            };
            this.config.requestRender?.();
        }
    }

    invalidate(): void {
        this.config.requestRender?.();
    }

    dispose(): void {
        this.cancelRefreshTimer?.();
        this.cancelRefreshTimer = undefined;
        this.config.onLiveVisibilityChange?.(false);
    }

    render(width: number): string[] {
        const { theme } = this.config;
        const box = new BoxRenderer(theme, width);
        const hasLive = this.config.getLiveSnapshot !== undefined;
        const tabLabel = this.tab === "catalog" ? "Catalog" : "Live";
        box.setTitle(`${icon}Subagents Overview${hasLive ? ` · ${tabLabel}` : ""} `);
        box.setContent(
            hasLive
                ? this.tab === "catalog"
                    ? ["[Catalog]  Live", "", ...this.contentLines]
                    : this.renderLiveContent()
                : this.contentLines,
        );
        box.scrollTo(this.state.scrollOffset);
        box.setFooter(
            hasLive
                ? this.tab === "catalog"
                    ? "[Tab/←→] Live  [↑↓/PgUp/PgDn] Scroll  [q/Esc] Close"
                    : this.detailOpen
                      ? "[Enter/Esc] Back  [PgUp/PgDn] Scroll  [q] Close"
                      : "[Tab/←→] Catalog  [↑↓] Select  [Enter] Details  [q/Esc] Close"
                : "[↑↓/PgUp/PgDn] Scroll  [q/Esc] Close",
        );
        return box.render();
    }

    private renderLiveContent(): string[] {
        const snapshot = this.config.getLiveSnapshot?.();
        if (!snapshot) return ["Catalog  [Live]", "", "Live data unavailable."];
        this.selectedRun = Math.min(
            this.selectedRun,
            Math.max(0, snapshot.runs.length - 1),
        );
        const capability = snapshot.fleetAvailable
            ? `${snapshot.totalActive} active${snapshot.omitted > 0 ? ` · +${snapshot.omitted} omitted` : ""}`
            : "Fleet RPC unavailable · showing tracked async runs only";
        const lines = ["Catalog  [Live]", this.config.theme.fg("dim", capability), ""];
        if (snapshot.runs.length === 0) {
            lines.push("No subagent runs in this session.");
            return lines;
        }
        const selected = snapshot.runs[this.selectedRun];
        if (this.detailOpen && selected) {
            return [...lines, ...this.renderRunDetail(selected)];
        }
        const now = this.config.now?.() ?? Date.now();
        for (const [index, run] of snapshot.runs.entries()) {
            const marker = index === this.selectedRun ? "›" : " ";
            const state = run.source === "fleet" ? "active" : run.state;
            const durationEnd =
                run.source === "async" && run.completedAt !== undefined
                    ? run.completedAt
                    : now;
            lines.push(
                `${marker} ${run.agent}${run.role ? `:${run.role}` : ""}  ${state}  ${formatDuration(durationEnd - run.startedAt)}  ${formatTokens(run.tokens.total)}`,
            );
            if (run.goal) lines.push(`    ${this.config.theme.fg("dim", run.goal)}`);
            if (index === this.selectedRun) {
                lines.push(
                    run.source === "fleet"
                        ? `    ${this.config.theme.fg("warning", "Foreground transcript: Ctrl+Alt+F")}`
                        : run.controllable
                          ? `    ${this.config.theme.fg("accent", "Enter transcript · s steer · i interrupt · x stop")}`
                          : `    ${this.config.theme.fg("dim", "Enter transcript")}`,
                );
            }
            lines.push("");
        }
        return lines;
    }

    private renderRunDetail(run: LiveRun): string[] {
        const lines = [
            `${this.config.theme.bold(run.agent)}${run.role ? ` · ${run.role}` : ""}`,
            `State: ${run.source === "fleet" ? "active" : run.state}`,
            `Model: ${run.model ?? "—"}`,
            `Effort: ${run.effort ?? "—"}`,
            `Tokens: ${run.tokens.input} in · ${run.tokens.output} out · ${run.tokens.total} total`,
            ...(run.goal ? [`Goal: ${run.goal}`] : []),
            "",
        ];
        if (run.source === "fleet") {
            lines.push(
                "This foreground entry exposes display metadata only.",
                "Open the native inspector with Ctrl+Alt+F for its transcript.",
            );
            return lines;
        }
        if (run.activity) lines.push(`Activity: ${run.activity}`);
        if (run.currentTool) lines.push(`Current tool: ${run.currentTool}`);
        if (run.summary) lines.push(`Summary: ${run.summary}`);
        lines.push("", "Transcript", "──────────");
        lines.push(...(run.transcript?.split("\n") ?? ["No transcript output yet."]));
        return lines;
    }
}

// ── AgentDetailView ──────────────────────────────────

export class AgentDetailView implements Component {
    private contentLines: string[];
    private state: ScrollState;

    constructor(
        private config: {
            theme: Theme;
            content: string;
            agentName: string;
            done: () => void;
            requestRender?: () => void;
        },
    ) {
        this.contentLines = config.content.split("\n");
        this.state = { scrollOffset: 0 };
    }

    handleInput(data: string): void {
        if (isCloseInput(data)) {
            this.config.done();
            return;
        }

        const delta = getScrollDelta(data);
        if (delta !== null) {
            this.state = {
                ...this.state,
                scrollOffset: Math.max(0, this.state.scrollOffset + delta),
            };
            this.config.requestRender?.();
        }
    }

    invalidate(): void {
        // Static content, nothing to invalidate
    }

    render(width: number): string[] {
        const { theme } = this.config;
        const box = new BoxRenderer(theme, width, { viewportHeight: 20 });
        box.setTitle(` 🧬 Agent: ${this.config.agentName} `);
        box.setContent(this.contentLines);
        box.scrollTo(this.state.scrollOffset);
        box.setFooter("[↑↓/PgUp/PgDn] Scroll  [q/Esc] Close");
        return box.render();
    }
}
