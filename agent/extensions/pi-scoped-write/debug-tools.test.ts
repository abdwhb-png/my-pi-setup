import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporaryDirectories: string[] = [];

function temporaryProject(): string {
    const directory = mkdtempSync(join(tmpdir(), 'pi-scoped-write-debug-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe('scoped debug probe tools', () => {
    test('writes a probe under the active role and session debug root', async () => {
        const { createDebugProbeWriter } = await import('./debug-tools.ts');
        const cwd = temporaryProject();
        const writer = createDebugProbeWriter({
            cwd,
            role: 'debug',
            sessionId: 'session-1',
            agent: 'debug',
        });

        const result = writer.create({
            path: 'repro.mjs',
            content: "console.log('probe')\n",
            tool: 'write_debug_probe',
        });
        expect(result.kind).toBe('success');
        expect(
            readFileSync(
                join(cwd, '.pi/debug/debug/session-1/repro.mjs'),
                'utf8',
            ),
        ).toBe("console.log('probe')\n");
    });

    test('allows all probe-friendly extensions', async () => {
        const { createDebugProbeWriter } = await import('./debug-tools.ts');
        const cwd = temporaryProject();
        const writer = createDebugProbeWriter({
            cwd,
            role: 'debug',
            sessionId: 'session-1',
            agent: 'debug',
        });
        const allowed = [
            '.js',
            '.mjs',
            '.ts',
            '.sh',
            '.json',
            '.md',
        ];
        for (const ext of allowed) {
            expect(
                writer.create({
                    path: `probe${ext}`,
                    content: 'x',
                    tool: 'write_debug_probe',
                }).kind,
            ).toBe('success');
        }
    });

    test('rejects disallowed extensions', async () => {
        const { createDebugProbeWriter } = await import('./debug-tools.ts');
        const cwd = temporaryProject();
        const writer = createDebugProbeWriter({
            cwd,
            role: 'debug',
            sessionId: 'session-1',
            agent: 'debug',
        });
        const result = writer.create({
            path: 'probe.py',
            content: 'print(1)',
            tool: 'write_debug_probe',
        });
        expect(result.kind).toBe('rejected');
    });

    test('edits an existing probe', async () => {
        const { createDebugProbeWriter } = await import('./debug-tools.ts');
        const cwd = temporaryProject();
        const writer = createDebugProbeWriter({
            cwd,
            role: 'debug',
            sessionId: 'session-1',
            agent: 'debug',
        });
        writer.create({
            path: 'harness.ts',
            content: 'const x = 1\n',
            tool: 'write_debug_probe',
        });
        const result = writer.edit({
            path: 'harness.ts',
            edits: [{ oldText: 'const x = 1', newText: 'const x = 2' }],
            tool: 'edit_debug_probe',
        });
        expect(result.kind).toBe('success');
        expect(
            readFileSync(
                join(cwd, '.pi/debug/debug/session-1/harness.ts'),
                'utf8',
            ),
        ).toBe('const x = 2\n');
    });

    test('respects the larger size limit', async () => {
        const { createDebugProbeWriter } = await import('./debug-tools.ts');
        const cwd = temporaryProject();
        const writer = createDebugProbeWriter({
            cwd,
            role: 'debug',
            sessionId: 'session-1',
            agent: 'debug',
        });
        // 4 MB - 1 byte: under the limit
        const underLimit = 'a'.repeat(4 * 1024 * 1024 - 1);
        expect(
            writer.create({
                path: 'big.json',
                content: underLimit,
                tool: 'write_debug_probe',
            }).kind,
        ).toBe('success');
        // 4 MB + 1 byte: over the limit
        const overLimit = 'a'.repeat(4 * 1024 * 1024 + 1);
        expect(
            writer.create({
                path: 'too-big.json',
                content: overLimit,
                tool: 'write_debug_probe',
            }).kind,
        ).toBe('rejected');
    });

    test('records an audit event for probe writes', async () => {
        const { createDebugProbeWriter } = await import('./debug-tools.ts');
        const cwd = temporaryProject();
        const writer = createDebugProbeWriter({
            cwd,
            role: 'debug',
            sessionId: 'session-1',
            agent: 'debug',
        });
        writer.create({
            path: 'notes.md',
            content: '# findings\n',
            tool: 'write_debug_probe',
        });
        expect(
            existsSync(join(cwd, '.pi/artifacts/.audit/session-1.jsonl')),
        ).toBeTrue();
        const events = readFileSync(
            join(cwd, '.pi/artifacts/.audit/session-1.jsonl'),
            'utf8',
        )
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        expect(events[0]).toMatchObject({
            tool: 'write_debug_probe',
            operation: 'create',
        });
    });

    test('registers the debug root for per-run purge', async () => {
        const { createCommonDebugRoots } = await import('./debug-tools.ts');
        const { createDebugProbeWriter } = await import('./debug-tools.ts');
        const cwd = temporaryProject();
        createDebugProbeWriter({
            cwd,
            role: 'debug',
            sessionId: 'session-1',
            agent: 'debug',
        }).create({
            path: 'repro.sh',
            content: 'echo repro\n',
            tool: 'write_debug_probe',
        });
        const roots = createCommonDebugRoots();
        expect(roots.resolve(cwd, 'session-1')).toContain(
            join(cwd, '.pi/debug', 'debug', 'session-1'),
        );
    });
});
