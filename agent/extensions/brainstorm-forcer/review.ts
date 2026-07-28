import {
    matchesKey,
    truncateToWidth,
    type Component,
} from "@earendil-works/pi-tui";

export type ReviewDecision = "Approve" | "Reject" | "Reject with reason";
export type ReviewAction = ReviewDecision | "Close";

type BodyRenderer = Pick<Component, "render" | "invalidate">;

type ReviewColors = {
    accent(text: string): string;
    dim(text: string): string;
    selected(text: string): string;
};

type ArtifactReviewOptions = {
    title: string;
    subtitle: string;
    body: BodyRenderer;
    viewportRows?: number;
    actions?: readonly ReviewAction[];
    escapeAction?: ReviewAction;
    colors: ReviewColors;
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
        const contentWidth = Math.max(20, width);
        const bodyLines = this.options.body.render(contentWidth);
        const maxOffset = Math.max(0, bodyLines.length - this.viewportRows);
        this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
        const visible = bodyLines.slice(
            this.scrollOffset,
            this.scrollOffset + this.viewportRows,
        );
        while (visible.length < this.viewportRows) visible.push("");

        const rangeStart = bodyLines.length === 0 ? 0 : this.scrollOffset + 1;
        const rangeEnd = Math.min(
            bodyLines.length,
            this.scrollOffset + this.viewportRows,
        );
        const actions = this.actions
            .map((action, index) =>
                index === this.selectedAction
                    ? this.options.colors.selected(`[ ${action} ]`)
                    : this.options.colors.dim(`  ${action}  `),
            )
            .join("  ");

        return [
            truncateToWidth(
                this.options.colors.accent(this.options.title),
                contentWidth,
            ),
            truncateToWidth(
                this.options.colors.dim(this.options.subtitle),
                contentWidth,
            ),
            this.options.colors.dim("─".repeat(contentWidth)),
            ...visible,
            this.options.colors.dim(
                `${rangeStart}-${rangeEnd}/${bodyLines.length}`,
            ),
            this.options.colors.dim("─".repeat(contentWidth)),
            truncateToWidth(actions, contentWidth),
            this.options.colors.dim(
                `↑/↓ scroll · ←/→ action · Enter select · Esc ${this.escapeAction.toLowerCase()}`,
            ),
        ];
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
            this.selectedAction =
                (this.selectedAction + this.actions.length - 1) %
                this.actions.length;
        } else if (matchesKey(data, "right") || data === "l" || data === "\t") {
            this.selectedAction =
                (this.selectedAction + 1) % this.actions.length;
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
