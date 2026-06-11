import type { Component } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { CommitPlanParams, CommitPlanResult, CommitPlanSessionState } from "./types";
import { handleCommitPlanInput } from "./util";

export class CommitPlanSession implements Component {
  private state: CommitPlanSessionState;

  constructor(
    private config: {
      theme: Theme;
      params: CommitPlanParams;
      done: (result: CommitPlanResult) => void;
    }
  ) {
    this.state = {
      commitMessage: config.params.commit_message,
      files: config.params.files.map((path) => ({ path, selected: true })),
      focus: "message",
      cursorIndex: 0,
    };
  }

  handleInput(data: string): void {
    if (data === "\r" || data === "\n") {
      this.config.done({
        accepted: true,
        plan_summary: this.config.params.plan_summary,
        files: this.state.files.filter((f) => f.selected).map((f) => f.path),
        commit_message: this.state.commitMessage,
      });
      return;
    }

    if (data === "\x1b") {
      this.config.done({
        accepted: false,
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
    const { focus, cursorIndex, commitMessage, files } = this.state;
    const lines: string[] = [];

    lines.push(theme.fg("accent", theme.bold("  Review Commit Plan  ")));
    lines.push("");

    const msgLabel = "  Commit Message:";
    lines.push(focus === "message" ? theme.fg("accent", theme.bold(msgLabel)) : theme.fg("text", msgLabel));
    lines.push(theme.fg("text", "    " + (commitMessage || theme.fg("muted", "(empty)"))));
    lines.push("");

    const filesLabel = "  Files:";
    lines.push(focus === "files" ? theme.fg("accent", theme.bold(filesLabel)) : theme.fg("text", filesLabel));
    if (files.length === 0) {
      lines.push(theme.fg("muted", "    (no files)"));
    } else {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const checkbox = f.selected ? theme.fg("success", " [x]") : theme.fg("muted", " [ ]");
        const isFocused = focus === "files" && i === cursorIndex;
        const path = isFocused ? theme.fg("accent", f.path) : theme.fg("text", f.path);
        lines.push("  " + checkbox + " " + path);
      }
    }
    lines.push("");

    lines.push(theme.fg("muted", theme.italic("  [Tab] Focus  [Space] Toggle  [Enter] Confirm  [Esc] Cancel")));

    return lines;
  }
}
