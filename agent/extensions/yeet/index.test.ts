import { describe, it, expect, mock } from 'bun:test';

// Mock fd-utils to avoid spawning real fd in tests
let mockFdResults: string[] = [];
mock.module('../_shared/file-search/fd-utils', () => ({
    fdSearch: async () => mockFdResults,
}));

import yeetExtension, {
    executeCommit,
    validateCommitCwd,
    validateCommitFiles,
} from './index';

interface ProposeCommitPlanTool {
    execute: (
        toolCallId: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: unknown,
    ) => Promise<{ content: { text: string }[] }>;
}

function registerProposeCommitPlanTool(): ProposeCommitPlanTool {
    let registeredTool: ProposeCommitPlanTool | undefined;
    const pi = {
        exec: mock(async () => ({ stdout: 'true\n' })),
        appendEntry: mock(),
        on: mock(),
        registerCommand: mock(),
        registerTool: (tool: unknown) => {
            if ((tool as { name?: unknown }).name === 'propose_commit_plan') {
                registeredTool = tool as ProposeCommitPlanTool;
            }
        },
        sendUserMessage: mock(),
    };

    yeetExtension(pi as never);
    if (!registeredTool) {
        throw new Error('propose_commit_plan was not registered');
    }
    return registeredTool;
}

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

describe('propose_commit_plan rejection feedback', () => {
    it('returns the optional rejection reason to the agent', async () => {
        const proposeCommitPlan = registerProposeCommitPlanTool();
        const result = await proposeCommitPlan.execute(
            'tool-call-1',
            {
                cwd: process.cwd(),
                plan_summary: 'Test plan',
                files: ['target.ts'],
                commit_message: 'test: target',
            },
            undefined,
            undefined,
            {
                ui: {
                    custom: mock(async () => ({
                        accepted: false,
                        cancelled: false,
                        rejection_reason: 'Split the refactor from the fix.',
                        plan_summary: 'Test plan',
                        cwd: process.cwd(),
                        files: [],
                        commit_message: '',
                    })),
                },
            },
        );

        expect(result?.content[0].text).toContain(
            'Split the refactor from the fix.',
        );
    });

    it('tells the agent to produce a different plan when the reason is empty', async () => {
        const proposeCommitPlan = registerProposeCommitPlanTool();
        const result = await proposeCommitPlan.execute(
            'tool-call-2',
            {
                cwd: process.cwd(),
                plan_summary: 'Test plan',
                files: ['target.ts'],
                commit_message: 'test: target',
            },
            undefined,
            undefined,
            {
                ui: {
                    custom: mock(async () => ({
                        accepted: false,
                        cancelled: false,
                        rejection_reason: '   ',
                        plan_summary: 'Test plan',
                        cwd: process.cwd(),
                        files: [],
                        commit_message: '',
                    })),
                },
            },
        );

        expect(result?.content[0].text).toContain(
            'No specific reason provided; the user wants a different plan.',
        );
    });
});

