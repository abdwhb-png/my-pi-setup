import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component } from "@earendil-works/pi-tui";
import { isEnter, isEscape } from "../_shared/commit-keys";
import {
    renderBoxContentLines,
    renderBoxFooter,
    renderBoxHeader,
} from "../_shared/ui/framed-box";
import { renderCwd } from "./cwd-display";
import type { CommitPlanParams, CommitPlanResult } from "./types";

/**
 * A minimal confirmation dialog that shows the commit plan and waits for
 * Enter (accept) or Esc (cancel). No editing of message or files.
 */
export class CommitConfirmDialog implements Component {
    constructor(
        private config: {
            theme: Theme;
            params: CommitPlanParams;
            done: (result: CommitPlanResult) => void;
        },
    ) {}

    handleInput(data: string): void {
        // Enter → accept with all files selected
        if (isEnter(data)) {
            this.config.done({
                accepted: true,
                cancelled: false,
                plan_summary: this.config.params.plan_summary,
                cwd: this.config.params.cwd,
                files: this.config.params.files,
                commit_message: this.config.params.commit_message,
            });
            return;
        }

        // Esc → hard cancel
        if (isEscape(data)) {
            this.config.done({
                accepted: false,
                cancelled: true,
                plan_summary: this.config.params.plan_summary,
                cwd: this.config.params.cwd,
                files: [],
                commit_message: "",
            });
            return;
        }
    }

    invalidate(): void {
        // No internal state to invalidate
    }

    render(width: number): string[] {
        const { theme, params } = this.config;
        const lines: string[] = [];
        const innerWidth = Math.max(40, width - 4);

        lines.push(renderBoxHeader(theme, innerWidth, " 📦 Confirm Commit "));
        lines.push(...renderCwd(theme, innerWidth, params.cwd));

        // Summary
        lines.push(
            ...renderBoxContentLines(
                theme,
                innerWidth,
                theme.fg("accent", theme.bold(" Summary:")),
            ),
        );
        lines.push(
            ...renderBoxContentLines(
                theme,
                innerWidth,
                "  " + theme.fg("text", params.plan_summary),
            ),
        );

        // Files
        lines.push(...renderBoxContentLines(theme, innerWidth, ""));
        lines.push(
            ...renderBoxContentLines(
                theme,
                innerWidth,
                theme.fg("accent", theme.bold(" Files:")),
            ),
        );
        for (const file of params.files) {
            lines.push(
                ...renderBoxContentLines(
                    theme,
                    innerWidth,
                    "  " +
                        theme.fg("success", "[x]") +
                        " " +
                        theme.fg("text", file),
                ),
            );
        }

        // Message
        lines.push(...renderBoxContentLines(theme, innerWidth, ""));
        lines.push(
            ...renderBoxContentLines(
                theme,
                innerWidth,
                theme.fg("accent", theme.bold(" Message:")),
            ),
        );
        const msgLines = params.commit_message.split("\n");
        for (const msgLine of msgLines) {
            lines.push(
                ...renderBoxContentLines(
                    theme,
                    innerWidth,
                    "  " + theme.fg("text", msgLine),
                ),
            );
        }

        lines.push(
            renderBoxFooter(
                theme,
                innerWidth,
                " [Enter] Confirm  [Esc] Cancel ",
            ),
        );

        return lines;
    }
}
