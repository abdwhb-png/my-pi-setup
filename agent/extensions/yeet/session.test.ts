import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { CommitPlanSession } from './session';
import { handleCommitPlanInput } from './session';
import type { CommitPlanParams, CommitPlanResult } from './types';
import type { CommitPlanSessionState } from './types';

function createMockTheme() {
    return {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
        italic: (text: string) => text,
        inverse: (text: string) => text,
        underline: (text: string) => text,
    };
}

function createMockTui(rows = 40) {
    return {
        terminal: { rows },
        requestRender: mock(),
    };
}

const defaultParams: CommitPlanParams = {
    plan_summary: 'Test plan',
    files: ['src/index.ts', 'src/session.ts'],
    commit_message: 'feat: add new feature',
    cwd: '/workspace/repo',
};

function makeState(
    overrides?: Partial<CommitPlanSessionState>,
): CommitPlanSessionState {
    return {
        files: [
            { path: 'file1.ts', selected: false },
            { path: 'file2.ts', selected: false },
            { path: 'file3.ts', selected: false },
        ],
        focus: 'message',
        fileCursorIndex: 0,
        ...overrides,
    };
}

describe('handleCommitPlanInput', () => {
    // --- Focus toggling ---

    it('should toggle focus with Tab using Kitty protocol encoding', () => {
        const state = handleCommitPlanInput(makeState(), '\x1b[9u');
        expect(state.focus).toBe('files');
        const state2 = handleCommitPlanInput(state, '\x1b[9u');
        expect(state2.focus).toBe('message');
    });

    it('should toggle focus with Tab using legacy raw byte', () => {
        const state = handleCommitPlanInput(makeState(), '\t');
        expect(state.focus).toBe('files');
        const state2 = handleCommitPlanInput(state, '\t');
        expect(state2.focus).toBe('message');
    });

    // --- File list navigation ---

    it('should move file cursor with ArrowUp/ArrowDown using legacy ESC sequences', () => {
        const s0 = makeState({ focus: 'files' });
        const s1 = handleCommitPlanInput(s0, '\x1b[A');
        expect(s1.fileCursorIndex).toBe(0);
        const s1d = handleCommitPlanInput(s0, '\x1b[B');
        expect(s1d.fileCursorIndex).toBe(1);
    });

    it('should move file cursor with ArrowUp/ArrowDown using test strings', () => {
        const s0 = makeState({ focus: 'files' });
        const s1 = handleCommitPlanInput(s0, 'ArrowDown');
        expect(s1.fileCursorIndex).toBe(1);
        const s2 = handleCommitPlanInput(s1, 'ArrowDown');
        expect(s2.fileCursorIndex).toBe(2);
        // Boundary
        const s3 = handleCommitPlanInput(s2, 'ArrowDown');
        expect(s3.fileCursorIndex).toBe(2);

        const s4 = handleCommitPlanInput(s2, 'ArrowUp');
        expect(s4.fileCursorIndex).toBe(1);
        const s5 = handleCommitPlanInput(s4, 'ArrowUp');
        expect(s5.fileCursorIndex).toBe(0);
        // Boundary
        const s6 = handleCommitPlanInput(s5, 'ArrowUp');
        expect(s6.fileCursorIndex).toBe(0);
    });

    it('should toggle file selection with Space when focus is files', () => {
        const s0 = makeState({ focus: 'files' });
        const s1 = handleCommitPlanInput(s0, ' ');
        expect(s1.files[0].selected).toBe(true);
        const s2 = handleCommitPlanInput(s1, ' ');
        expect(s2.files[0].selected).toBe(false);
    });

    it('should ignore message editing keys when focus is message (handled by Editor component)', () => {
        const s0 = makeState({ focus: 'message' });
        const s1 = handleCommitPlanInput(s0, ' ');
        expect(s1.files[0].selected).toBe(false);
        // State should remain unchanged as Input component handles text
        expect(s1.focus).toBe('message');
    });

    // --- Focus isolation ---

    it('should not update commit message when typing and focus is files', () => {
        const s0 = makeState({ focus: 'files', commitMessage: '' });
        const s1 = handleCommitPlanInput(s0, 'a');
        expect(s1.commitMessage).toBe('');
    });

    it('should not move cursor when ArrowLeft/Right and focus is files', () => {
        const s0 = makeState({
            focus: 'files',
            commitMessage: 'hello',
            cursorPosition: 3,
        });
        const s1 = handleCommitPlanInput(s0, 'ArrowLeft');
        expect(s1.cursorPosition).toBe(3);
    });
});

