import { describe, it, expect, mock } from 'bun:test';
import yeetExtension, {
    executeCommit,
    validateCommitCwd,
    validateCommitFiles,
} from './index';

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

describe('/yeet command', () => {
    it('uses --cwd for Git inspection and the generated commit prompt', async () => {
        let commandHandler:
            | ((args: string, ctx: any) => Promise<void>)
            | undefined;
        const exec = mock(
            async (
                _command: string,
                args: string[],
                _options?: { cwd?: string },
            ) => ({
                stdout:
                    args[1] === '--short'
                        ? ' M target.ts\n'
                        : ' target.ts | 1 +\n',
            }),
        );
        const sendUserMessage = mock();
        const pi = {
            exec,
            registerTool: () => {},
            registerCommand: (
                name: string,
                options: { handler: (args: string, ctx: any) => Promise<void> },
            ) => {
                if (name === 'yeet') commandHandler = options.handler;
            },
            sendUserMessage,
        };
        const targetCwd = process.cwd();

        yeetExtension(pi as never);
        await commandHandler?.(`--cwd=${targetCwd} commit target only`, {
            cwd: '/fallback/repo',
            isIdle: () => true,
            ui: { notify: mock() },
        });

        expect(exec).toHaveBeenCalledTimes(2);
        expect(
            exec.mock.calls.every((call) => call[2]?.cwd === targetCwd),
        ).toBe(true);
        expect(sendUserMessage).toHaveBeenCalledTimes(1);
        expect(sendUserMessage.mock.calls[0][0]).toContain(
            `Required commit CWD: ${targetCwd}`,
        );
        expect(sendUserMessage.mock.calls[0][0]).toContain(
            'commit target only',
        );
    });

    it('stops when the selected CWD cannot be inspected as a Git repository', async () => {
        let commandHandler:
            | ((args: string, ctx: any) => Promise<void>)
            | undefined;
        const exec = mock(async () => {
            throw new Error('not a git repository');
        });
        const sendUserMessage = mock();
        const notify = mock();

        yeetExtension({
            exec,
            registerTool: () => {},
            registerCommand: (
                name: string,
                options: { handler: (args: string, ctx: any) => Promise<void> },
            ) => {
                if (name === 'yeet') commandHandler = options.handler;
            },
            sendUserMessage,
        } as never);

        await commandHandler?.(`--cwd=${process.cwd()}`, {
            cwd: '/fallback/repo',
            isIdle: () => true,
            ui: { notify },
        });

        expect(sendUserMessage).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalledWith(
            expect.stringContaining('Git repository'),
            'error',
        );
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
