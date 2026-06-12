import { truncateToWidth, visibleWidth, type Component } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { CommitPlanParams, CommitPlanResult, CommitPlanSessionState } from "./types";
import { handleCommitPlanInput } from "./util";

// Unicode block cursor character for the message editor
const BLOCK_CURSOR = "\u2588";

export class CommitPlanSession implements Component {
  private state: CommitPlanSessionState;

  constructor(
    private config: {
      theme: Theme;
      params: CommitPlanParams;
      done: (result: CommitPlanResult) => void;
    },
  ) {
    const msg = config.params.commit_message;
    this.state = {
      commitMessage: msg,
      cursorPosition: msg.length, // cursor at end by default
      files: config.params.files.map((path) => ({ path, selected: true })),
      focus: "message",
      fileCursorIndex: 0,
    };
  }

  handleInput(data: string): void {
    // Enter → Accept (commit with this plan)
    if (data === "\r" || data === "\n") {
      this.config.done({
        accepted: true,
        cancelled: false,
        plan_summary: this.config.params.plan_summary,
        files: this.state.files.filter((f) => f.selected).map((f) => f.path),
        commit_message: this.state.commitMessage,
      });
      return;
    }

    // Ctrl+R → Reject (propose a different plan)
    if (data === "\x12") {
      this.config.done({
        accepted: false,
        cancelled: false,
        plan_summary: this.config.params.plan_summary,
        files: [],
        commit_message: "",
      });
      return;
    }

    // Esc → Hard cancel (stop the whole commit workflow)
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

    this.state = handleCommitPlanInput(this.state, data);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const { theme } = this.config;
    const { focus, fileCursorIndex, commitMessage, cursorPosition, files } = this.state;
    const lines: string[] = [];
    const innerWidth = Math.max(40, width - 4); // Ensure minimum width for readability

    // --- Header ---
    const headerText = " 📦 Commit Plan Review ";
    const headerPad = Math.max(0, innerWidth - visibleWidth(headerText));
    const padLeft = Math.floor(headerPad / 2);
    const padRight = headerPad - padLeft;
    lines.push(
      theme.fg("border", "╭" + "─".repeat(padLeft)) +
      theme.fg("accent", theme.bold(headerText)) +
      theme.fg("border", "─".repeat(padRight) + "╮")
    );

    // --- Commit Message Section ---
    const isActive = focus === "message";
    const msgLabel = isActive ? " ✏️ Edit Message:" : " Commit Message:";
    lines.push(theme.fg("border", "│") + " " + theme.fg("accent", theme.bold(msgLabel)));
    
    if (isActive) {
      const before = commitMessage.slice(0, cursorPosition);
      const after = commitMessage.slice(cursorPosition);
      const cursorLine = before + theme.inverse(BLOCK_CURSOR) + after;
      lines.push(theme.fg("border", "│") + "   " + theme.fg("text", truncateToWidth(cursorLine, innerWidth - 3)));
    } else {
      const msgText = commitMessage || theme.fg("muted", "(empty)");
      lines.push(theme.fg("border", "│") + "   " + theme.fg("text", truncateToWidth(msgText, innerWidth - 3)));
    }

    // --- Divider ---
    lines.push(theme.fg("border", "├" + "─".repeat(innerWidth) + "┤"));

    // --- Files Section ---
    const filesLabel = focus === "files" ? " 📁 Select Files:" : " Files:";
    lines.push(theme.fg("border", "│") + " " + theme.fg("accent", theme.bold(filesLabel)));
    
    if (files.length === 0) {
      lines.push(theme.fg("border", "│") + "   " + theme.fg("muted", "(no files)"));
    } else {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const isFocused = focus === "files" && i === fileCursorIndex;
        const checkbox = f.selected
          ? theme.fg("success", "[x]")
          : theme.fg("muted", "[ ]");
        
        let pathText = " " + f.path;
        if (isFocused) {
          pathText = theme.bg("selectedBg", theme.bold(pathText));
        } else {
          pathText = theme.fg("text", pathText);
        }
        
        // Truncate the path to fit within the inner width, accounting for checkbox and spacing
        const maxPathWidth = innerWidth - 6; // 3 for " [x] ", 3 for left padding/border
        const truncatedPath = truncateToWidth(pathText, maxPathWidth);
        lines.push(theme.fg("border", "│") + "   " + checkbox + " " + truncatedPath);
      }
    }

    // --- Footer ---
    const footerText = isActive
      ? "[Tab] Switch  [←→] Cursor  [Enter] Accept  [Ctrl+R] Reject  [Esc] Cancel"
      : "[Tab] Switch  [Space] Toggle  [↑↓] Navigate  [Enter] Accept  [Ctrl+R] Reject  [Esc] Cancel";
    
    const footerPad = Math.max(0, innerWidth - visibleWidth(footerText));
    const fPadLeft = Math.floor(footerPad / 2);
    const fPadRight = footerPad - fPadLeft;
    lines.push(
      theme.fg("border", "╰" + "─".repeat(fPadLeft)) +
      theme.fg("muted", theme.italic(footerText)) +
      theme.fg("border", "─".repeat(fPadRight) + "╯")
    );

    return lines;
  }
}
