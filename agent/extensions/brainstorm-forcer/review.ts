import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component } from "@earendil-works/pi-tui";
import { BoxRenderer } from "../_shared/ui/framed-box";

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
        const box = new BoxRenderer(theme, width, {
            viewportHeight: this.viewportRows,
        });
        box.setTitle(this.options.title);
        box.setFixedHeader([theme.fg("dim", this.options.subtitle)]);
        const bodyLines = this.options.body.render(box.getContentWidth());
        box.setContent(bodyLines);
        box.scrollTo(this.scrollOffset);

        const actions = this.actions
            .map((action, index) =>
                index === this.selectedAction
                    ? theme.fg("accent", theme.bold(`[ ${action} ]`))
                    : theme.fg("dim", `  ${action}  `),
            )
            .join("  ");
        const help = `↑/↓ scroll · ←/→ action · Enter select · Esc ${this.escapeAction.toLowerCase()}`;
        box.setFooter(`${actions}  ${theme.fg("dim", help)}`);

        return box.render();
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
