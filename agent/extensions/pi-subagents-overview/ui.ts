/**
 * Overlay ui components for subagents overview and detail views.
 *
 * - Implements Component interface from @earendil-works/pi-tui
 * - Uses ctx.ui.custom with overlay:true for centered, dismissible dialogs
 * - Uses shared box rendering for consistent header/footer styling
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import { BoxRenderer } from "../_shared/ui/framed-box";

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

    constructor(
        private config: {
            theme: Theme;
            content: string;
            done: () => void;
            requestRender: () => void;
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
            this.config.requestRender();
        }
    }

    invalidate(): void {
        // Static content, nothing to invalidate
    }

    render(width: number): string[] {
        const { theme } = this.config;
        const box = new BoxRenderer(theme, width);
        box.setTitle(`${icon}Subagents Overview `);
        box.setContent(this.contentLines);
        box.scrollTo(this.state.scrollOffset);
        box.setFooter("[↑↓/PgUp/PgDn] Scroll  [q/Esc] Close");
        return box.render();
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
            requestRender: () => void;
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
            this.config.requestRender();
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
