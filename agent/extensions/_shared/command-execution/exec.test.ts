import { describe, expect, it, mock, spyOn } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

let accessFailure: Error | null = null;
mock.module('node:fs/promises', () => ({
    access: async () => {
        if (accessFailure) throw accessFailure;
    },
}));
mock.module('@earendil-works/pi-coding-agent', () => ({
    getShellConfig: (shellPath?: string) => ({
        shell: shellPath ?? '/bin/bash',
        args: ['-c'],
    }),
}));

const {
    MAX_STDIN_BYTES,
    bashWithStdinSchema,
    createBashOperations,
    createBashProcessSupervisor,
} = await import('./exec');

type SpawnCall = {
    command: string;
    args: string[];
    options: SpawnOptions;
};

class MockStdin extends EventEmitter {
    end = mock(
        (
            _input?: string,
            _encoding?: string,
            _callback?: (error?: Error) => void,
        ) => undefined,
    );
}

class MockChild extends EventEmitter {
    pid: number | undefined;
    kill = mock(() => true);
    stdout = new PassThrough();
    stderr = new PassThrough();
    stdin: MockStdin | null = new MockStdin();

    close(exitCode = 0): void {
        this.emit('exit', exitCode);
        this.stdout.end();
        this.stderr.end();
        this.emit('close', exitCode);
    }
}

function createSpawnHarness(pid?: number) {
    const calls: SpawnCall[] = [];
    const children: MockChild[] = [];
    const spawn = mock((command: string, args: string[], options: SpawnOptions) => {
        const child = new MockChild();
        child.pid = pid;
        if (Array.isArray(options.stdio) && options.stdio[0] === 'ignore') {
            child.stdin = null;
        }
        calls.push({ command, args, options });
        children.push(child);
        return child as unknown as ChildProcess;
    });
    return { calls, children, spawn };
}

