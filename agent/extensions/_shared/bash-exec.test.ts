import { describe, expect, it, mock } from 'bun:test';
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
    killActiveBashProcesses,
} = await import('./bash-exec');

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

function createSpawnHarness() {
    const calls: SpawnCall[] = [];
    const children: MockChild[] = [];
    const spawn = mock((command: string, args: string[], options: SpawnOptions) => {
        const child = new MockChild();
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
});

describe('killActiveBashProcesses', () => {
    it('is idempotent when no processes are active', () => {
        expect(() => killActiveBashProcesses()).not.toThrow();
        expect(() => killActiveBashProcesses()).not.toThrow();
    });
});
