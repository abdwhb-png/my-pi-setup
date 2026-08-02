import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
    Key,
    matchesKey,
    truncateToWidth,
    type Component,
    type TUI,
} from "@earendil-works/pi-tui";

import {
    computePanelOverlayHeight,
    renderFramedPanelFallback,
    renderFramedPanels,
    renderPanelTitle,
    resolveResponsivePanelLayout,
    slicePanelViewport,
    wrapPanelLines,
} from "../_shared/ui/framed-panels";
import type {
    SddDelegationActivity,
    SddRunActivity,
    SddTaskActivity,
} from "./activity-store";

export interface SddActivitySource {
    getRun(runId: string): SddRunActivity | undefined;
    subscribe(subscriber: () => void): () => void;
}

function formatDuration(durationMs: number): string {
    const seconds = Math.max(0, Math.floor(durationMs / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
}

function formatTokens(tokens: number): string {
    return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function latestDelegation(
    task: SddTaskActivity,
): SddDelegationActivity | undefined {
    return task.delegations.at(-1);
}

function isActiveTask(task: SddTaskActivity): boolean {
    const latest = latestDelegation(task);
    return (
        (latest?.phase !== "terminal" && latest !== undefined) ||
        ["implementing", "reviewing", "fixing"].includes(task.state)
    );
}

function stateGlyph(state: SddTaskActivity["state"]): string {
    if (state === "verified") return "✓";
    if (state === "failed" || state === "cancelled") return "✗";
    if (state === "needs_input") return "!";
    if (["implementing", "reviewing", "fixing"].includes(state)) return "↻";
    return "·";
}

function taskWidgetLine(task: SddTaskActivity, width: number): string {
    const activity = latestDelegation(task);
    const agent = activity?.agent ?? "direct agent";
    const tool = activity?.currentTool?.tool ?? activity?.stage ?? task.state;
    const fixed = `${stateGlyph(task.state)} ${agent} ·  · ${tool}`;
    const titleWidth = Math.max(1, width - fixed.length);
    const title = truncateToWidth(task.title, titleWidth);
    return truncateToWidth(
        `${stateGlyph(task.state)} ${agent} · ${title} · ${tool}`,
        width,
    );
}

function counterLine(run: SddRunActivity): string {
    const counts = new Map<string, number>();
    for (const task of run.tasks) {
        counts.set(task.state, (counts.get(task.state) ?? 0) + 1);
    }
    const preferred = [
        "verified",
        "implementing",
        "reviewing",
        "fixing",
        "pending",
        "needs_input",
        "failed",
        "cancelled",
    ];
    return preferred
        .filter((state) => counts.has(state))
        .map((state) => `${counts.get(state)} ${state.replaceAll("_", " ")}`)
        .join(" · ");
}

export function renderSddActivityWidget(
    run: SddRunActivity,
    width: number,
    theme: Theme,
    now = Date.now(),
): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const active = run.tasks.filter(isActiveTask);
    const header = truncateToWidth(
        theme.bold(
            `SDD ${run.state} · ${formatDuration(now - run.startedAt)} · ${run.planTitle}`,
        ),
        safeWidth,
    );
    const taskLines = active
        .slice(0, 2)
        .map((task) => taskWidgetLine(task, safeWidth));
    const counts = truncateToWidth(counterLine(run), safeWidth);
    const overflow = Math.max(0, active.length - taskLines.length);
    const footer = truncateToWidth(
        theme.fg(
            "muted",
            `/sdd-live${overflow > 0 ? ` · +${overflow} more` : ""}`,
        ),
        safeWidth,
    );
    return [header, ...taskLines, counts, footer].filter(Boolean).slice(0, 5);
}

function delegationLines(activity: SddDelegationActivity): string[] {
    const metadata = [
        `agent: ${activity.agent}`,
        ...(activity.model ? [`model: ${activity.model}`] : []),
        `stage: ${activity.stage} · attempt ${activity.attempt}`,
        `phase: ${activity.phase}${activity.status ? ` · ${activity.status}` : ""}`,
        ...(activity.durationMs === undefined
            ? []
            : [`duration: ${formatDuration(activity.durationMs)}`]),
        ...(activity.tokens === undefined
            ? []
            : [`tokens: ${formatTokens(activity.tokens)}`]),
    ];
    const currentTool = activity.currentTool
        ? [
              "",
              "Current tool",
              `${activity.currentTool.tool} ${activity.currentTool.args}`.trim(),
          ]
        : [];
    const tools = activity.recentTools.length
        ? [
              "",
              "Recent tools",
              ...activity.recentTools.map((tool) =>
                  `${tool.tool} ${tool.args}`.trim(),
              ),
          ]
        : [];
    const output = activity.recentOutputLines.length
        ? ["", "Recent output", ...activity.recentOutputLines]
        : [];
    return [...metadata, ...currentTool, ...tools, ...output];
}

export class SddLiveComponent implements Component {
    private run: SddRunActivity | undefined;
    private observableSignature = "";
    private focusedPanel: "tasks" | "activity" = "tasks";
    private selectedId: string | undefined;
    private activityScroll = 0;
    private activityLineCount = 0;
    private bodyHeight = 0;
    private disposed = false;
    private readonly unsubscribe: () => void;

    constructor(
        private readonly tui: TUI,
        private readonly theme: Theme,
        private readonly source: SddActivitySource,
        private readonly runId: string,
        private readonly done: () => void,
    ) {
        this.syncRun(false);
        this.unsubscribe = source.subscribe(() => this.syncRun(true));
    }

    get selectedTaskId(): string | undefined {
        return this.selectedId;
    }

    private syncRun(requestRender: boolean): void {
        const next = this.source.getRun(this.runId);
        const signature = JSON.stringify(next);
        if (signature === this.observableSignature) return;
        this.observableSignature = signature;
        this.run = next;
        const selectedExists = next?.tasks.some(
            (task) => task.id === this.selectedId,
        );
        if (!selectedExists) this.selectedId = next?.tasks[0]?.id;
        if (requestRender && !this.disposed) this.tui.requestRender();
    }

    private selectedTask(): SddTaskActivity | undefined {
        return this.run?.tasks.find((task) => task.id === this.selectedId);
    }

    private taskLines(width: number, height: number): string[] {
        const lines = (this.run?.tasks ?? []).map((task) => {
            const selected = task.id === this.selectedId;
            const marker = selected ? this.theme.fg("accent", "▸") : " ";
            return truncateToWidth(
                ` ${marker} ${stateGlyph(task.state)} ${task.title}`,
                Math.max(1, width - 1),
            );
        });
        return slicePanelViewport(lines, 0, height).lines;
    }

    private activityLines(width: number): string[] {
        const task = this.selectedTask();
        if (!task) return [" No task selected."];
        const latestFirst = task.delegations.toReversed();
        const raw = [task.title, `state: ${task.state}`];
        if (latestFirst.length === 0) {
            raw.push("", "No live delegation activity is available.");
        } else {
            for (const [index, activity] of latestFirst.entries()) {
                raw.push(
                    "",
                    `Delegation ${latestFirst.length - index}`,
                    ...delegationLines(activity),
                );
            }
        }
        if (this.run?.historyNotice) raw.push("", this.run.historyNotice);
        return wrapPanelLines(raw, width, { padding: 1 });
    }

    render(width: number): string[] {
        const rows = this.tui.terminal?.rows ?? 32;
        const maxHeight = computePanelOverlayHeight(rows);
        if (width < 36) {
            return renderFramedPanelFallback({
                theme: this.theme,
                width,
                maxHeight: Math.min(3, maxHeight),
                title: "SDD live",
                message: "Need ≥36 columns · Esc",
            });
        }
        if (maxHeight <= 7) {
            return renderFramedPanelFallback({
                theme: this.theme,
                width,
                maxHeight,
                title: "SDD live",
                message: "Tab panels · Esc close",
            });
        }
        if (!this.run) {
            return renderFramedPanelFallback({
                theme: this.theme,
                width,
                maxHeight,
                title: "SDD live",
                message: `Run unavailable: ${this.runId} · Esc close`,
            });
        }

        const resolved = resolveResponsivePanelLayout(width, [
            { mode: "compact", minWidth: 36, panels: [{ minWidth: 34 }] },
            {
                mode: "medium",
                minWidth: 60,
                panels: [
                    { minWidth: 24, maxWidth: 28 },
                    { minWidth: 29, weight: 1 },
                ],
            },
            {
                mode: "wide",
                minWidth: 96,
                panels: [
                    { minWidth: 30, maxWidth: 36 },
                    { minWidth: 57, weight: 1 },
                ],
            },
        ] as const);
        if (!resolved) return [];

        this.bodyHeight = Math.max(1, maxHeight - 7);
        const compact = resolved.mode === "compact";
        const taskWidth = resolved.layout.panelWidths[0] ?? 1;
        const activityWidth = resolved.layout.panelWidths[compact ? 0 : 1] ?? 1;
        const tasks = this.taskLines(taskWidth, this.bodyHeight);
        const allActivity = this.activityLines(activityWidth);
        this.activityLineCount = allActivity.length;
        const activityViewport = slicePanelViewport(
            allActivity,
            this.activityScroll,
            this.bodyHeight,
        );
        this.activityScroll = activityViewport.offset;

        const panelRows = Array.from({ length: this.bodyHeight }, (_, index) =>
            compact
                ? [
                      this.focusedPanel === "tasks"
                          ? (tasks[index] ?? "")
                          : (activityViewport.lines[index] ?? ""),
                  ]
                : [tasks[index] ?? "", activityViewport.lines[index] ?? ""],
        );
        const panelTitles = compact
            ? [
                  renderPanelTitle(
                      this.theme,
                      this.focusedPanel === "tasks" ? "TASKS" : "ACTIVITY",
                      true,
                      { padding: 0 },
                  ),
              ]
            : [
                  renderPanelTitle(
                      this.theme,
                      "TASKS",
                      this.focusedPanel === "tasks",
                      {
                          padding: 0,
                      },
                  ),
                  renderPanelTitle(
                      this.theme,
                      "ACTIVITY",
                      this.focusedPanel === "activity",
                      { padding: 0 },
                  ),
              ];
        return renderFramedPanels({
            theme: this.theme,
            title: `SDD live · ${this.run.state} · ${this.run.planTitle}`,
            layout: resolved.layout,
            panelTitles,
            panelRows,
            boxFooterRows: [
                this.theme.fg(
                    "dim",
                    ` Tab/←→ panels · ↑↓ ${this.focusedPanel === "tasks" ? "tasks" : "scroll"} · PgUp/PgDn · Home/End · Esc/q close`,
                ),
            ],
        }).map((line) => truncateToWidth(line, width));
    }

    handleInput(data: string): void {
        if (
            matchesKey(data, Key.escape) ||
            matchesKey(data, "q") ||
            matchesKey(data, Key.shift("q"))
        ) {
            this.done();
            return;
        }
        if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
            this.setFocus("activity");
            return;
        }
        if (
            matchesKey(data, Key.shift(Key.tab)) ||
            matchesKey(data, Key.left)
        ) {
            this.setFocus("tasks");
            return;
        }
        if (matchesKey(data, Key.up)) {
            if (this.focusedPanel === "tasks") this.moveSelection(-1);
            else this.scroll(-1);
            return;
        }
        if (matchesKey(data, Key.down)) {
            if (this.focusedPanel === "tasks") this.moveSelection(1);
            else this.scroll(1);
            return;
        }
        if (matchesKey(data, Key.pageUp)) {
            this.scroll(-this.bodyHeight);
            return;
        }
        if (matchesKey(data, Key.pageDown)) {
            this.scroll(this.bodyHeight);
            return;
        }
        if (matchesKey(data, Key.home)) {
            if (this.focusedPanel === "tasks") this.selectBoundary(0);
            else this.setScroll(0);
            return;
        }
        if (matchesKey(data, Key.end)) {
            if (this.focusedPanel === "tasks") {
                this.selectBoundary((this.run?.tasks.length ?? 1) - 1);
            } else {
                this.setScroll(
                    Math.max(0, this.activityLineCount - this.bodyHeight),
                );
            }
        }
    }

    private setFocus(next: "tasks" | "activity"): void {
        if (this.focusedPanel === next) return;
        this.focusedPanel = next;
        this.tui.requestRender();
    }

    private moveSelection(delta: number): void {
        const tasks = this.run?.tasks ?? [];
        const current = tasks.findIndex((task) => task.id === this.selectedId);
        const next = Math.max(0, Math.min(tasks.length - 1, current + delta));
        this.selectBoundary(next);
    }

    private selectBoundary(index: number): void {
        const next = this.run?.tasks[index]?.id;
        if (!next || next === this.selectedId) return;
        this.selectedId = next;
        this.activityScroll = 0;
        this.tui.requestRender();
    }

    private scroll(delta: number): void {
        if (this.focusedPanel !== "activity") return;
        this.setScroll(this.activityScroll + delta);
    }

    private setScroll(next: number): void {
        const bounded = Math.max(
            0,
            Math.min(
                Math.max(0, this.activityLineCount - this.bodyHeight),
                next,
            ),
        );
        if (bounded === this.activityScroll) return;
        this.activityScroll = bounded;
        this.tui.requestRender();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.unsubscribe();
    }

    invalidate(): void {}
}

export async function openSddLive(
    ctx: ExtensionContext,
    source: SddActivitySource,
    runId: string,
): Promise<void> {
    if (ctx.mode !== "tui") {
        throw new Error("SDD live overlay requires TUI mode.");
    }
    await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
            new SddLiveComponent(tui, theme, source, runId, done),
        {
            overlay: true,
            overlayOptions: {
                anchor: "center",
                width: "95%",
                minWidth: 36,
                maxHeight: "85%",
                margin: 1,
            },
        },
    );
}
