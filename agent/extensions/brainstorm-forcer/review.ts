import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component } from "@earendil-works/pi-tui";
import { cycleFocus } from "../_shared/ui/focus-navigation.ts";
import {
    renderFramedPanelFallback,
    renderFramedPanels,
    resolveResponsivePanelLayout,
    slicePanelViewport,
    wrapPanelLines,
} from "../_shared/ui/framed-panels.ts";

export type ReviewDecision = "Approve" | "Reject" | "Reject with reason";
export type ReviewAction = ReviewDecision | "Close";

type BodyRenderer = Pick<Component, "render" | "invalidate">;

type ArtifactReviewOptions = {
    title: string;
    subtitle: string;
    body: BodyRenderer;
    viewportRows?: number;
    actions?: readonly ReviewAction[];
    escapeAction?: ReviewAction;
    theme: Theme;
    requestRender(): void;
    done(decision: ReviewAction): void;
};

const ACTIONS: readonly ReviewDecision[] = [
    "Approve",
    "Reject",
    "Reject with reason",
];

export class ArtifactReviewView implements Component {
    private readonly viewportRows: number;
    private readonly actions: readonly ReviewAction[];
    private readonly escapeAction: ReviewAction;
    private scrollOffset = 0;
    private selectedAction = 0;
    private closed = false;

    constructor(private readonly options: ArtifactReviewOptions) {
        this.viewportRows = options.viewportRows ?? 18;
        this.actions = options.actions ?? ACTIONS;
        this.escapeAction = options.escapeAction ?? "Reject";
    }

    render(width: number): string[] {
        const { theme } = this.options;
        const frameWidth = Math.min(Math.max(1, width - 4), 136);
        const resolved = resolveResponsivePanelLayout(frameWidth, [
            {
                mode: "preview",
                minWidth: 4,
                panels: [{ minWidth: 2 }],
            },
        ] as const);
        if (!resolved) {
            return renderFramedPanelFallback({
                theme,
                width: frameWidth,
                maxHeight: 3,
                title: this.options.title,
                message: this.options.subtitle,
                footer: `Esc ${this.escapeAction.toLowerCase()}`,
            });
        }
        const panelWidth = resolved.layout.panelWidths[0];
        const contentWidth = Math.max(1, panelWidth - 2);
        const bodyLines = wrapPanelLines(
            this.options.body.render(contentWidth),
            panelWidth,
        );
        const viewport = slicePanelViewport(
            bodyLines,
            this.scrollOffset,
            this.viewportRows,
        );
        this.scrollOffset = viewport.offset;

        const actions = this.actions
            .map((action, index) =>
                index === this.selectedAction
                    ? theme.fg("accent", theme.bold(`[ ${action} ]`))
                    : theme.fg("dim", `  ${action}  `),
            )
            .join("  ");
        const help = `↑/↓ scroll · ←/→ action · Enter select · Esc ${this.escapeAction.toLowerCase()}`;
        const scrollInfo =
            viewport.maxOffset > 0
                ? ` [${viewport.offset}/${viewport.maxOffset}↑↓] `
                : "";

        return renderFramedPanels({
            theme,
            title: this.options.title,
            layout: resolved.layout,
            prelude: wrapPanelLines(
                [theme.fg("dim", this.options.subtitle)],
                panelWidth,
            ),
            panelRows: viewport.lines.map((line) => [line]),
            footer: `${scrollInfo}${actions}  ${theme.fg("dim", help)}`,
            titlePosition: "center",
        });
    }

    handleInput(data: string): void {
        if (this.closed) return;
        if (matchesKey(data, "escape")) {
            this.finish(this.escapeAction);
            return;
        }
        if (matchesKey(data, "enter")) {
            this.finish(this.actions[this.selectedAction] ?? this.escapeAction);
            return;
        }
        if (matchesKey(data, "up") || data === "k") {
            this.scrollOffset = Math.max(0, this.scrollOffset - 1);
        } else if (matchesKey(data, "down") || data === "j") {
            this.scrollOffset += 1;
        } else if (matchesKey(data, "pageUp")) {
            this.scrollOffset = Math.max(
                0,
                this.scrollOffset - this.viewportRows,
            );
        } else if (matchesKey(data, "pageDown")) {
            this.scrollOffset += this.viewportRows;
        } else if (matchesKey(data, "left") || data === "h") {
            const current = this.actions[this.selectedAction];
            this.selectedAction = current
                ? this.actions.indexOf(cycleFocus(this.actions, current, -1))
                : Math.max(0, this.actions.length - 1);
        } else if (matchesKey(data, "right") || data === "l" || data === "\t") {
            const current = this.actions[this.selectedAction];
            this.selectedAction = current
                ? this.actions.indexOf(cycleFocus(this.actions, current, 1))
                : 0;
        } else if (
            data.toLowerCase() === "a" &&
            this.actions.includes("Approve")
        ) {
            this.finish("Approve");
            return;
        } else if (
            data.toLowerCase() === "r" &&
            this.actions.includes("Reject")
        ) {
            this.finish("Reject");
            return;
        } else if (
            data.toLowerCase() === "e" &&
            this.actions.includes("Reject with reason")
        ) {
            this.finish("Reject with reason");
            return;
        } else {
            return;
        }
        this.options.requestRender();
    }

    invalidate(): void {
        this.options.body.invalidate();
    }

    private finish(decision: ReviewAction): void {
        this.closed = true;
        this.options.done(decision);
    }
}
