import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
    allocateBoxPanelLayout,
    renderBoxFooter,
    renderBoxHeader,
    renderBoxPanelRow,
} from "../../_shared/ui/framed-box.ts";
import type { LiveRun, LiveRunSnapshot } from "./fleet-store.ts";

const MAX_WIDGET_LINES = 5;
const COMPLETION_LINGER_MS = 5_000;

export function formatDuration(milliseconds: number): string {
    const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m${seconds % 60}s`;
}

export function formatTokens(tokens: number): string {
    if (tokens < 1_000) return `${tokens}t`;
    if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}kt`;
    return `${Math.round(tokens / 1_000)}kt`;
}

function active(run: LiveRun): boolean {
    return run.source === "fleet" || run.state === "running";
}

function visibleRuns(snapshot: LiveRunSnapshot, now: number): LiveRun[] {
    return snapshot.runs.filter(
        (run) =>
            active(run) ||
            (run.source === "async" &&
                run.completedAt !== undefined &&
                now - run.completedAt <= COMPLETION_LINGER_MS),
    );
}

export function hasVisibleLiveRuns(
    snapshot: LiveRunSnapshot,
    now = Date.now(),
): boolean {
    return visibleRuns(snapshot, now).length > 0;
}

function statusDot(run: LiveRun, theme: Theme): string {
    if (run.source === "fleet" || run.state === "running") {
        return theme.fg("accent", "●");
    }
    if (run.state === "complete") return theme.fg("success", "✓");
    if (run.state === "failed") return theme.fg("error", "✕");
    return theme.fg("warning", "■");
}

function renderRun(
    run: LiveRun,
    theme: Theme,
    width: number,
    now: number,
): string {
    const durationEnd =
        run.source === "async" && run.completedAt !== undefined
            ? run.completedAt
            : now;
    const metadata = `${formatDuration(durationEnd - run.startedAt)} · ${formatTokens(run.tokens.total)}`;
    const label = `${statusDot(run, theme)} ${theme.bold(run.agent)}${run.role ? `:${run.role}` : ""}`;
    const goal = run.goal ? ` — ${run.goal}` : "";
    const reserved = visibleWidth(metadata) + 1;
    const left = truncateToWidth(
        `${label}${goal}`,
        Math.max(1, width - reserved),
        "…",
    );
    const spaces = " ".repeat(
        Math.max(1, width - visibleWidth(left) - visibleWidth(metadata)),
    );
    return `${left}${spaces}${theme.fg("dim", metadata)}`;
}

export function renderLiveWidget(
    snapshot: LiveRunSnapshot,
    theme: Theme,
    width: number,
    now = Date.now(),
): string[] {
    const runs = visibleRuns(snapshot, now);
    if (runs.length === 0) return [];
    if (width < 4) return [truncateToWidth("●", Math.max(0, width), "")];
    const layout = allocateBoxPanelLayout(width, [{ minWidth: width - 2 }]);
    if (!layout) return [];
    const bodyLimit = MAX_WIDGET_LINES - 2;
    const shown = runs.slice(0, bodyLimit);
    const overflow = snapshot.omitted + Math.max(0, runs.length - shown.length);
    const activeCount = runs.filter(active).length;
    return [
        renderBoxHeader(
            theme,
            width,
            `👥 Subagents Live · ${activeCount} active`,
            {
                titlePosition: "left",
                borderStyle: "rounded",
            },
        ),
        ...shown.map((run) =>
            renderBoxPanelRow(
                theme,
                layout,
                [renderRun(run, theme, layout.panelWidths[0], now)],
                { borderStyle: "rounded" },
            ),
        ),
        renderBoxFooter(
            theme,
            width,
            `/subagents-overview${overflow > 0 ? ` · +${overflow} more` : ""}`,
            { titlePosition: "left", borderStyle: "rounded" },
        ),
    ];
}
