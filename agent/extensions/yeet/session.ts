import type { Component } from "@mariozechner/pi-tui";
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

  render(_width: number): string[] {
    const { theme } = this.config;
    const { focus, fileCursorIndex, commitMessage, cursorPosition, files } = this.state;
    const lines: string[] = [];

    // --- Header with distinct color (warning = orange/yellow, stands out from main chat) ---
    const headerText = "  📦 Commit Plan Review  ";
    lines.push(theme.bg("toolPendingBg", theme.bold(headerText)));
    lines.push("");

    // --- Commit message box ---
    const isActive = focus === "message";
    const msgLabel = isActive ? "  ✏️  Edit Message:" : "  Commit Message:";
    lines.push(theme.fg("warning", theme.bold(msgLabel)));

    // Render message with visible cursor when active
    if (isActive) {
      const before = commitMessage.slice(0, cursorPosition);
      const after = commitMessage.slice(cursorPosition);
      const cursorLine = before + theme.inverse(BLOCK_CURSOR) + after;
      lines.push("    " + theme.fg("text", cursorLine));
    } else {
      lines.push("    " + theme.fg("text", commitMessage || theme.fg("muted", "(empty)")));
    }
    lines.push("");

    // --- Files box ---
    const filesLabel = focus === "files" ? "  📁 Select Files:" : "  Files:";
    lines.push(theme.fg("warning", theme.bold(filesLabel)));
    if (files.length === 0) {
      lines.push(theme.fg("muted", "    (no files)"));
    } else {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const isFocused = focus === "files" && i === fileCursorIndex;
        const checkbox = f.selected
          ? theme.bg("toolSuccessBg", theme.bold(" [x]"))
          : theme.fg("muted", " [ ]");
        const path = isFocused
          ? theme.bg("selectedBg", theme.bold(" " + f.path + " "))
          : theme.fg("text", " " + f.path);
        lines.push("  " + checkbox + path);
      }
    }
    lines.push("");

    // --- Footer with key hints ---
    const footer = isActive
      ? "  [Tab] Switch  [←→] Cursor  [Enter] Accept  [Ctrl+R] Reject  [Esc] Cancel"
      : "  [Tab] Switch  [Space] Toggle  [↑↓] Navigate  [Enter] Accept  [Ctrl+R] Reject  [Esc] Cancel";
    lines.push(theme.fg("muted", theme.italic(footer)));

    return lines;
  }
}
