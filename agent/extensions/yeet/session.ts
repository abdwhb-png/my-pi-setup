import type { Theme } from '@earendil-works/pi-coding-agent';
import { Input, truncateToWidth, type Component } from '@earendil-works/pi-tui';
import { renderBoxHeader, renderBoxFooter } from '../_shared/box';
import {
    isEnter,
    isEscape,
    isTab,
    isCtrlR,
    isArrowUp,
    isArrowDown,
} from '../_shared/commit-keys';
import { renderCwd } from './cwd-display';
import type {
    CommitPlanParams,
    CommitPlanResult,
    CommitPlanSessionState,
} from './types';

function rejectResult(
    params: CommitPlanParams,
    cancelled: boolean,
): CommitPlanResult {
    return {
        accepted: false,
        cancelled,
        plan_summary: params.plan_summary,
        cwd: params.cwd,
        files: [],
        commit_message: '',
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
            focus: focus === 'message' ? 'files' : 'message',
        };
    }

    // --- File list navigation ---
    if (focus === 'files') {
        if (key === ' ') {
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
        const isUp = key === 'ArrowUp' || isArrowUp(key);
        const isDown = key === 'ArrowDown' || isArrowDown(key);

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
    private inputComponent: Input;

    constructor(
        private config: {
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
            focus: 'message',
            fileCursorIndex: 0,
        };

        this.inputComponent = new Input();
        this.inputComponent.setValue(config.params.commit_message);
        // Move cursor to the end of the initial message using the "End" key sequence
        this.inputComponent.handleInput('\x1b[F');

        this.inputComponent.onSubmit = () => {
            this.config.done({
                accepted: true,
                cancelled: false,
                plan_summary: this.config.params.plan_summary,
                cwd: this.config.params.cwd,
                files: this.state.files
                    .filter((f) => f.selected)
                    .map((f) => f.path),
                commit_message: this.inputComponent.getValue(),
            });
        };
        this.inputComponent.onEscape = () => {
            this.config.done(rejectResult(this.config.params, true));
        };
    }

    handleInput(data: string): void {
        if (isCtrlR(data)) {
            this.config.done(rejectResult(this.config.params, false));
            return;
        }

        // Intercept Tab to switch focus before the Input component can process it
        if (isTab(data)) {
            this.state = handleCommitPlanInput(this.state, data);
            return;
        }

        if (this.state.focus === 'message') {
            this.inputComponent.handleInput(data);
            return;
        }

        // When focus is on files, handle Enter/Escape globally, not via Input component
        if (isEnter(data)) {
            this.config.done({
                accepted: true,
                cancelled: false,
                plan_summary: this.config.params.plan_summary,
                cwd: this.config.params.cwd,
                files: this.state.files
                    .filter((f) => f.selected)
                    .map((f) => f.path),
                commit_message: this.inputComponent.getValue(),
            });
            return;
        }

        if (isEscape(data)) {
            this.config.done(rejectResult(this.config.params, true));
            return;
        }

        this.state = handleCommitPlanInput(this.state, data);
    }

    invalidate(): void {
        this.inputComponent.invalidate();
    }

    render(width: number): string[] {
        const { theme } = this.config;
        const { focus, fileCursorIndex, files } = this.state;
        const lines: string[] = [];
        const innerWidth = Math.max(40, width - 4);

        lines.push(
            renderBoxHeader(theme, innerWidth, ' 📦 Commit Plan Review '),
        );
        lines.push(...renderCwd(theme, innerWidth, this.config.params.cwd));

        const isMessageFocused = focus === 'message';
        const msgLabel = isMessageFocused
            ? ' ✏️ Edit Message:'
            : ' Commit Message:';
        lines.push(
            theme.fg('border', '│') +
                ' ' +
                theme.fg('accent', theme.bold(msgLabel)),
        );

        const inputLines = this.inputComponent.render(innerWidth - 3);
        for (const line of inputLines) {
            lines.push(theme.fg('border', '│') + '   ' + line);
        }

        lines.push(theme.fg('border', '├' + '─'.repeat(innerWidth) + '┤'));

        const filesLabel = focus === 'files' ? ' 📁 Select Files:' : ' Files:';
        lines.push(
            theme.fg('border', '│') +
                ' ' +
                theme.fg('accent', theme.bold(filesLabel)),
        );

        if (files.length === 0) {
            lines.push(
                theme.fg('border', '│') +
                    '   ' +
                    theme.fg('muted', '(no files)'),
            );
        } else {
            for (let i = 0; i < files.length; i++) {
                const f = files[i];
                const isFocused = focus === 'files' && i === fileCursorIndex;
                const checkbox = f.selected
                    ? theme.fg('success', '[x]')
                    : theme.fg('muted', '[ ]');

                let pathText = ' ' + f.path;
                if (isFocused) {
                    pathText = theme.bg('selectedBg', theme.bold(pathText));
                } else {
                    pathText = theme.fg('text', pathText);
                }

                const maxPathWidth = innerWidth - 6;
                const truncatedPath = truncateToWidth(pathText, maxPathWidth);
                lines.push(
                    theme.fg('border', '│') +
                        '   ' +
                        checkbox +
                        ' ' +
                        truncatedPath,
                );
            }
        }

        const footerText = isMessageFocused
            ? '[Tab] Files  [Enter] Accept  [Ctrl+R] Reject  [Esc] Cancel'
            : '[Tab]Message [↑↓]Move [Space]Toggle [Enter]Accept [Ctrl+R]Rej [Esc]Cancel';

        lines.push(renderBoxFooter(theme, innerWidth, footerText));

        return lines;
    }
}
