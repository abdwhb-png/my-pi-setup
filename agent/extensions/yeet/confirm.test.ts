import { describe, it, expect } from 'bun:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { CommitConfirmDialog } from './confirm';
import type { CommitPlanParams, CommitPlanResult } from './types';

function makeTheme() {
    return {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
        italic: (text: string) => text,
        inverse: (text: string) => text,
        underline: (text: string) => text,
        strikethrough: (text: string) => text,
        dim: (text: string) => text,
    };
}

function makeParams(overrides?: Partial<CommitPlanParams>): CommitPlanParams {
    return {
        plan_summary: 'Refactor session and fix lint issues',
        files: ['src/session.ts', 'src/types.ts'],
        commit_message: 'refactor: clean up session functions',
        cwd: '/workspace/repo',
        ...overrides,
    };
}

describe('CommitConfirmDialog', () => {
    it('render() returns a non-empty array of strings', () => {
        const done = () => {};
        const dialog = new CommitConfirmDialog({
            theme: makeTheme() as any,
            params: makeParams(),
            done,
        });
        const output = dialog.render(80);
        expect(output.length).toBeGreaterThan(0);
    });

    it('closes every confirmation row at the same frame width', () => {
        const dialog = new CommitConfirmDialog({
            theme: makeTheme() as any,
            params: makeParams({
                plan_summary: `Summary ${'with a long detail '.repeat(8)}`,
            }),
            done: () => {},
        });

        const output = dialog.render(80);

        expect(output.every((line) => visibleWidth(line) === 76)).toBe(true);
        expect(
            output
                .slice(1, -1)
                .every((line) => line.endsWith('│')),
        ).toBe(true);
    });

    it('render() includes the summary, files, and commit message', () => {
        const done = () => {};
        const params = makeParams();
        const dialog = new CommitConfirmDialog({
            theme: makeTheme() as any,
            params,
            done,
        });
        const output = dialog.render(80);
        const full = output.join('\n');

        expect(full).toContain('/workspace/repo');
        expect(full).toContain('Refactor session and fix lint issues');
        expect(full).toContain('src/session.ts');
        expect(full).toContain('src/types.ts');
        expect(full).toContain('refactor: clean up session functions');
    });

    it('render() includes Confirm/Cancel footer', () => {
        const done = () => {};
        const dialog = new CommitConfirmDialog({
            theme: makeTheme() as any,
            params: makeParams(),
            done,
        });
        const output = dialog.render(80);
        const full = output.join('\n');

        expect(full).toContain('Confirm');
        expect(full).toContain('Enter');
        expect(full).toContain('Esc');
    });

    it('handleInput Enter calls done with accepted=true', () => {
        let result: CommitPlanResult | undefined;
        const done = (r: CommitPlanResult) => {
            result = r;
        };
        const params = makeParams({ files: ['a.ts', 'b.ts'] });
        const dialog = new CommitConfirmDialog({
            theme: makeTheme() as any,
            params,
            done,
        });

        dialog.handleInput('\r');

        expect(result).toBeDefined();
        expect(result!.accepted).toBe(true);
        expect(result!.cancelled).toBe(false);
        expect(result!.cwd).toBe('/workspace/repo');
        expect(result!.files).toEqual(['a.ts', 'b.ts']);
    });

    it('handleInput newline also calls done with accepted=true', () => {
        let result: CommitPlanResult | undefined;
        const done = (r: CommitPlanResult) => {
            result = r;
        };
        const dialog = new CommitConfirmDialog({
            theme: makeTheme() as any,
            params: makeParams(),
            done,
        });

        dialog.handleInput('\n');

        expect(result).toBeDefined();
        expect(result!.accepted).toBe(true);
    });

    it('handleInput Escape calls done with cancelled=true', () => {
        let result: CommitPlanResult | undefined;
        const done = (r: CommitPlanResult) => {
            result = r;
        };
        const dialog = new CommitConfirmDialog({
            theme: makeTheme() as any,
            params: makeParams(),
            done,
        });

        dialog.handleInput('\x1b');

        expect(result).toBeDefined();
        expect(result!.accepted).toBe(false);
        expect(result!.cancelled).toBe(true);
    });

    it('handleInput other keys do nothing', () => {
        let result: CommitPlanResult | undefined;
        const done = (r: CommitPlanResult) => {
            result = r;
        };
        const dialog = new CommitConfirmDialog({
            theme: makeTheme() as any,
            params: makeParams(),
            done,
        });

        dialog.handleInput('a');
        dialog.handleInput(' ');
        dialog.handleInput('\t');
        dialog.handleInput('\x12');

        expect(result).toBeUndefined();
    });

    it('invalidate() does not throw', () => {
        const done = () => {};
        const dialog = new CommitConfirmDialog({
            theme: makeTheme() as any,
            params: makeParams(),
            done,
        });
        expect(() => dialog.invalidate()).not.toThrow();
    });
});
