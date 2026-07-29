import type { Theme } from "@earendil-works/pi-coding-agent";
import {
    Editor,
    truncateToWidth,
    type Component,
    type EditorTheme,
    type TUI,
} from "@earendil-works/pi-tui";
import {
    isEnter,
    isEscape,
    isTab,
    isCtrlR,
    isArrowUp,
    isArrowDown,
} from "../_shared/commit-keys";
import { renderBoxHeader, renderBoxFooter } from "../_shared/ui/framed-box";
import { renderCwd } from "./cwd-display";
import type {
    CommitPlanParams,
    CommitPlanResult,
    CommitPlanSessionState,
} from "./types";

function rejectResult(
    params: CommitPlanParams,
    cancelled: boolean,
    rejectionReason?: string,
): CommitPlanResult {
    return {
        accepted: false,
        cancelled,
        ...(cancelled
            ? {}
            : { rejection_reason: rejectionReason?.trim() ?? "" }),
        plan_summary: params.plan_summary,
        cwd: params.cwd,
        files: [],
        commit_message: "",
    };
}

export function handleCommitPlanInput(
    state: CommitPlanSessionState,
    key: string,
): CommitPlanSessionState {
    const { focus, fileCursorIndex, files } = state;

    // --- Global keys ---
    if (isTab(key)) {
        return {
            ...state,
            focus: focus === "message" ? "files" : "message",
        };
    }

    // --- File list navigation ---
    if (focus === "files") {
        if (key === " ") {
            const newFiles = [...files];
            if (fileCursorIndex >= 0 && fileCursorIndex < newFiles.length) {
                newFiles[fileCursorIndex] = {
                    ...newFiles[fileCursorIndex],
                    selected: !newFiles[fileCursorIndex].selected,
                };
            }
            return { ...state, files: newFiles };
        }

        // Handle both test strings ("ArrowUp") and actual terminal escape sequences
        const isUp = key === "ArrowUp" || isArrowUp(key);
        const isDown = key === "ArrowDown" || isArrowDown(key);

        if (isUp) {
            return {
                ...state,
                fileCursorIndex: Math.max(0, fileCursorIndex - 1),
            };
        }

        if (isDown) {
            return {
                ...state,
                fileCursorIndex: Math.min(
                    files.length - 1,
                    fileCursorIndex + 1,
                ),
            };
        }
    }

    return state;
}

export class CommitPlanSession implements Component {
    private state: CommitPlanSessionState;
    private editorComponent: Editor;
    private rejectionReasonEditor: Editor;
    private rejecting = false;
    private fileViewportStart = 0;

    constructor(
        private config: {
            tui: TUI;
            theme: Theme;
            params: CommitPlanParams;
            done: (result: CommitPlanResult) => void;
        },
    ) {
        this.state = {
            files: config.params.files.map((path) => ({
                path,
                selected: true,
            })),
            focus: "message",
            fileCursorIndex: 0,
        };

        const editorTheme: EditorTheme = {
            borderColor: (text) => config.theme.fg("border", text),
            selectList: {
                selectedPrefix: (text) => config.theme.fg("accent", text),
                selectedText: (text) => config.theme.fg("accent", text),
                description: (text) => config.theme.fg("muted", text),
                scrollInfo: (text) => config.theme.fg("muted", text),
                noMatch: (text) => config.theme.fg("warning", text),
            },
        };

        this.editorComponent = new Editor(config.tui, editorTheme);
        this.editorComponent.setText(config.params.commit_message);
        this.editorComponent.onSubmit = (commitMessage) =>
            this.accept(commitMessage);

        this.rejectionReasonEditor = new Editor(config.tui, editorTheme);
        this.rejectionReasonEditor.onSubmit = (rejectionReason) =>
            this.config.done(
                rejectResult(this.config.params, false, rejectionReason),
            );
    }

    private accept(commitMessage: string): void {
        this.config.done({
            accepted: true,
            cancelled: false,
            plan_summary: this.config.params.plan_summary,
            cwd: this.config.params.cwd,
            files: this.state.files
                .filter((f) => f.selected)
                .map((f) => f.path),
            commit_message: commitMessage,
        });
    }

    handleInput(data: string): void {
        if (this.rejecting) {
            if (isEscape(data)) {
                this.rejecting = false;
                this.config.tui.requestRender();
                return;
            }

            this.rejectionReasonEditor.handleInput(data);
            return;
        }

        if (isCtrlR(data)) {
            this.rejecting = true;
            this.config.tui.requestRender();
            return;
        }

        if (isEscape(data)) {
            this.config.done(rejectResult(this.config.params, true));
            return;
        }

        // Intercept Tab to switch focus before the Editor component can process it
        if (isTab(data)) {
            this.state = handleCommitPlanInput(this.state, data);
            this.config.tui.requestRender();
            return;
        }

        if (this.state.focus === "message") {
            this.editorComponent.handleInput(data);
            return;
        }

        // When focus is on files, handle Enter globally, not via Editor.
        if (isEnter(data)) {
            this.accept(this.editorComponent.getExpandedText());
            return;
        }

        const nextState = handleCommitPlanInput(this.state, data);
        if (nextState !== this.state) {
            this.state = nextState;
            this.config.tui.requestRender();
        }
    }