describe('/yeet command', () => {
    it('restores an interrupted active transition on session reload', async () => {
        const handlers = new Map<
            string,
            (event: unknown, ctx: any) => Promise<void> | void
        >();
        const appendEntry = mock();
        const pi = {
            exec: mock(),
            appendEntry,
            on: (
                event: string,
                handler: (payload: unknown, ctx: any) => Promise<void> | void,
            ) => handlers.set(event, handler),
            registerTool: () => {},
            registerCommand: mock(),
            sendUserMessage: mock(),
        };
        const interrupted = {
            id: 'transition-entry-1',
            type: 'custom',
            customType: 'yeet:role-transition',
            data: {
                id: 'yeet-1',
                phase: 'active',
                previousRole: 'architect',
                targetCwd: '/repo',
                timestamp: 1,
            },
        };

        yeetExtension(pi as never);
        await handlers.get('session_start')?.(
            {},
            {
                sessionManager: { getEntries: () => [interrupted] },
                ui: { notify: mock() },
            },
        );

        expect(appendEntry).toHaveBeenCalledWith(
            'pi-roles:switch-request',
            expect.objectContaining({
                targetRole: 'architect',
                reason: 'command:yeet:restore',
            }),
        );
        expect(appendEntry).toHaveBeenCalledWith(
            'yeet:role-transition',
            expect.objectContaining({
                id: 'yeet-1',
                phase: 'completed',
            }),
        );
    });

    it('cancels a queued transition on reload instead of replaying stale work', async () => {
        const handlers = new Map<
            string,
            (event: unknown, ctx: any) => Promise<void> | void
        >();
        const appendEntry = mock();
        const notify = mock();
        const pi = {
            exec: mock(),
            appendEntry,
            on: (
                event: string,
                handler: (payload: unknown, ctx: any) => Promise<void> | void,
            ) => handlers.set(event, handler),
            registerTool: () => {},
            registerCommand: mock(),
            sendUserMessage: mock(),
        };
        const queued = {
            id: 'transition-entry-1',
            type: 'custom',
            customType: 'yeet:role-transition',
            data: {
                id: 'yeet-1',
                phase: 'queued',
                targetCwd: '/repo',
                timestamp: 1,
            },
        };

        yeetExtension(pi as never);
        await handlers.get('session_start')?.(
            {},
            {
                sessionManager: { getEntries: () => [queued] },
                ui: { notify },
            },
        );

        expect(appendEntry).toHaveBeenCalledWith(
            'yeet:role-transition',
            expect.objectContaining({ id: 'yeet-1', phase: 'cancelled' }),
        );
        expect(appendEntry).not.toHaveBeenCalledWith(
            'pi-roles:switch-request',
            expect.anything(),
        );
        expect(notify).toHaveBeenCalledWith(
            'Queued /yeet cancelled after reload; run it again',
            'warning',
        );
    });

    it('requests the commiter role before starting an idle Yeet run', async () => {
        let commandHandler:
            | ((args: string, ctx: any) => Promise<void>)
            | undefined;
        const events: string[] = [];
        const appendEntry = mock((customType: string) => {
            events.push(`append:${customType}`);
        });
        const sendUserMessage = mock(() => {
            events.push('send');
        });
        const pi = {
            exec: mock(async (_command: string, args: string[]) => ({
                stdout:
                    args[1] === '--short'
                        ? ' M target.ts\n'
                        : ' target.ts | 1 +\n',
            })),
            appendEntry,
            on: mock(),
            registerTool: () => {},
            registerCommand: (
                name: string,
                options: { handler: (args: string, ctx: any) => Promise<void> },
            ) => {
                if (name === 'yeet') commandHandler = options.handler;
            },
            sendUserMessage,
        };

        yeetExtension(pi as never);
        await commandHandler?.(`--cwd=${process.cwd()}`, {
            cwd: process.cwd(),
            isIdle: () => true,
            sessionManager: {
                getEntries: () => [
                    {
                        id: 'active-role-1',
                        type: 'custom',
                        customType: 'pi-roles:active-role',
                        data: {
                            name: 'architect',
                            source: 'global',
                            path: '/roles/architect.md',
                            appliedAt: 1,
                        },
                    },
                ],
            },
            ui: { notify: mock() },
        });

        expect(appendEntry).toHaveBeenCalledWith(
            'yeet:role-transition',
            expect.objectContaining({
                phase: 'active',
                previousRole: 'architect',
                targetCwd: process.cwd(),
            }),
        );
        expect(appendEntry).toHaveBeenCalledWith(
            'pi-roles:switch-request',
            expect.objectContaining({
                targetRole: 'commiter',
                reason: 'command:yeet',
            }),
        );
        expect(events).toEqual([
            'append:yeet:role-transition',
            'append:pi-roles:switch-request',
            'send',
        ]);
    });

    it('requests the previous role when the Yeet run ends', async () => {
        let commandHandler:
            | ((args: string, ctx: any) => Promise<void>)
            | undefined;
        const handlers = new Map<
            string,
            (event: unknown, ctx: any) => Promise<void> | void
        >();
        const appendEntry = mock();
        const pi = {
            exec: mock(async (_command: string, args: string[]) => ({
                stdout:
                    args[1] === '--short'
                        ? ' M target.ts\n'
                        : ' target.ts | 1 +\n',
            })),
            appendEntry,
            on: (
                event: string,
                handler: (payload: unknown, ctx: any) => Promise<void> | void,
            ) => handlers.set(event, handler),
            registerTool: () => {},
            registerCommand: (
                name: string,
                options: { handler: (args: string, ctx: any) => Promise<void> },
            ) => {
                if (name === 'yeet') commandHandler = options.handler;
            },
            sendUserMessage: mock(),
        };
        const ctx = {
            cwd: process.cwd(),
            isIdle: () => true,
            sessionManager: {
                getEntries: () => [
                    {
                        id: 'active-role-1',
                        type: 'custom',
                        customType: 'pi-roles:active-role',
                        data: {
                            name: 'architect',
                            source: 'global',
                            path: '/roles/architect.md',
                            appliedAt: 1,
                        },
                    },
                ],
            },
            ui: { notify: mock() },
        };

        yeetExtension(pi as never);
        await commandHandler?.(`--cwd=${process.cwd()}`, ctx);
        await handlers.get('agent_end')?.({}, ctx);

        expect(appendEntry).toHaveBeenCalledWith(
            'pi-roles:switch-request',
            expect.objectContaining({
                targetRole: 'architect',
                reason: 'command:yeet:restore',
            }),
        );
        expect(appendEntry).toHaveBeenCalledWith(
            'yeet:role-transition',
            expect.objectContaining({
                phase: 'completed',
                previousRole: 'architect',
                targetCwd: process.cwd(),
            }),
        );
    });

    it('queues a busy Yeet without inspecting Git or sending a follow-up', async () => {
        let commandHandler:
            | ((args: string, ctx: any) => Promise<void>)
            | undefined;
        const exec = mock(async () => ({ stdout: ' M target.ts\n' }));
        const sendUserMessage = mock();
        const notify = mock();
        const pi = {
            exec,
            appendEntry: mock(),
            on: mock(),
            registerTool: () => {},
            registerCommand: (
                name: string,
                options: { handler: (args: string, ctx: any) => Promise<void> },
            ) => {
                if (name === 'yeet') commandHandler = options.handler;
            },
            sendUserMessage,
        };

        yeetExtension(pi as never);
        await commandHandler?.(`--cwd=${process.cwd()}`, {
            cwd: process.cwd(),
            isIdle: () => false,
            sessionManager: { getEntries: () => [] },
            ui: { notify },
        });

        expect(exec).not.toHaveBeenCalled();
        expect(sendUserMessage).not.toHaveBeenCalled();
        expect(pi.appendEntry).toHaveBeenCalledWith(
            'yeet:role-transition',
            expect.objectContaining({
                phase: 'queued',
                targetCwd: process.cwd(),
            }),
        );
        expect(notify).toHaveBeenCalledWith(
            'Queued /yeet until the current agent run finishes',
            'info',
        );
    });

    it('starts a queued Yeet as a fresh top-level run once Pi is idle', async () => {
        let commandHandler:
            | ((args: string, ctx: any) => Promise<void>)
            | undefined;
        const handlers = new Map<
            string,
            (event: unknown, ctx: any) => Promise<void> | void
        >();
        const exec = mock(async (_command: string, args: string[]) => ({
            stdout:
                args[1] === '--short' ? ' M target.ts\n' : ' target.ts | 1 +\n',
        }));
        const appendEntry = mock();
        const sendUserMessage = mock();
        const pi = {
            exec,
            appendEntry,
            on: (
                event: string,
                handler: (payload: unknown, ctx: any) => Promise<void> | void,
            ) => handlers.set(event, handler),
            registerTool: () => {},
            registerCommand: (
                name: string,
                options: { handler: (args: string, ctx: any) => Promise<void> },
            ) => {
                if (name === 'yeet') commandHandler = options.handler;
            },
            sendUserMessage,
        };
        let idle = false;
        const ctx = {
            cwd: process.cwd(),
            isIdle: () => idle,
            sessionManager: { getEntries: () => [] },
            ui: { notify: mock() },
        };

        yeetExtension(pi as never);
        await commandHandler?.(`--cwd=${process.cwd()}`, ctx);
        idle = true;
        await handlers.get('agent_end')?.({}, ctx);
        await new Promise((resolve) => setTimeout(resolve, 5));

        expect(exec).toHaveBeenCalledTimes(2);
        expect(appendEntry).toHaveBeenCalledWith(
            'pi-roles:switch-request',
            expect.objectContaining({ targetRole: 'commiter' }),
        );
        expect(sendUserMessage).toHaveBeenCalledTimes(1);
        expect(sendUserMessage.mock.calls[0]).toHaveLength(1);
    });

    it('cancels persisted queue state when the deferred worktree is clean', async () => {
        let commandHandler:
            | ((args: string, ctx: any) => Promise<void>)
            | undefined;
        const handlers = new Map<
            string,
            (event: unknown, ctx: any) => Promise<void> | void
        >();
        const appendEntry = mock();
        const pi = {
            exec: mock(async () => ({ stdout: '' })),
            appendEntry,
            on: (
                event: string,
                handler: (payload: unknown, ctx: any) => Promise<void> | void,
            ) => handlers.set(event, handler),
            registerTool: () => {},
            registerCommand: (
                name: string,
                options: { handler: (args: string, ctx: any) => Promise<void> },
            ) => {
                if (name === 'yeet') commandHandler = options.handler;
            },
            sendUserMessage: mock(),
        };
        let idle = false;
        const ctx = {
            cwd: process.cwd(),
            isIdle: () => idle,
            sessionManager: { getEntries: () => [] },
            ui: { notify: mock() },
        };

        yeetExtension(pi as never);
        await commandHandler?.(`--cwd=${process.cwd()}`, ctx);
        idle = true;
        await handlers.get('agent_end')?.({}, ctx);
        await new Promise((resolve) => setTimeout(resolve, 5));

        expect(appendEntry).toHaveBeenCalledWith(
            'yeet:role-transition',
            expect.objectContaining({ phase: 'cancelled' }),
        );
        expect(appendEntry).not.toHaveBeenCalledWith(
            'pi-roles:switch-request',
            expect.anything(),
        );
    });

    it('rejects a second Yeet while one is already queued', async () => {
        let commandHandler:
            | ((args: string, ctx: any) => Promise<void>)
            | undefined;
        const notify = mock();
        const pi = {
            exec: mock(),
            appendEntry: mock(),
            on: mock(),
            registerTool: () => {},
            registerCommand: (
                name: string,
                options: { handler: (args: string, ctx: any) => Promise<void> },
            ) => {
                if (name === 'yeet') commandHandler = options.handler;
            },
            sendUserMessage: mock(),
        };
        const ctx = {
            cwd: process.cwd(),
            isIdle: () => false,
            sessionManager: { getEntries: () => [] },
            ui: { notify },
        };

        yeetExtension(pi as never);
        await commandHandler?.(`--cwd=${process.cwd()} first`, ctx);
        await commandHandler?.(`--cwd=${process.cwd()} second`, ctx);

        expect(notify).toHaveBeenLastCalledWith(
            'A /yeet command is already queued',
            'warning',
        );
    });

    it('rejects another Yeet while a Yeet run is active', async () => {
        let commandHandler:
            | ((args: string, ctx: any) => Promise<void>)
            | undefined;
        const notify = mock();
        const pi = {
            exec: mock(async (_command: string, args: string[]) => ({
                stdout:
                    args[1] === '--short'
                        ? ' M target.ts\n'
                        : ' target.ts | 1 +\n',
            })),
            appendEntry: mock(),
            on: mock(),
            registerTool: () => {},
            registerCommand: (
                name: string,
                options: { handler: (args: string, ctx: any) => Promise<void> },
            ) => {
                if (name === 'yeet') commandHandler = options.handler;
            },
            sendUserMessage: mock(),
        };
        let idle = true;
        const ctx = {
            cwd: process.cwd(),
            isIdle: () => idle,
            sessionManager: { getEntries: () => [] },
            ui: { notify },
        };

        yeetExtension(pi as never);
        await commandHandler?.(`--cwd=${process.cwd()} first`, ctx);
        idle = false;
        await commandHandler?.(`--cwd=${process.cwd()} second`, ctx);

        expect(notify).toHaveBeenLastCalledWith(
            'A /yeet workflow is already active',
            'warning',
        );
    });

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
            appendEntry: mock(),
            on: mock(),
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
            appendEntry: mock(),
            on: mock(),
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

    it('does not switch roles when the selected worktree is clean', async () => {
        let commandHandler:
            | ((args: string, ctx: any) => Promise<void>)
            | undefined;
        const appendEntry = mock();
        const sendUserMessage = mock();
        const notify = mock();
        const pi = {
            exec: mock(async () => ({ stdout: '' })),
            appendEntry,
            on: mock(),
            registerTool: () => {},
            registerCommand: (
                name: string,
                options: { handler: (args: string, ctx: any) => Promise<void> },
            ) => {
                if (name === 'yeet') commandHandler = options.handler;
            },
            sendUserMessage,
        };

        yeetExtension(pi as never);
        await commandHandler?.(`--cwd=${process.cwd()}`, {
            cwd: process.cwd(),
            isIdle: () => true,
            sessionManager: { getEntries: () => [] },
            ui: { notify },
        });

        expect(appendEntry).not.toHaveBeenCalled();
        expect(sendUserMessage).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalledWith(
            `Working tree is clean: ${process.cwd()}`,
            'info',
        );
    });

    it('restores the previous role when the Yeet prompt cannot start', async () => {
        let commandHandler:
            | ((args: string, ctx: any) => Promise<void>)
            | undefined;
        const appendEntry = mock();
        const notify = mock();
        const pi = {
            exec: mock(async (_command: string, args: string[]) => ({
                stdout:
                    args[1] === '--short'
                        ? ' M target.ts\n'
                        : ' target.ts | 1 +\n',
            })),
            appendEntry,
            on: mock(),
            registerTool: () => {},
            registerCommand: (
                name: string,
                options: { handler: (args: string, ctx: any) => Promise<void> },
            ) => {
                if (name === 'yeet') commandHandler = options.handler;
            },
            sendUserMessage: mock(() => {
                throw new Error('prompt failed');
            }),
        };
        let thrown: unknown;

        yeetExtension(pi as never);
        try {
            await commandHandler?.(`--cwd=${process.cwd()}`, {
                cwd: process.cwd(),
                isIdle: () => true,
                sessionManager: {
                    getEntries: () => [
                        {
                            id: 'active-role-1',
                            type: 'custom',
                            customType: 'pi-roles:active-role',
                            data: {
                                name: 'architect',
                                source: 'global',
                                path: '/roles/architect.md',
                                appliedAt: 1,
                            },
                        },
                    ],
                },
                ui: { notify },
            });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeUndefined();
        expect(appendEntry).toHaveBeenCalledWith(
            'pi-roles:switch-request',
            expect.objectContaining({
                targetRole: 'architect',
                reason: 'command:yeet:restore',
            }),
        );
        expect(notify).toHaveBeenCalledWith(
            'Unable to start /yeet: prompt failed',
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
                    return { stdout: args[1] === '--short' ? 'abc1234\n' : 'main\n' };
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

        expect(result).toEqual({ success: true, sha: 'abc1234', branch: 'main' });
        expect(mockExec.mock.calls[0]).toEqual([
            'git',
            ['rev-parse', '--is-inside-work-tree'],
            { cwd: '/test/cwd', timeout: 30_000 },
        ]);
        expect(addArgs).toEqual([['add', '--', 'src/foo.ts', 'src/bar.ts']]);
        expect(addOpts).toEqual([{ cwd: '/test/cwd', timeout: 30_000 }]);
        expect(commitOpts).toEqual([{ cwd: '/test/cwd', timeout: 30_000 }]);
        expect(commitArgs).toEqual([['commit', '-m', 'feat: add foo']]);
        expect(mockExec).toHaveBeenCalledTimes(5);
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
                    return { stdout: args[1] === '--short' ? 'def5678\n' : 'main\n' };
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

        expect(result).toEqual({ success: true, sha: 'def5678', branch: 'main' });
    });
});

describe('/yeet getArgumentCompletions', () => {
    it('returns directory suggestions for --cwd=<path>', async () => {
        let completionsFn: ((prefix: string) => Promise<any>) | undefined;

        mockFdResults = ['/tmp/foo/src', '/tmp/foo/tests'];

        const pi = {
            exec: mock(async () => ({ stdout: '' })),
            on: mock(),
            registerTool: () => {},
            registerCommand: (
                _name: string,
                options: {
                    getArgumentCompletions?: (prefix: string) => Promise<any>;
                },
            ) => {
                completionsFn = options.getArgumentCompletions;
            },
            sendUserMessage: mock(),
        };

        yeetExtension(pi as never);

        const result = await completionsFn?.('--cwd=/tmp/');
        expect(result).toBeDefined();
        expect(result.length).toBe(2);
        expect(result[0].label).toBe('src');
        expect(result[1].label).toBe('tests');
    });

    it('returns null when no --cwd in prefix', async () => {
        let completionsFn: ((prefix: string) => Promise<any>) | undefined;

        const pi = {
            exec: mock(async () => ({ stdout: '' })),
            on: mock(),
            registerTool: () => {},
            registerCommand: (
                _name: string,
                options: {
                    getArgumentCompletions?: (prefix: string) => Promise<any>;
                },
            ) => {
                completionsFn = options.getArgumentCompletions;
            },
            sendUserMessage: mock(),
        };

        yeetExtension(pi as never);

        const result = await completionsFn?.('--go commit docs');
        expect(result).toBeNull();
    });

    it('returns null for empty --cwd= value', async () => {
        let completionsFn: ((prefix: string) => Promise<any>) | undefined;

        const pi = {
            exec: mock(async () => ({ stdout: '' })),
            on: mock(),
            registerTool: () => {},
            registerCommand: (
                _name: string,
                options: {
                    getArgumentCompletions?: (prefix: string) => Promise<any>;
                },
            ) => {
                completionsFn = options.getArgumentCompletions;
            },
            sendUserMessage: mock(),
        };

        yeetExtension(pi as never);

        const result = await completionsFn?.('--cwd=');
        expect(result).toBeNull();
    });
});

// ── Commit UX feedback (working message, branch/stderr reporting, renderResult) ──

describe('propose_commit_plan commit feedback', () => {
    interface ToolWithRender {
        execute: (
            toolCallId: string,
            params: unknown,
            signal: AbortSignal | undefined,
            onUpdate: unknown,
            ctx: unknown,
        ) => Promise<{ content: { text: string }[]; details?: unknown }>;
        renderResult?: (
            result: unknown,
            options: unknown,
            theme: unknown,
            context: unknown,
        ) => { render: (width: number) => string[] };
    }

    function registerFeedbackTool(
        execImpl?: (
            cmd: string,
            args: string[],
            opts?: Record<string, unknown>,
        ) => Promise<{ stdout: string; stderr?: string }>,
    ): {
        tool: ToolWithRender;
        setWorkingMessage: ReturnType<typeof mock>;
        setStatus: ReturnType<typeof mock>;
    } {
        let registeredTool: ToolWithRender | undefined;
        const setWorkingMessage = mock();
        const setStatus = mock();

        const pi = {
            exec: mock(
                execImpl ??
                    (async (
                        _cmd: string,
                        args: string[],
                    ): Promise<{ stdout: string; stderr: string }> => {
                        if (
                            args[0] === 'rev-parse' &&
                            args[1] === '--is-inside-work-tree'
                        )
                            return { stdout: 'true\n', stderr: '' };
                        if (args[0] === 'rev-parse' && args[1] === '--short')
                            return { stdout: 'abc1234\n', stderr: '' };
                        if (args[0] === 'rev-parse')
                            return { stdout: 'main\n', stderr: '' };
                        return { stdout: '', stderr: '' };
                    }),
            ),
            appendEntry: mock(),
            on: mock(),
            registerCommand: mock(),
            registerTool: (tool: unknown) => {
                if ((tool as { name?: unknown }).name === 'propose_commit_plan') {
                    registeredTool = tool as ToolWithRender;
                }
            },
            sendUserMessage: mock(),
        };

        yeetExtension(pi as never);
        if (!registeredTool) throw new Error('propose_commit_plan was not registered');

        (registeredTool as unknown as { __ui?: unknown }).__ui = undefined;
        return {
            tool: registeredTool,
            setWorkingMessage,
            setStatus,
        };
    }

    function acceptedCtx(setWorkingMessage: unknown, setStatus: unknown) {
        return {
            ui: {
                custom: mock(async () => ({
                    accepted: true,
                    cancelled: false,
                    plan_summary: 's',
                    cwd: process.cwd(),
                    files: ['a.ts'],
                    commit_message: 'test: msg',
                })),
                setWorkingMessage,
                setStatus,
            },
        };
    }

    it('shows and clears a working/status indicator around the commit', async () => {
        const { tool, setWorkingMessage, setStatus } = registerFeedbackTool();

        await tool.execute(
            'tc-ux-1',
            {
                cwd: process.cwd(),
                plan_summary: 's',
                files: ['a.ts'],
                commit_message: 'test: msg',
            },
            undefined,
            undefined,
            acceptedCtx(setWorkingMessage, setStatus),
        );

        expect(setWorkingMessage).toHaveBeenCalled();
        const firstMsg = String(setWorkingMessage.mock.calls[0]?.[0] ?? '');
        expect(firstMsg).toContain('Committing');

        const lastWorking =
            setWorkingMessage.mock.calls[setWorkingMessage.mock.calls.length - 1];
        expect(lastWorking.length).toBe(0);

        expect(setStatus).toHaveBeenCalledWith('yeet', expect.stringContaining('Committing'));
        expect(setStatus).toHaveBeenLastCalledWith('yeet', undefined);
    });

    it('reports branch, sha, duration and the post-edit file list on success', async () => {
        const { tool } = registerFeedbackTool();

        const result = await tool.execute(
            'tc-ux-2',
            {
                cwd: process.cwd(),
                plan_summary: 's',
                files: ['a.ts'],
                commit_message: 'test: msg',
            },
            undefined,
            undefined,
            acceptedCtx(mock(), mock()),
        );

        const text = result.content[0].text;
        expect(text).toContain('abc1234');
        expect(text).toContain('Branch: main');
        expect(text).toContain('user'); // post-edit provenance note
        expect(result.details).toMatchObject({ sha: 'abc1234', branch: 'main' });
    });

    it('includes a stderr excerpt when the automatic commit fails', async () => {
        const failErr = Object.assign(
            new Error('git failed'),
            { stderr: 'fatal: nothing to commit, working tree clean' },
        );
        const { tool } = registerFeedbackTool(async (_cmd, args) => {
            if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree')
                return { stdout: 'true\n', stderr: '' };
            if (args[0] === 'add') return { stdout: '', stderr: '' };
            throw failErr;
        });

        const result = await tool.execute(
            'tc-ux-3',
            {
                cwd: process.cwd(),
                plan_summary: 's',
                files: ['a.ts'],
                commit_message: 'test: msg',
            },
            undefined,
            undefined,
            acceptedCtx(mock(), mock()),
        );

        const text = result.content[0].text;
        expect(text).toContain('nothing to commit');
    });

    it('bounds every git call with a timeout', async () => {
        const optsSeen: Array<Record<string, unknown> | undefined> = [];
        const mockExec = mock(async (_c: string, _a: string[], o?: Record<string, unknown>) => {
            optsSeen.push(o);
            if (optsSeen.length >= 5)
                return { stdout: 'main\n', stderr: '' };
            if (_a[0] === 'rev-parse' && _a[1] === '--short')
                return { stdout: 'abc1234\n', stderr: '' };
            return { stdout: 'true\n', stderr: '' };
        });

        await executeCommit(mockExec, ['a.ts'], 'msg', '/test/cwd');

        expect(optsSeen.length).toBeGreaterThan(0);
        for (const opts of optsSeen) {
            expect(opts?.timeout).toBe(30_000);
        }
    });

    it('renders a colored success summary from details', () => {
        const { tool } = registerFeedbackTool();
        if (!tool.renderResult) throw new Error('renderResult missing');

        const component = tool.renderResult(
            { content: [], details: { accepted: true, cancelled: false, sha: 'abc1234', branch: 'main', durationMs: 1200, cwd: '/repo', files: ['a.ts', 'b.ts'], plan_summary: '', commit_message: '' } },
            { expanded: true, isPartial: false },
            { fg: (color: string, t: string) => `[${color}]${t}` },
            { toolCallId: 't1' },
        );

        const rendered = component.render(100).join('\n');
        expect(rendered).toContain('abc1234');
        expect(rendered).toContain('success');
        expect(rendered).toContain('a.ts');
    });

    it('renders a failure summary from details', () => {
        const { tool } = registerFeedbackTool();
        if (!tool.renderResult) throw new Error('renderResult missing');

        const component = tool.renderResult(
            { content: [], details: { accepted: true, cancelled: false, commitError: 'boom', commitStderr: 'fatal: bad', cwd: '/repo', files: ['a.ts'], plan_summary: '', commit_message: '' } },
            { expanded: true, isPartial: false },
            { fg: (color: string, t: string) => `[${color}]${t}` },
            { toolCallId: 't2' },
        );

        const rendered = component.render(100).join('\n');
        expect(rendered).toContain('error');
        expect(rendered).toContain('fatal: bad');
    });
});
