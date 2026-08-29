import {
    isKeyRelease,
    Key,
    matchesKey,
    truncateToWidth,
    visibleWidth,
} from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";

type SelectorTui = Pick<TUI, "requestRender" | "terminal">;

export interface ForkCandidate {
    entryId: string;
    text: string;
}

export interface ForkSelectorTheme {
    fg(role: "accent" | "muted" | "dim", text: string): string;
    bold(text: string): string;
}

function visibleCapacity(terminalRows: number): number {
    const overlayRows = Math.max(1, Math.floor(terminalRows * 0.8));
    return Math.max(1, overlayRows - 4);
}

/** Pi TUI has no public typed wheel key, so mouse parsing stays isolated here. */
export function parseWheelDirection(data: string): -1 | 1 | undefined {
    const sgr = /^\x1b\[<(64|65);\d+;\d+M$/.exec(data);
    if (sgr) return sgr[1] === "64" ? -1 : 1;

    if (data.length === 6 && data.startsWith("\x1b[M")) {
        const button = data.charCodeAt(3) - 32;
        if (button === 64) return -1;
        if (button === 65) return 1;
    }

    return undefined;
}

export class EnhancedForkSelector implements Component {
    private readonly candidates: readonly ForkCandidate[];
    private readonly tui: SelectorTui;
    private readonly theme: ForkSelectorTheme;
    private readonly done: (entryId: string | undefined) => void;
    private selectedIndex: number;
    private windowStart = 0;
    private settled = false;

    constructor(
        candidates: readonly ForkCandidate[],
        tui: SelectorTui,
        theme: ForkSelectorTheme,
        done: (entryId: string | undefined) => void,
    ) {
        this.candidates = candidates;
        this.tui = tui;
        this.theme = theme;
        this.done = done;
        this.selectedIndex = Math.max(0, candidates.length - 1);
    }

    invalidate(): void {}

    render(width: number): string[] {
        const capacity = visibleCapacity(this.tui.terminal.rows);
        this.keepSelectionVisible(capacity);
        const end = Math.min(
            this.candidates.length,
            this.windowStart + capacity,
        );
        const lines = [
            truncateToWidth(this.theme.bold("Enhanced Fork"), width),
            truncateToWidth(
                this.theme.fg("muted", "Select a user message to fork from"),
                width,
            ),
        ];

        for (let index = this.windowStart; index < end; index += 1) {
            const candidate = this.candidates[index];
            if (!candidate) continue;

            const selected = index === this.selectedIndex;
            const cursor = selected ? "› " : "  ";
            const prefix = `${cursor}[${index + 1}/${this.candidates.length}] `;
            const previewWidth = Math.max(0, width - visibleWidth(prefix));
            const preview = truncateToWidth(
                candidate.text.replace(/\s+/g, " ").trim(),
                previewWidth,
            );
            lines.push(
                prefix + (selected ? this.theme.bold(preview) : preview),
            );
        }

        lines.push(
            truncateToWidth(
                this.theme.fg(
                    "dim",
                    "↑/↓ move  PgUp/PgDn page  Home/End jump  Enter fork  Esc cancel",
                ),
                width,
            ),
        );
        return lines;
    }

    handleInput(data: string): void {
        if (this.settled || isKeyRelease(data)) return;

        if (matchesKey(data, Key.escape)) {
            this.settled = true;
            this.done(undefined);
            return;
        }
        if (matchesKey(data, Key.enter)) {
            const selected = this.candidates[this.selectedIndex];
            if (selected) {
                this.settled = true;
                this.done(selected.entryId);
            }
            return;
        }

        const wheelDirection = parseWheelDirection(data);
        if (matchesKey(data, Key.up) || wheelDirection === -1) {
            this.moveBy(-1, true);
        } else if (matchesKey(data, Key.down) || wheelDirection === 1) {
            this.moveBy(1, true);
        } else if (matchesKey(data, Key.pageUp)) {
            this.moveBy(-visibleCapacity(this.tui.terminal.rows), false);
        } else if (matchesKey(data, Key.pageDown)) {
            this.moveBy(visibleCapacity(this.tui.terminal.rows), false);
        } else if (matchesKey(data, Key.home)) {
            this.moveTo(0);
        } else if (matchesKey(data, Key.end)) {
            this.moveTo(this.candidates.length - 1);
        }
    }

    private moveBy(delta: number, wrap: boolean): void {
        if (this.candidates.length < 2) return;

        const next = wrap
            ? (this.selectedIndex + delta + this.candidates.length) %
              this.candidates.length
            : Math.max(
                  0,
                  Math.min(
                      this.candidates.length - 1,
                      this.selectedIndex + delta,
                  ),
              );
        this.moveTo(next);
    }

    private moveTo(index: number): void {
        if (index < 0 || index >= this.candidates.length) return;
        if (index === this.selectedIndex) return;

        this.selectedIndex = index;
        this.tui.requestRender();
    }

    private keepSelectionVisible(capacity: number): void {
        const maxStart = Math.max(0, this.candidates.length - capacity);
        this.windowStart = Math.min(this.windowStart, maxStart);

        if (this.selectedIndex < this.windowStart) {
            this.windowStart = this.selectedIndex;
        } else if (this.selectedIndex >= this.windowStart + capacity) {
            this.windowStart = this.selectedIndex - capacity + 1;
        }
    }
}