    invalidate(): void {
        this.editorComponent.invalidate();
        this.rejectionReasonEditor.invalidate();
    }

    render(width: number): string[] {
        const { theme } = this.config;
        const innerWidth = Math.max(40, width - 4);

        if (this.rejecting) {
            const lines = [
                renderBoxHeader(theme, innerWidth, " 📦 Reject Commit Plan "),
                ...renderCwd(theme, innerWidth, this.config.params.cwd),
                theme.fg("border", "│") +
                    " " +
                    theme.fg(
                        "accent",
                        theme.bold(" ✏️ Reason for rejection (optional):"),
                    ),
            ];

            this.rejectionReasonEditor.focused = true;
            for (const line of this.rejectionReasonEditor.render(
                innerWidth - 3,
            )) {
                lines.push(theme.fg("border", "│") + "   " + line);
            }
            lines.push(
                theme.fg("border", "│") +
                    "   " +
                    theme.fg(
                        "muted",
                        "Leave empty to request a different plan.",
                    ),
            );
            lines.push(
                renderBoxFooter(
                    theme,
                    innerWidth,
                    "[Enter] Reject [Shift+Enter] Line [Esc] Back",
                ),
            );
            return lines;
        }

        const { focus, fileCursorIndex, files } = this.state;
        const lines: string[] = [];

        lines.push(
            renderBoxHeader(theme, innerWidth, " 📦 Commit Plan Review "),
        );
        lines.push(...renderCwd(theme, innerWidth, this.config.params.cwd));

        const isMessageFocused = focus === "message";
        this.editorComponent.focused = isMessageFocused;
        const msgLabel = isMessageFocused
            ? " ✏️ Edit Message:"
            : " Commit Message:";
        lines.push(
            theme.fg("border", "│") +
                " " +
                theme.fg("accent", theme.bold(msgLabel)),
        );

        const editorLines = this.editorComponent.render(innerWidth - 3);
        for (const line of editorLines) {
            lines.push(theme.fg("border", "│") + "   " + line);
        }

        lines.push(theme.fg("border", "├" + "─".repeat(innerWidth) + "┤"));

        const terminalRows = Math.max(1, this.config.tui.terminal.rows);
        const fileViewportHeight = Math.max(1, terminalRows - lines.length - 2);
        const maxViewportStart = Math.max(0, files.length - fileViewportHeight);

        if (fileCursorIndex < this.fileViewportStart) {
            this.fileViewportStart = fileCursorIndex;
        } else if (
            fileCursorIndex >=
            this.fileViewportStart + fileViewportHeight
        ) {
            this.fileViewportStart = fileCursorIndex - fileViewportHeight + 1;
        }
        this.fileViewportStart = Math.max(
            0,
            Math.min(this.fileViewportStart, maxViewportStart),
        );

        const fileViewportEnd = Math.min(
            files.length,
            this.fileViewportStart + fileViewportHeight,
        );
        const rangeLabel =
            files.length > fileViewportHeight
                ? ` ${this.fileViewportStart + 1}-${fileViewportEnd} of ${files.length}`
                : "";
        const filesLabel =
            focus === "files"
                ? ` 📁 Select Files:${rangeLabel}`
                : ` Files:${rangeLabel}`;
        lines.push(
            theme.fg("border", "│") +
                " " +
                theme.fg("accent", theme.bold(filesLabel)),
        );

        if (files.length === 0) {
            lines.push(
                theme.fg("border", "│") +
                    "   " +
                    theme.fg("muted", "(no files)"),
            );
        } else {
            for (let i = this.fileViewportStart; i < fileViewportEnd; i++) {
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

                const maxPathWidth = innerWidth - 6;
                const truncatedPath = truncateToWidth(pathText, maxPathWidth);
                lines.push(
                    theme.fg("border", "│") +
                        "   " +
                        checkbox +
                        " " +
                        truncatedPath,
                );
            }
        }

        const footerText = isMessageFocused
            ? "[Tab] Files [Enter] Accept [Shift+Enter] Line [Ctrl+R] Reject [Esc] Cancel"
            : "[Tab]Message [↑↓]Move [Space]Toggle [Enter]Accept [Ctrl+R]Rej [Esc]Cancel";

        lines.push(renderBoxFooter(theme, innerWidth, footerText));

        return lines;
    }
}