async function nextTurn(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

describe('bashWithStdinSchema', () => {
    it('declares command plus optional timeout and stdin', () => {
        expect(bashWithStdinSchema.required).toEqual(['command']);
        expect(bashWithStdinSchema.properties.command.type).toBe('string');
        expect(bashWithStdinSchema.properties.timeout.type).toBe('number');
        expect(bashWithStdinSchema.properties.stdin.type).toBe('string');
    });
});

describe('createBashOperations', () => {
    it('keeps stdin closed when no payload is supplied', async () => {
        const harness = createSpawnHarness();
        const operations = createBashOperations({ spawn: harness.spawn });
        const execution = operations.exec('printf ok', '/tmp', { onData: () => undefined });
        await nextTurn();

        const stdio = harness.calls[0]?.options.stdio;
        harness.children[0]?.close();
        await expect(execution).resolves.toEqual({ exitCode: 0 });
        expect(stdio).toEqual(['ignore', 'pipe', 'pipe']);
    });

    it('writes exact UTF-8 stdin once and closes it', async () => {
        const harness = createSpawnHarness();
        const operations = createBashOperations({ stdin: 'alpha\nbêta', spawn: harness.spawn });
        const execution = operations.exec('cat', '/tmp', { onData: () => undefined });
        await nextTurn();

        const stdio = harness.calls[0]?.options.stdio;
        const end = harness.children[0]?.stdin?.end;
        const callback = end?.mock.calls[0]?.[2] as
            | ((error?: Error) => void)
            | undefined;
        callback?.();
        harness.children[0]?.close();
        await expect(execution).resolves.toEqual({ exitCode: 0 });
        expect(stdio).toEqual(['pipe', 'pipe', 'pipe']);
        expect(end).toHaveBeenCalledWith(
            'alpha\nbêta',
            'utf8',
            expect.any(Function),
        );
    });

    it('accepts a payload exactly at the UTF-8 byte limit', async () => {
        const harness = createSpawnHarness();
        const operations = createBashOperations({
            stdin: 'é'.repeat(MAX_STDIN_BYTES / 2),
            spawn: harness.spawn,
        });
        const execution = operations.exec('cat', '/tmp', {
            onData: () => undefined,
        });
        await nextTurn();

        const end = harness.children[0]?.stdin?.end;
        const callback = end?.mock.calls[0]?.[2] as
            | ((error?: Error) => void)
            | undefined;
        callback?.();
        harness.children[0]?.close();

        await expect(execution).resolves.toEqual({ exitCode: 0 });
        expect(harness.spawn).toHaveBeenCalledTimes(1);
    });

    it('rejects a payload above the UTF-8 byte limit before spawn', async () => {
        const harness = createSpawnHarness();
        const operations = createBashOperations({
            stdin: 'é'.repeat(MAX_STDIN_BYTES / 2 + 1),
            spawn: harness.spawn,
        });

        await expect(
            operations.exec('cat', '/tmp', { onData: () => undefined }),
        ).rejects.toThrow(`stdin exceeds ${MAX_STDIN_BYTES} UTF-8 bytes`);
        expect(harness.spawn).not.toHaveBeenCalled();
    });

    it('rejects non-string stdin before spawn when runtime validation is bypassed', () => {
        const harness = createSpawnHarness();
        expect(() =>
            createBashOperations({
                stdin: 42 as unknown as string,
                spawn: harness.spawn,
            }),
        ).toThrow();
        expect(harness.spawn).not.toHaveBeenCalled();
    });

    it('rejects a missing cwd before spawn', async () => {
        const harness = createSpawnHarness();
        accessFailure = new Error('missing');
        try {
            const operations = createBashOperations({ spawn: harness.spawn });
            await expect(
                operations.exec('true', '/missing', {
                    onData: () => undefined,
                }),
            ).rejects.toThrow('Working directory does not exist: /missing');
            expect(harness.spawn).not.toHaveBeenCalled();
        } finally {
            accessFailure = null;
        }
    });

    it('cleans a prepared spawn when cwd validation fails', async () => {
        const cleanup = mock(async () => undefined);
        accessFailure = new Error('missing');
        try {
            const operations = createBashOperations({
                prepareSpawn: async ({ cwd, env }) => ({
                    file: '/managed/zerobox',
                    args: [],
                    cwd,
                    env,
                    extraStdio: ['pipe'],
                    supervise: () => ({
                        ready: Promise.resolve(),
                        settled: Promise.resolve(),
                    }),
                    cleanup,
                }),
            });
            await expect(
                operations.exec('true', '/missing', {
                    onData: () => undefined,
                }),
            ).rejects.toThrow('Working directory does not exist: /missing');
            expect(cleanup).toHaveBeenCalledTimes(1);
        } finally {
            accessFailure = null;
        }
    });

    it('cleans a prepared spawn when the signal aborts during preparation', async () => {
        const cleanup = mock(async () => undefined);
        const controller = new AbortController();
        const operations = createBashOperations({
            prepareSpawn: async ({ cwd, env }) => {
                controller.abort();
                return {
                    file: '/managed/zerobox',
                    args: [],
                    cwd,
                    env,
                    extraStdio: ['pipe'],
                    supervise: () => ({
                        ready: Promise.resolve(),
                        settled: Promise.resolve(),
                    }),
                    cleanup,
                };
            },
        });

        await expect(
            operations.exec('true', '/tmp', {
                onData: () => undefined,
                signal: controller.signal,
            }),
        ).rejects.toThrow('aborted');
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('merges stdout and stderr in observed arrival order', async () => {
        const harness = createSpawnHarness();
        const chunks: string[] = [];
        const operations = createBashOperations({ spawn: harness.spawn });
        const execution = operations.exec('anything', '/tmp', {
            onData: (chunk) => chunks.push(chunk.toString()),
        });
        await nextTurn();

        harness.children[0]?.stdout.write('out');
        harness.children[0]?.stderr.write('err');
        harness.children[0]?.close();

        await execution;
        expect(chunks).toEqual(['out', 'err']);
    });

    it('lets command preparation change command, cwd, and environment', async () => {
        const harness = createSpawnHarness();
        const operations = createBashOperations({
            spawn: harness.spawn,
            prepareCommand: async ({ command, cwd, env }) => ({
                command: `wrapped ${command}`,
                cwd: `${cwd}/sandbox`,
                env: { ...env, SANDBOXED: '1' },
            }),
        });
        const execution = operations.exec('echo ok', '/tmp', { onData: () => undefined });
        await nextTurn();

        const call = harness.calls[0];
        harness.children[0]?.close();
        await execution;
        expect(call).toMatchObject({
            args: ['-c', 'wrapped echo ok'],
            options: {
                cwd: '/tmp/sandbox',
                env: expect.objectContaining({ SANDBOXED: '1' }),
            },
        });
    });

    it('spawns prepared argv with fd 3 and supervises readiness before stdin', async () => {
        const harness = createSpawnHarness();
        const ready = deferred();
        const settled = deferred();
        const events: string[] = [];
        const supervise = mock(() => {
            events.push('supervise');
            return { ready: ready.promise, settled: settled.promise };
        });
        const prepareSpawn = mock(async ({ command, cwd, env }) => ({
            file: '/managed/zerobox',
            args: ['--status-fd=3', '--', '/bin/bash', '-c', command],
            cwd: `${cwd}/prepared`,
            env: { ...env, ZEROBOX_HOME: '/private/zbx' },
            extraStdio: ['pipe'] as const,
            supervise,
        }));
        const operations = createBashOperations({
            stdin: 'exact input',
            spawn: harness.spawn,
            rewriteCommand: (command) => `${command} rewritten`,
            prepareSpawn,
        });
        const execution = operations.exec('printf ok', '/tmp', {
            onData: () => undefined,
        });
        let resolved = false;
        void execution.then(() => {
            resolved = true;
        });
        await nextTurn();

        expect(prepareSpawn).toHaveBeenCalledWith(
            expect.objectContaining({
                command: 'printf ok rewritten',
                cwd: '/tmp',
            }),
        );
        expect(harness.calls[0]).toEqual({
            command: '/managed/zerobox',
            args: [
                '--status-fd=3',
                '--',
                '/bin/bash',
                '-c',
                'printf ok rewritten',
            ],
            options: expect.objectContaining({
                cwd: '/tmp/prepared',
                env: expect.objectContaining({ ZEROBOX_HOME: '/private/zbx' }),
                stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
            }),
        });
        expect(events).toEqual(['supervise']);
        expect(harness.children[0]?.stdin?.end).not.toHaveBeenCalled();

        ready.resolve();
        await nextTurn();
        expect(harness.children[0]?.stdin?.end).toHaveBeenCalledTimes(1);
        const stdinCallback = harness.children[0]?.stdin?.end.mock.calls[0]?.[2] as
            | ((error?: Error) => void)
            | undefined;
        stdinCallback?.();
        harness.children[0]?.close(0);
        await nextTurn();
        expect(resolved).toBe(false);

        settled.resolve();
        await expect(execution).resolves.toEqual({ exitCode: 0 });
    });

    it('revalidates a prepared spawn atomically and cleans it when invalidated', async () => {
        const harness = createSpawnHarness();
        const cleanup = mock(async () => undefined);
        const beforeSpawn = mock(() => {
            throw new Error('prepared spawn invalidated');
        });
        const operations = createBashOperations({
            spawn: harness.spawn,
            prepareSpawn: async ({ cwd, env }) => ({
                file: '/managed/zerobox',
                args: ['--status-fd=3'],
                cwd,
                env,
                extraStdio: ['pipe'],
                beforeSpawn,
                cleanup,
                supervise: () => ({
                    ready: Promise.resolve(),
                    settled: Promise.resolve(),
                }),
            }),
        });

        await expect(
            operations.exec('true', '/tmp', { onData: () => undefined }),
        ).rejects.toThrow('prepared spawn invalidated');
        expect(beforeSpawn).toHaveBeenCalledTimes(1);
        expect(harness.spawn).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('rejects prepareCommand and prepareSpawn composition before spawning', () => {
        const harness = createSpawnHarness();
        expect(() =>
            createBashOperations({
                spawn: harness.spawn,
                prepareCommand: (context) => context,
                prepareSpawn: async () => ({
                    file: '/managed/zerobox',
                    args: [],
                    cwd: '/tmp',
                    env: {},
                    extraStdio: ['pipe'],
                    supervise: () => ({
                        ready: Promise.resolve(),
                        settled: Promise.resolve(),
                    }),
                }),
            }),
        ).toThrow('prepareCommand and prepareSpawn cannot be combined');
        expect(harness.spawn).not.toHaveBeenCalled();
    });

    it('kills the prepared process and runs cleanup when readiness fails', async () => {
        const harness = createSpawnHarness();
        const afterClose = mock(async () => undefined);
        const operations = createBashOperations({
            spawn: harness.spawn,
            afterClose,
            prepareSpawn: async ({ cwd, env }) => ({
                file: '/managed/zerobox',
                args: ['--status-fd=3'],
                cwd,
                env,
                extraStdio: ['pipe'],
                supervise: () => ({
                    ready: Promise.reject(new Error('setup protocol failed')),
                    settled: Promise.resolve(),
                }),
            }),
        });

        await expect(
            operations.exec('true', '/tmp', { onData: () => undefined }),
        ).rejects.toThrow('setup protocol failed');
        expect(harness.children[0]?.kill).toHaveBeenCalledWith('SIGTERM');
        expect(afterClose).toHaveBeenCalledTimes(1);
    });

    it('kills the prepared process when status settlement fails after readiness', async () => {
        const harness = createSpawnHarness();
        const settled = deferred();
        const protocolFailure = new Error('status protocol failed');
        const operations = createBashOperations({
            spawn: harness.spawn,
            prepareSpawn: async ({ cwd, env }) => ({
                file: '/managed/zerobox',
                args: ['--status-fd=3'],
                cwd,
                env,
                extraStdio: ['pipe'],
                supervise: () => ({
                    ready: Promise.resolve(),
                    settled: settled.promise,
                }),
            }),
        });
        const execution = operations.exec('sleep', '/tmp', {
            onData: () => undefined,
        });
        await nextTurn();

        settled.reject(protocolFailure);
        await nextTurn();
        expect(harness.children[0]?.kill).toHaveBeenCalledWith('SIGTERM');
        harness.children[0]?.close();
        await expect(execution).rejects.toBe(protocolFailure);
    });

    it('kills and cleans a prepared process when supervise throws synchronously', async () => {
        const harness = createSpawnHarness();
        const cleanup = mock(async () => undefined);
        const supervisionFailure = new Error('supervise failed');
        const operations = createBashOperations({
            spawn: harness.spawn,
            prepareSpawn: async ({ cwd, env }) => ({
                file: '/managed/zerobox',
                args: ['--status-fd=3'],
                cwd,
                env,
                extraStdio: ['pipe'],
                supervise: () => {
                    throw supervisionFailure;
                },
                cleanup,
            }),
        });

        await expect(
            operations.exec('true', '/tmp', { onData: () => undefined }),
        ).rejects.toBe(supervisionFailure);
        expect(harness.children[0]?.kill).toHaveBeenCalledWith('SIGTERM');
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('unregisters a prepared pid when supervise throws synchronously', async () => {
        const harness = createSpawnHarness(987_654_321);
        const processKill = spyOn(process, 'kill').mockImplementation(
            () => true,
        );
        const supervisor = createBashProcessSupervisor();
        try {
            const operations = supervisor.createOperations({
                spawn: harness.spawn,
                prepareSpawn: async ({ cwd, env }) => ({
                    file: '/managed/zerobox',
                    args: ['--status-fd=3'],
                    cwd,
                    env,
                    extraStdio: ['pipe'],
                    supervise: () => {
                        throw new Error('supervise failed');
                    },
                }),
            });

            const execution = operations.exec('true', '/tmp', {
                onData: () => undefined,
            });
            const rejection = expect(execution).rejects.toThrow(
                'supervise failed',
            );
            await nextTurn();
            harness.children[0]?.close(1);
            await rejection;
            processKill.mockClear();

            supervisor.shutdown();
            expect(processKill).not.toHaveBeenCalled();
        } finally {
            processKill.mockRestore();
        }
    });

    it('preserves the primary execution failure when cleanup also fails', async () => {
        const harness = createSpawnHarness();
        const primaryFailure = new Error('status failed');
        const cleanupFailure = new Error('cleanup failed');
        const operations = createBashOperations({
            spawn: harness.spawn,
            prepareSpawn: async ({ cwd, env }) => ({
                file: '/managed/zerobox',
                args: ['--status-fd=3'],
                cwd,
                env,
                extraStdio: ['pipe'],
                supervise: () => ({
                    ready: Promise.reject(primaryFailure),
                    settled: Promise.resolve(),
                }),
                cleanup: async () => {
                    throw cleanupFailure;
                },
            }),
        });

        let rejection: unknown;
        try {
            await operations.exec('true', '/tmp', {
                onData: () => undefined,
            });
        } catch (error) {
            rejection = error;
        }
        expect(rejection).toBe(primaryFailure);
        if (!(rejection instanceof Error)) throw new Error('expected Error');
        expect(Reflect.get(rejection, 'cleanupError')).toBe(cleanupFailure);
    });

    it('runs post-close cleanup on successful completion', async () => {
        const harness = createSpawnHarness();
        const afterClose = mock(async () => undefined);
        const operations = createBashOperations({ spawn: harness.spawn, afterClose });
        const execution = operations.exec('true', '/tmp', { onData: () => undefined });
        await nextTurn();
        harness.children[0]?.close();

        await execution;
        expect(afterClose).toHaveBeenCalledTimes(1);
    });

    it('runs post-close cleanup when spawn fails after preparation', async () => {
        const afterClose = mock(async () => undefined);
        const spawn = mock(() => {
            throw new Error('spawn failed');
        });
        const operations = createBashOperations({ spawn, afterClose });

        await expect(
            operations.exec('true', '/tmp', { onData: () => undefined }),
        ).rejects.toThrow('spawn failed');
        expect(afterClose).toHaveBeenCalledTimes(1);
    });

    it('removes streamed-data listeners after completion', async () => {
        const harness = createSpawnHarness();
        const onData = mock(() => undefined);
        const operations = createBashOperations({ spawn: harness.spawn });
        const execution = operations.exec('true', '/tmp', { onData });
        await nextTurn();
        const child = harness.children[0]!;
        child.close();

        await execution;
        expect(child.stdout.listenerCount('data')).toBe(0);
        expect(child.stderr.listenerCount('data')).toBe(0);
    });

    it('rejects an active stdin EPIPE', async () => {
        const harness = createSpawnHarness();
        const operations = createBashOperations({ stdin: 'payload', spawn: harness.spawn });
        const execution = operations.exec('exit 0', '/tmp', { onData: () => undefined });
        await nextTurn();

        const end = harness.children[0]?.stdin?.end;
        const callback = end?.mock.calls[0]?.[2] as ((error?: Error) => void) | undefined;
        callback?.(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
        await expect(execution).rejects.toThrow('broken pipe');
    });

    it('ignores a late stdin EPIPE after process exit', async () => {
        const harness = createSpawnHarness();
        const operations = createBashOperations({ stdin: 'payload', spawn: harness.spawn });
        const execution = operations.exec('exit 0', '/tmp', { onData: () => undefined });
        await nextTurn();

        const child = harness.children[0]!;
        const end = child.stdin?.end;
        const callback = end?.mock.calls[0]?.[2] as
            | ((error?: Error) => void)
            | undefined;
        child.close();
        callback?.(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));

        await expect(execution).resolves.toEqual({ exitCode: 0 });
    });

    it('settles after post-exit stdio becomes idle', async () => {
        const harness = createSpawnHarness();
        const operations = createBashOperations({ spawn: harness.spawn });
        const execution = operations.exec('daemonize', '/tmp', { onData: () => undefined });
        await nextTurn();

        harness.children[0]?.emit('exit', 0);
        await expect(execution).resolves.toEqual({ exitCode: 0 });
    });

    it('rejects a pre-aborted call without spawning', async () => {
        const harness = createSpawnHarness();
        const controller = new AbortController();
        controller.abort();
        const operations = createBashOperations({ spawn: harness.spawn });

        await expect(
            operations.exec('true', '/tmp', {
                onData: () => undefined,
                signal: controller.signal,
            }),
        ).rejects.toThrow('aborted');
        expect(harness.spawn).not.toHaveBeenCalled();
    });
    it('applies rewriteCommand after prepareCommand and before spawn', async () => {
        const harness = createSpawnHarness();
        const operations = createBashOperations({
            spawn: harness.spawn,
            prepareCommand: async ({ command, cwd, env }) => ({
                command: `wrapped ${command}`,
                cwd,
                env,
            }),
            rewriteCommand: (command) =>
                command.startsWith('wrapped echo')
                    ? command.replace('wrapped echo', 'wrapped printf REWRITTEN')
                    : null,
        });
        const execution = operations.exec('echo test', '/tmp', {
            onData: () => undefined,
        });
        await nextTurn();
        harness.children[0]?.close();
        await execution;

        expect(harness.calls[0]?.args).toEqual([
            '-c',
            'wrapped printf REWRITTEN test',
        ]);
    });

    it('leaves command unchanged when rewriteCommand returns null', async () => {
        const harness = createSpawnHarness();
        const operations = createBashOperations({
            spawn: harness.spawn,
            rewriteCommand: () => null,
        });
        const execution = operations.exec('echo test', '/tmp', {
            onData: () => undefined,
        });
        await nextTurn();
        harness.children[0]?.close();
        await execution;

        expect(harness.calls[0]?.args).toEqual(['-c', 'echo test']);
    });
});

describe('BashProcessSupervisor.shutdown', () => {
    it('is idempotent when no processes are active', () => {
        const supervisor = createBashProcessSupervisor();
        expect(() => supervisor.shutdown()).not.toThrow();
        expect(() => supervisor.shutdown()).not.toThrow();
    });
});

describe('createBashProcessSupervisor', () => {
    it('shuts down only processes created by that supervisor', async () => {
        const firstHarness = createSpawnHarness(987_654_301);
        const secondHarness = createSpawnHarness(987_654_302);
        const processKill = spyOn(process, 'kill').mockImplementation(() => true);
        const first = createBashProcessSupervisor();
        const second = createBashProcessSupervisor();
        try {
            void first.createOperations({ spawn: firstHarness.spawn }).exec(
                'first',
                '/tmp',
                { onData: () => undefined },
            );
            void second.createOperations({ spawn: secondHarness.spawn }).exec(
                'second',
                '/tmp',
                { onData: () => undefined },
            );
            await nextTurn();

            first.shutdown();

            expect(processKill).toHaveBeenCalledWith(-987_654_301, 'SIGKILL');
            expect(processKill).not.toHaveBeenCalledWith(-987_654_302, 'SIGKILL');
        } finally {
            firstHarness.children[0]?.close();
            secondHarness.children[0]?.close();
            second.shutdown();
            processKill.mockRestore();
        }
    });
});
