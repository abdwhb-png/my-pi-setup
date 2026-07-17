import { describe, it, expect, mock } from 'bun:test';
import { executeCommit, validateCommitCwd, validateCommitFiles } from './index';

describe('commit CWD validation', () => {
    it('rejects an empty CWD', () => {
        expect(validateCommitCwd(' ')).toContain('required');
    });

    it('rejects a relative CWD', () => {
        expect(validateCommitCwd('.')).toContain('absolute');
    });

    it('rejects a missing CWD', () => {
        expect(validateCommitCwd('/path/that/does/not/exist')).toContain(
            'not found',
        );
    });

    it('rejects files outside the supplied CWD', () => {
        expect(
            validateCommitFiles('/workspace/repo', ['../other/file.ts']),
        ).toContain('outside');
    });
});

describe('executeCommit', () => {
    it('should stage files, commit, and return SHA on success', async () => {
        let addArgs: string[][] = [];
        let commitArgs: string[][] = [];

        let addOpts: any[] = [];
        let commitOpts: any[] = [];

        const mockExec = mock(
            async (cmd: string, args: string[], opts?: any) => {
                if (cmd === 'git' && args[0] === 'add') {
                    addArgs.push(args);
                    addOpts.push(opts);
                    return { stdout: '' };
                }
                if (cmd === 'git' && args[0] === 'commit') {
                    commitArgs.push(args);
                    commitOpts.push(opts);
                    return { stdout: '' };
                }
                if (
                    cmd === 'git' &&
                    args[0] === 'rev-parse' &&
                    args[1] === '--is-inside-work-tree'
                ) {
                    return { stdout: 'true\n' };
                }
                if (cmd === 'git' && args[0] === 'rev-parse') {
                    return { stdout: 'abc1234\n' };
                }
                throw new Error(
                    'unexpected call: ' + cmd + ' ' + args.join(' '),
                );
            },
        );

        const result = await executeCommit(
            mockExec,
            ['src/foo.ts', 'src/bar.ts'],
            'feat: add foo',
            '/test/cwd',
        );

        expect(result).toEqual({ success: true, sha: 'abc1234' });
        expect(mockExec.mock.calls[0]).toEqual([
            'git',
            ['rev-parse', '--is-inside-work-tree'],
            { cwd: '/test/cwd' },
        ]);
        expect(addArgs).toEqual([['add', '--', 'src/foo.ts', 'src/bar.ts']]);
        expect(addOpts).toEqual([{ cwd: '/test/cwd' }]);
        expect(commitOpts).toEqual([{ cwd: '/test/cwd' }]);
        expect(commitArgs).toEqual([['commit', '-m', 'feat: add foo']]);
        expect(mockExec).toHaveBeenCalledTimes(4);
    });

    it('should return error when git add fails', async () => {
        const mockExec = mock(
            async (_cmd: string, _args: string[], _opts?: any) => {
                throw new Error(
                    "fatal: pathspec 'nonexistent.ts' did not match any files",
                );
            },
        );

        const result = await executeCommit(
            mockExec,
            ['nonexistent.ts'],
            'msg',
            '/test/cwd',
        );

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error).toContain('nonexistent.ts');
        }
    });

    it('should return error when git commit fails', async () => {
        const mockExec = mock(
            async (cmd: string, args: string[], _opts?: any) => {
                if (
                    cmd === 'git' &&
                    args[0] === 'rev-parse' &&
                    args[1] === '--is-inside-work-tree'
                ) {
                    return { stdout: 'true\n' };
                }
                if (cmd === 'git' && args[0] === 'add') {
                    return { stdout: '' };
                }
                throw new Error('nothing to commit');
            },
        );

        const result = await executeCommit(
            mockExec,
            ['a.ts'],
            'msg',
            '/test/cwd',
        );

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error).toBe('nothing to commit');
        }
    });

    it('should handle empty files array', async () => {
        const mockExec = mock(
            async (cmd: string, args: string[], _opts?: any) => {
                if (
                    cmd === 'git' &&
                    args[0] === 'rev-parse' &&
                    args[1] === '--is-inside-work-tree'
                ) {
                    return { stdout: 'true\n' };
                }
                if (cmd === 'git' && args[0] === 'add') {
                    return { stdout: '' };
                }
                if (cmd === 'git' && args[0] === 'commit') {
                    return { stdout: '' };
                }
                if (cmd === 'git' && args[0] === 'rev-parse') {
                    return { stdout: 'def5678\n' };
                }
                throw new Error('unexpected: ' + cmd + ' ' + args.join(' '));
            },
        );

        const result = await executeCommit(
            mockExec,
            [],
            'chore: empty',
            '/test/cwd',
        );

        expect(result).toEqual({ success: true, sha: 'def5678' });
    });
});
