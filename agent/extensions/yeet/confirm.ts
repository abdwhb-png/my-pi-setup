import { type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CommitPlanParams, CommitPlanResult } from "./types";
import { renderBoxHeader, renderBoxFooter } from "../_shared/box";

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
    if (data === "\r" || data === "\n") {
      this.config.done({
        accepted: true,
        cancelled: false,
        plan_summary: this.config.params.plan_summary,
        files: this.config.params.files,
        commit_message: this.config.params.commit_message,
      });
      return;
    }

    // Esc → hard cancel
    if (data === "\x1b") {
      this.config.done({
        accepted: false,
        cancelled: true,
        plan_summary: this.config.params.plan_summary,
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

    // Summary
    lines.push(theme.fg("border", "│") + " " + theme.fg("accent", theme.bold(" Summary:")));
    lines.push(theme.fg("border", "│") + "   " + theme.fg("text", params.plan_summary));

    // Files
    lines.push(theme.fg("border", "│"));
    lines.push(theme.fg("border", "│") + " " + theme.fg("accent", theme.bold(" Files:")));
    for (const file of params.files) {
      const maxPathWidth = innerWidth - 8;
      const display = file.length > maxPathWidth ? "…" + file.slice(-(maxPathWidth - 1)) : file;
      lines.push(theme.fg("border", "│") + "   " + theme.fg("success", "[x]") + " " + theme.fg("text", display));
    }

    // Message
    lines.push(theme.fg("border", "│"));
    lines.push(theme.fg("border", "│") + " " + theme.fg("accent", theme.bold(" Message:")));
    const msgLines = params.commit_message.split("\n");
    for (const msgLine of msgLines) {
      const maxMsgWidth = innerWidth - 4;
      const truncated = msgLine.length > maxMsgWidth ? msgLine.slice(0, maxMsgWidth - 1) + "…" : msgLine;
      lines.push(theme.fg("border", "│") + "   " + theme.fg("text", truncated));
    }

    lines.push(renderBoxFooter(theme, innerWidth, " [Enter] Confirm  [Esc] Cancel "));

    return lines;
  }
}