describe('CommitPlanSession', () => {
    let done: ReturnType<typeof mock>;
    let session: CommitPlanSession;

    beforeEach(() => {
        done = mock();
        session = new CommitPlanSession({
            tui: createMockTui() as never,
            theme: createMockTheme() as never,
            params: defaultParams,
            done,
        });
    });

    describe('render()', () => {
        it('returns a non-empty array of strings', () => {
            const output = session.render(80);
            expect(Array.isArray(output)).toBe(true);
            expect(output.length).toBeGreaterThan(0);
            output.forEach((line) => {
                expect(typeof line).toBe('string');
            });
        });

        it('includes the plan title', () => {
            const _output = session.render(80);
            expect(
                _output.some((line) => line.includes('Commit Plan Review')),
            ).toBe(true);
        });

        it('includes the commit message', () => {
            const _output = session.render(80);
            expect(
                _output.some((line) => line.includes('feat: add new feature')),
            ).toBe(true);
        });

        it('renders a multiline commit message as terminal-safe lines', () => {
            const multilineSession = new CommitPlanSession({
                tui: createMockTui() as never,
                theme: createMockTheme() as never,
                params: {
                    ...defaultParams,
                    commit_message: [
                        'feat: add a descriptive subject',
                        '',
                        'Explain why the change is needed.',
                        '',
                        '- keep the first concern',
                        '- preserve the second concern',
                    ].join('\n'),
                },
                done: mock(),
            });

            const output = multilineSession.render(56);

            expect(
                output.some((line) =>
                    line.includes('feat: add a descriptive subject'),
                ),
            ).toBe(true);
            expect(
                output.some((line) =>
                    line.includes('- keep the first concern'),
                ),
            ).toBe(true);
            expect(
                output.every(
                    (line) => !line.includes('\n') && !line.includes('\r'),
                ),
            ).toBe(true);
        });

        it('wraps a long commit message without overflowing the dialog', () => {
            const longSession = new CommitPlanSession({
                tui: createMockTui() as never,
                theme: createMockTheme() as never,
                params: {
                    ...defaultParams,
                    commit_message:
                        'feat: preserve the beginning while wrapping a deliberately long commit message so the user can review every word without horizontal scrolling',
                },
                done: mock(),
            });

            const output = longSession.render(56);

            expect(
                output.some((line) => line.includes('feat: preserve the')),
            ).toBe(true);
            expect(
                output.some((line) => line.includes('without horizontal')),
            ).toBe(true);
            expect(output.some((line) => line.includes('scrolling'))).toBe(
                true,
            );
            expect(output.every((line) => visibleWidth(line) <= 56)).toBe(true);
        });

        it('includes file paths', () => {
            const output = session.render(80);
            expect(output.some((line) => line.includes('src/index.ts'))).toBe(
                true,
            );
            expect(output.some((line) => line.includes('src/session.ts'))).toBe(
                true,
            );
        });

        it('keeps the focused file visible when the file list exceeds the terminal height', () => {
            const tui = createMockTui(16);
            const files = Array.from(
                { length: 20 },
                (_, index) => `src/file-${index + 1}.ts`,
            );
            const scrollingSession = new CommitPlanSession({
                tui: tui as never,
                theme: createMockTheme() as never,
                params: { ...defaultParams, files },
                done: mock(),
            });

            scrollingSession.handleInput('\t');
            for (let index = 0; index < 15; index++) {
                scrollingSession.handleInput('ArrowDown');
            }

            const visibleOutput = scrollingSession
                .render(80)
                .slice(0, tui.terminal.rows);

            expect(
                visibleOutput.some((line) => line.includes('src/file-16.ts')),
            ).toBe(true);
            expect(
                visibleOutput.some((line) => line.includes('src/file-1.ts')),
            ).toBe(false);
        });

        it('includes the help hint bar', () => {
            const output = session.render(80);
            expect(output.some((line) => line.includes('[Enter] Accept'))).toBe(
                true,
            );
            expect(output.some((line) => line.includes('[Esc] Cancel'))).toBe(
                true,
            );
            expect(output.some((line) => line.includes('[Tab]'))).toBe(true);
            expect(output.some((line) => line.includes('[Ctrl+R]'))).toBe(true);
        });
    });

    describe('invalidate()', () => {
        it('does not throw', () => {
            expect(() => session.invalidate()).not.toThrow();
        });
    });

    describe('handleInput()', () => {
        it('does not throw for common navigation keys', () => {
            expect(() => session.handleInput('\t')).not.toThrow();
            expect(() => session.handleInput(' ')).not.toThrow();
            expect(() => session.handleInput('ArrowUp')).not.toThrow();
            expect(() => session.handleInput('ArrowDown')).not.toThrow();
            expect(() => session.handleInput('a')).not.toThrow();
            expect(() => session.handleInput('Backspace')).not.toThrow();
        });

        it('requests a rerender when file navigation changes the viewport', () => {
            const tui = createMockTui();
            const navigatingSession = new CommitPlanSession({
                tui: tui as never,
                theme: createMockTheme() as never,
                params: defaultParams,
                done: mock(),
            });

            navigatingSession.handleInput('\t');
            tui.requestRender.mockClear();
            navigatingSession.handleInput('ArrowDown');

            expect(tui.requestRender).toHaveBeenCalledTimes(1);
        });

        it('calls done with accepted=true, cancelled=false on Enter', () => {
            session.handleInput('\r');
            expect(done).toHaveBeenCalledTimes(1);
            const result: CommitPlanResult = done.mock.calls[0][0];
            expect(result.accepted).toBe(true);
            expect(result.cancelled).toBe(false);
            expect(result.files).toEqual(['src/index.ts', 'src/session.ts']);
            expect(result.commit_message).toBe('feat: add new feature');
            expect(result.plan_summary).toBe('Test plan');
        });

        it('calls done with accepted=false, cancelled=true on Escape', () => {
            session.handleInput('\x1b');
            expect(done).toHaveBeenCalledTimes(1);
            const result: CommitPlanResult = done.mock.calls[0][0];
            expect(result.accepted).toBe(false);
            expect(result.cancelled).toBe(true);
            expect(result.files).toEqual([]);
            expect(result.commit_message).toBe('');
        });

        it('opens rejection mode on Ctrl+R and allows an empty reason', () => {
            session.handleInput('\x12');

            expect(done).not.toHaveBeenCalled();
            expect(
                session
                    .render(80)
                    .some((line) => line.includes('Reason for rejection')),
            ).toBe(true);

            session.handleInput('\r');

            expect(done).toHaveBeenCalledTimes(1);
            const result: CommitPlanResult = done.mock.calls[0][0];
            expect(result.accepted).toBe(false);
            expect(result.cancelled).toBe(false);
            expect(result.rejection_reason).toBe('');
        });

        it('returns a supplied rejection reason', () => {
            session.handleInput('\x12');
            session.handleInput('Split the refactor from the fix.');
            session.handleInput('\r');

            const result: CommitPlanResult = done.mock.calls[0][0];
            expect(result.accepted).toBe(false);
            expect(result.cancelled).toBe(false);
            expect(result.rejection_reason).toBe(
                'Split the refactor from the fix.',
            );
        });

        it('returns from rejection mode without losing review edits', () => {
            session.handleInput('!');
            session.handleInput('\t');
            session.handleInput(' ');
            session.handleInput('\x12');
            session.handleInput('Temporary reason');
            session.handleInput('\x1b');

            expect(done).not.toHaveBeenCalled();
            const output = session.render(80);
            expect(
                output.some((line) => line.includes('Commit Plan Review')),
            ).toBe(true);
            expect(
                output.some((line) =>
                    line.includes('feat: add new feature!'),
                ),
            ).toBe(true);

            session.handleInput('\r');
            const result: CommitPlanResult = done.mock.calls[0][0];
            expect(result.accepted).toBe(true);
            expect(result.files).toEqual(['src/session.ts']);
            expect(result.commit_message).toBe('feat: add new feature!');
        });

        it('processes text input and returns accepted result with updated message on Enter', () => {
            session.handleInput('!');
            session.handleInput('\r');
            const result: CommitPlanResult = done.mock.calls[0][0];
            expect(result.commit_message).toBe('feat: add new feature!');
        });

        it('preserves a multiline body edited before acceptance', () => {
            session.handleInput('\n');
            session.handleInput('Explain why the change is needed.');
            session.handleInput('\r');

            const result: CommitPlanResult = done.mock.calls[0][0];
            expect(result.commit_message).toBe(
                'feat: add new feature\nExplain why the change is needed.',
            );
        });

        it('accepts on Enter when focus is files', () => {
            session.handleInput('\t');
            session.handleInput('\r');
            expect(done).toHaveBeenCalledTimes(1);
            const result: CommitPlanResult = done.mock.calls[0][0];
            expect(result.accepted).toBe(true);
        });

        it('cancels on Escape when focus is files', () => {
            session.handleInput('\t');
            session.handleInput('\x1b');
            expect(done).toHaveBeenCalledTimes(1);
            const result: CommitPlanResult = done.mock.calls[0][0];
            expect(result.accepted).toBe(false);
            expect(result.cancelled).toBe(true);
        });

        it('should append text to the end of the initial message (verifying cursor position)', () => {
            // Create a fresh session for this test to avoid interference with other tests
            const _freshSession = new CommitPlanSession({
                tui: createMockTui() as never,
                theme: createMockTheme() as never,
                params: defaultParams,
                done: mock(),
            });
            const freshDone = mock();
            // Re-instantiate with the freshDone mock
            const sessionWithDone = new CommitPlanSession({
                tui: createMockTui() as never,
                theme: createMockTheme() as never,
                params: defaultParams,
                done: freshDone,
            });

            sessionWithDone.handleInput('!');
            sessionWithDone.handleInput('\r');
            const result: CommitPlanResult = freshDone.mock.calls[0][0];
            expect(result.commit_message).toBe('feat: add new feature!');
        });
    });
});
