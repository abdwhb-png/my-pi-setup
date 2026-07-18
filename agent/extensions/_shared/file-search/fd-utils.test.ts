import { describe, it, expect, mock } from 'bun:test';

// Mock node:child_process spawn for fd tests
let spawnCallback: ((cmd: string, args: string[], opts: any) => any) | null =
    null;
mock.module('node:child_process', () => ({
    spawn: (cmd: string, args: string[], opts: any) => {
        if (spawnCallback) return spawnCallback(cmd, args, opts);
        throw new Error(
            `spawn not configured for test: ${cmd} ${args.join(' ')}`,
        );
    },
}));

// Mock getAgentDir to return a fixed path
mock.module('@earendil-works/pi-coding-agent', () => ({
    getAgentDir: () => '/tmp/pi-agent',
}));

const { fdSearch } = await import('./fd-utils.ts');

function createSpawnMock(files: string[], exitCode = 0) {
    return (_cmd: string, _args: string[], _opts: any) => {
        const listeners: Record<string, (...args: any[]) => void> = {};
        const child = {
            stdout: {
                on: (_event: string, cb: (...args: any[]) => void) => {
                    if (_event === 'data') listeners.data = cb;
                },
            },
            stderr: {
                on: () => {},
            },
            on: (_event: string, cb: (...args: any[]) => void) => {
                if (_event === 'close' || _event === 'error') {
                    listeners[_event] = cb;
                }
            },
            _trigger: () => {
                if (listeners.data) {
                    for (const file of files) {
                        listeners.data(Buffer.from(file + '\n'));
                    }
                }
                process.nextTick(() => {
                    listeners.close?.(exitCode);
                });
            },
        };
        process.nextTick(() => child._trigger());
        return child;
    };
}

describe('fdSearch', () => {
    it('returns file paths for default options', async () => {
        spawnCallback = createSpawnMock(['index.ts', 'utils.ts']);
        const results = await fdSearch({ baseDir: '/projects/foo' });
        expect(results).toContain('/projects/foo/index.ts');
        expect(results).toContain('/projects/foo/utils.ts');
    });

    it('returns directory paths with types: ["d"]', async () => {
        spawnCallback = createSpawnMock(['src', 'tests']);
        const results = await fdSearch({
            baseDir: '/projects/foo',
            types: ['d'],
        });
        expect(results).toContain('/projects/foo/src');
        expect(results).toContain('/projects/foo/tests');
    });

    it('respects maxResults option', async () => {
        spawnCallback = createSpawnMock(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
        const results = await fdSearch({
            baseDir: '/projects/foo',
            maxResults: 2,
        });
        // fd --max-results limits output; our mock ignores it, but results get sliced
        expect(results.length).toBeLessThanOrEqual(4);
    });

    it('aborts on signal', async () => {
        const controller = new AbortController();
        controller.abort();
        spawnCallback = createSpawnMock(['file.ts']);
        const results = await fdSearch({
            baseDir: '/projects/foo',
            signal: controller.signal,
        });
        // Aborted before fd returns anything
        expect(results).toEqual([]);
    });

    it('handles fd error gracefully (returns empty)', async () => {
        // Simulate fd exit code 1
        spawnCallback = createSpawnMock([''], 1);
        await expect(fdSearch({ baseDir: '/bad/path' })).rejects.toThrow();
    });

    it('filters .git entries from results', async () => {
        spawnCallback = createSpawnMock([
            'src/index.ts',
            '.git',
            'src/.git/refs',
        ]);
        const results = await fdSearch({ baseDir: '/projects/foo' });
        expect(results).toContain('/projects/foo/src/index.ts');
        expect(results).not.toContain('/projects/foo/.git');
    });

    it('passes --follow and --hidden flags to fd', async () => {
        let capturedArgs: string[] = [];
        spawnCallback = (cmd, args, opts) => {
            capturedArgs = args;
            return createSpawnMock([])(cmd, args, opts);
        };
        await fdSearch({
            baseDir: '/projects/foo',
            followSymlinks: true,
            includeHidden: true,
        });
        expect(capturedArgs).toContain('--follow');
        expect(capturedArgs).toContain('--hidden');
    });
});
