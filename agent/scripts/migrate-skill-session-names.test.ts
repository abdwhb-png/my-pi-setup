/// <reference types="bun" />

import { afterEach, describe, expect, it } from 'bun:test';
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import {
    migrateSessionFile,
    migrateSessions,
    runMigrationCli,
} from './migrate-skill-session-names.ts';
import {
    migrateSessionFile as coreMigrateSessionFile,
    migrateSessions as coreMigrateSessions,
    parseSessionLines,
    firstUserMessageText,
    currentSessionName,
    sessionCwd,
    normalizeName,
    type SessionNameContext,
} from './session-name-migration.ts';

const temporaryDirectories: string[] = [];

function parseJsonLine(line: string): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === 'object' && parsed !== null) {
            return parsed as Record<string, unknown>;
        }
        throw new Error('JSONL test fixture is not an object');
    } catch (error) {
        throw new Error('Invalid JSONL test fixture', { cause: error });
    }
}

async function createSessionFile(lines: object[]): Promise<string> {
    const directory = await mkdtemp(
        nodePath.join(tmpdir(), 'skill-session-migration-'),
    );
    temporaryDirectories.push(directory);
    const filePath = nodePath.join(directory, 'session.jsonl');
    await writeFile(
        filePath,
        `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
        'utf8',
    );
    return filePath;
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) =>
                rm(directory, { recursive: true, force: true }),
            ),
    );
});

describe('migrateSessionFile', () => {
    it('reports a dry-run migration without changing the session file', async () => {
        const filePath = await createSessionFile([
            {
                type: 'session',
                id: 'session-1',
                timestamp: '2026-01-01T00:00:00.000Z',
                cwd: '/tmp',
            },
            {
                type: 'message',
                id: 'message-1',
                parentId: null,
                timestamp: '2026-01-01T00:00:01.000Z',
                message: {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: '<skill name="diagnose" location="/skills/diagnose/SKILL.md">instructions</skill>\n\nInvestigate color',
                        },
                    ],
                },
            },
        ]);
        const before = await readFile(filePath, 'utf8');

        const result = await migrateSessionFile(filePath, 'dry-run');

        expect(result).toEqual({
            status: 'would-migrate',
            name: '/skill:diagnose Investigate color',
        });
        expect(await readFile(filePath, 'utf8')).toBe(before);
    });

    it('appends a session_info entry when dry-run is disabled', async () => {
        const filePath = await createSessionFile([
            {
                type: 'session',
                id: 'session-1',
                timestamp: '2026-01-01T00:00:00.000Z',
                cwd: '/tmp',
            },
            {
                type: 'message',
                id: 'message-1',
                parentId: null,
                timestamp: '2026-01-01T00:00:01.000Z',
                message: {
                    role: 'user',
                    content:
                        '<skill name="diagnose">instructions</skill>\n\nInvestigate color',
                },
            },
        ]);

        const result = await migrateSessionFile(filePath, 'force');
        const entries = (await readFile(filePath, 'utf8'))
            .trim()
            .split('\n')
            .map(parseJsonLine);

        expect(result).toEqual({
            status: 'migrated',
            name: '/skill:diagnose Investigate color',
        });
        const lastEntry = entries.at(-1);
        expect(lastEntry).toMatchObject({
            type: 'session_info',
            parentId: 'message-1',
            name: '/skill:diagnose Investigate color',
        });
        if (typeof lastEntry?.id !== 'string') {
            throw new Error('Expected session_info id');
        }
        expect(lastEntry.id).toMatch(/^[0-9a-f-]+$/);
    });

    it('preserves a session with an existing explicit name', async () => {
        const filePath = await createSessionFile([
            {
                type: 'session',
                id: 'session-1',
                timestamp: '2026-01-01T00:00:00.000Z',
                cwd: '/tmp',
            },
            {
                type: 'message',
                id: 'message-1',
                parentId: null,
                timestamp: '2026-01-01T00:00:01.000Z',
                message: {
                    role: 'user',
                    content:
                        '<skill name="diagnose">instructions</skill>\n\nInvestigate color',
                },
            },
            {
                type: 'session_info',
                id: 'info-1',
                parentId: 'message-1',
                timestamp: '2026-01-01T00:00:02.000Z',
                name: 'custom name',
            },
        ]);
        const before = await readFile(filePath, 'utf8');

        expect(await migrateSessionFile(filePath, 'force')).toEqual({
            status: 'skipped',
        });
        expect(await readFile(filePath, 'utf8')).toBe(before);
    });

    it('normalizes multiline names like Pi appendSessionInfo', async () => {
        const filePath = await createSessionFile([
            {
                type: 'session',
                id: 'session-1',
                timestamp: '2026-01-01T00:00:00.000Z',
                cwd: '/tmp',
            },
            {
                type: 'message',
                id: 'message-1',
                parentId: null,
                timestamp: '2026-01-01T00:00:01.000Z',
                message: {
                    role: 'user',
                    content:
                        '<skill name="diagnose">instructions</skill>\n\nFirst line\nSecond line',
                },
            },
        ]);

        expect(await migrateSessionFile(filePath, 'force')).toEqual({
            status: 'migrated',
            name: '/skill:diagnose First line Second line',
        });
    });

    it('recursively discovers nested session files in dry-run mode', async () => {
        const root = await mkdtemp(
            nodePath.join(tmpdir(), 'skill-session-tree-'),
        );
        temporaryDirectories.push(root);
        const nestedDirectory = nodePath.join(root, 'project', 'run-0');
        await mkdir(nestedDirectory, { recursive: true });
        const filePath = nodePath.join(nestedDirectory, 'session.jsonl');
        await writeFile(
            filePath,
            `${JSON.stringify({ type: 'session', id: 'session-1' })}\n${JSON.stringify(
                {
                    type: 'message',
                    id: 'message-1',
                    message: {
                        role: 'user',
                        content:
                            '<skill name="tdd">instructions</skill>\n\nFix login',
                    },
                },
            )}\n`,
            'utf8',
        );
        const before = await readFile(filePath, 'utf8');

        const summary = await migrateSessions(root, 'dry-run');

        expect(summary).toEqual({
            scanned: 1,
            results: [
                {
                    filePath,
                    status: 'would-migrate',
                    name: '/skill:tdd Fix login',
                },
            ],
            failures: [],
        });
        expect(await readFile(filePath, 'utf8')).toBe(before);
    });

    it('skips directory symlinks during recursive discovery', async () => {
        const root = await mkdtemp(
            nodePath.join(tmpdir(), 'skill-session-symlink-'),
        );
        temporaryDirectories.push(root);
        const target = nodePath.join(root, 'target');
        await mkdir(target);
        const filePath = nodePath.join(target, 'session.jsonl');
        await writeFile(
            filePath,
            `${JSON.stringify({ type: 'session', id: 'session-1' })}\n${JSON.stringify(
                {
                    type: 'message',
                    id: 'message-1',
                    message: {
                        role: 'user',
                        content:
                            '<skill name="tdd">instructions</skill>\n\nFix login',
                    },
                },
            )}\n`,
            'utf8',
        );
        await symlink(target, nodePath.join(target, 'cycle'), 'dir');

        const summary = await migrateSessions(root, 'dry-run');

        expect(summary.scanned).toBe(1);
        expect(summary.results).toHaveLength(1);
        expect(summary.failures).toEqual([]);
    });

    it('runs as a dry-run by default and prints force guidance', async () => {
        const filePath = await createSessionFile([
            { type: 'session', id: 'session-1' },
            {
                type: 'message',
                id: 'message-1',
                message: {
                    role: 'user',
                    content:
                        '<skill name="tdd">instructions</skill>\n\nFix login',
                },
            },
        ]);
        const before = await readFile(filePath, 'utf8');
        const output: string[] = [];

        const exitCode = await runMigrationCli(
            [],
            nodePath.dirname(filePath),
            (message: string) => output.push(message),
        );

        expect(exitCode).toBe(0);
        expect(await readFile(filePath, 'utf8')).toBe(before);
        expect(output.join('\n')).toContain('would migrate');
        expect(output.join('\n')).toContain('--force');
    });

    it('reports unreadable session files and exits 1', async () => {
        const root = await mkdtemp(
            nodePath.join(tmpdir(), 'skill-session-unreadable-'),
        );
        temporaryDirectories.push(root);
        const filePath = nodePath.join(root, 'unreadable.jsonl');
        await writeFile(filePath, '{}\n', 'utf8');
        await chmod(filePath, 0);
        const output: string[] = [];

        try {
            const exitCode = await runMigrationCli([], root, (message) =>
                output.push(message),
            );

            expect(exitCode).toBe(1);
            expect(output.join('\n')).toContain('unreadable.jsonl → failed:');
        } finally {
            await chmod(filePath, 0o600);
        }
    });

    describe('session-name-migration shared core (async detector)', () => {
        it('continues after one session detector fails and preserves the failure', async () => {
            const root = await mkdtemp(
                nodePath.join(tmpdir(), 'session-migration-failures-'),
            );
            temporaryDirectories.push(root);
            const brokenFile = nodePath.join(root, 'broken.jsonl');
            const validFile = nodePath.join(root, 'valid.jsonl');
            const session = (cwd: string) =>
                `${JSON.stringify({ type: 'session', id: cwd, cwd })}\n${JSON.stringify(
                    {
                        type: 'message',
                        id: `${cwd}-message`,
                        message: { role: 'user', content: 'Prompt body' },
                    },
                )}\n`;
            await writeFile(brokenFile, session('/broken'), 'utf8');
            await writeFile(validFile, session('/valid'), 'utf8');

            const summary = await coreMigrateSessions(
                root,
                async (context) => {
                    if (context.cwd === '/broken') {
                        throw new Error('loader broke');
                    }
                    return '/prompt:valid';
                },
                'dry-run',
            );

            expect(summary).toEqual({
                scanned: 2,
                results: [
                    {
                        filePath: validFile,
                        status: 'would-migrate',
                        name: '/prompt:valid',
                    },
                ],
                failures: [
                    {
                        filePath: brokenFile,
                        message: 'loader broke',
                    },
                ],
            });
        });

        it('works with an async detector (dry-run)', async () => {
            const filePath = await createSessionFile([
                { type: 'session', id: 'session-1' },
                {
                    type: 'message',
                    id: 'message-1',
                    message: {
                        role: 'user',
                        content:
                            '<skill name="tdd">instructions</skill>\n\nFix login',
                    },
                },
            ]);
            const before = await readFile(filePath, 'utf8');
            const asyncDetector = async (
                ctx: SessionNameContext,
            ): Promise<string | undefined> => {
                await Promise.resolve();
                const text = ctx.firstUserText ?? '';
                return text.includes('<skill')
                    ? '/async-skill:tdd Fix login'
                    : undefined;
            };

            const result = await coreMigrateSessionFile(
                filePath,
                asyncDetector,
                'dry-run',
            );

            expect(result).toEqual({
                status: 'would-migrate',
                name: '/async-skill:tdd Fix login',
            });
            expect(await readFile(filePath, 'utf8')).toBe(before);
        });

        it('appends session_info with an async detector (force)', async () => {
            const filePath = await createSessionFile([
                { type: 'session', id: 'session-1' },
                {
                    type: 'message',
                    id: 'message-1',
                    message: {
                        role: 'user',
                        content:
                            '<skill name="tdd">instructions</skill>\n\nFix login',
                    },
                },
            ]);
            const asyncDetector = async (
                ctx: SessionNameContext,
            ): Promise<string | undefined> => {
                await Promise.resolve();
                const text = ctx.firstUserText ?? '';
                return text.includes('<skill')
                    ? '/async-skill:tdd Fix login'
                    : undefined;
            };

            const result = await coreMigrateSessionFile(
                filePath,
                asyncDetector,
                'force',
            );
            const lastEntry = (await readFile(filePath, 'utf8'))
                .trim()
                .split('\n')
                .map(parseJsonLine)
                .at(-1);

            expect(result).toEqual({
                status: 'migrated',
                name: '/async-skill:tdd Fix login',
            });
            expect(lastEntry).toMatchObject({
                type: 'session_info',
                name: '/async-skill:tdd Fix login',
            });
        });

        it('parseSessionLines tolerates malformed lines', () => {
            const content = `{"type":"session","id":"1"}\nnot-json\n{"type":"message","id":"2"}`;
            const entries = parseSessionLines(content);
            expect(entries).toHaveLength(2);
            expect(entries[0].id).toBe('1');
            expect(entries[1].id).toBe('2');
        });

        it('firstUserMessageText returns undefined when no user message exists', () => {
            const entries = [{ type: 'session', id: '1' }];
            expect(firstUserMessageText(entries)).toBeUndefined();
        });

        it('currentSessionName returns undefined for empty entries', () => {
            expect(currentSessionName([])).toBeUndefined();
        });

        it('normalizeName replaces CR/LF with space', () => {
            expect(normalizeName('hello\r\nworld\ntest')).toBe(
                'hello world test',
            );
        });

        it('sessionCwd extracts cwd from session header', () => {
            const entries = [
                {
                    type: 'session',
                    id: 's1',
                    cwd: '/home/user/project',
                },
                { type: 'message', id: 'm1' },
            ];
            expect(sessionCwd(entries)).toBe('/home/user/project');
        });

        it('sessionCwd returns undefined when no session header has cwd', () => {
            const entries = [
                { type: 'session', id: 's1' },
                { type: 'message', id: 'm1' },
            ];
            expect(sessionCwd(entries)).toBeUndefined();
        });

        it('sessionCwd returns undefined for empty entries', () => {
            expect(sessionCwd([])).toBeUndefined();
        });
    });

    describe('session-name-migration context passing', () => {
        it('sync detector receives entries, firstUserText, cwd, currentName (dry-run)', async () => {
            const filePath = await createSessionFile([
                {
                    type: 'session',
                    id: 's1',
                    timestamp: '2026-01-01T00:00:00.000Z',
                    cwd: '/home/user/proj',
                },
                {
                    type: 'message',
                    id: 'm1',
                    parentId: null,
                    timestamp: '2026-01-01T00:00:01.000Z',
                    message: {
                        role: 'user',
                        content: '<skill name="test">x</skill>\n\nHello',
                    },
                },
            ]);
            const received: SessionNameContext[] = [];
            const syncDetector = (
                ctx: SessionNameContext,
            ): string | undefined => {
                received.push(ctx);
                return ctx.firstUserText?.includes('<skill')
                    ? '/ctx-skill:test Hello'
                    : undefined;
            };

            await coreMigrateSessionFile(filePath, syncDetector, 'dry-run');

            expect(received).toHaveLength(1);
            const ctx = received[0];
            expect(ctx.firstUserText).toContain('<skill name="test">');
            expect(ctx.cwd).toBe('/home/user/proj');
            expect(ctx.currentName).toBeUndefined();
            expect(ctx.entries).toHaveLength(2);
            expect(ctx.entries[0].type).toBe('session');
            expect(ctx.entries[1].type).toBe('message');
        });

        it('sync detector receives currentName when session_info exists', async () => {
            const filePath = await createSessionFile([
                {
                    type: 'session',
                    id: 's1',
                    cwd: '/tmp',
                },
                {
                    type: 'message',
                    id: 'm1',
                    message: {
                        role: 'user',
                        content: '<skill name="test">x</skill>\n\nHello',
                    },
                },
                {
                    type: 'session_info',
                    id: 'i1',
                    name: 'existing-name',
                },
            ]);

            const result = await coreMigrateSessionFile(
                filePath,
                (_ctx: SessionNameContext) => '/should-not-run',
                'force',
            );

            // Detector never called — skipped before side effect
            expect(result).toEqual({ status: 'skipped' });
        });

        it('async detector receives full context with cwd and currentName', async () => {
            const filePath = await createSessionFile([
                {
                    type: 'session',
                    id: 's1',
                    cwd: '/data/work',
                },
                {
                    type: 'message',
                    id: 'm1',
                    message: {
                        role: 'user',
                        content: '<skill name="test">x</skill>\n\nAsync test',
                    },
                },
            ]);
            const received: SessionNameContext[] = [];
            const asyncDetector = async (
                ctx: SessionNameContext,
            ): Promise<string | undefined> => {
                received.push(ctx);
                await Promise.resolve();
                return '/async-ctx:test';
            };

            const result = await coreMigrateSessionFile(
                filePath,
                asyncDetector,
                'dry-run',
            );

            expect(result).toEqual({
                status: 'would-migrate',
                name: '/async-ctx:test',
            });
            expect(received).toHaveLength(1);
            expect(received[0].cwd).toBe('/data/work');
            expect(received[0].firstUserText).toContain('Async test');
        });
    });

    it('applies migrations when invoked with --force', async () => {
        const filePath = await createSessionFile([
            { type: 'session', id: 'session-1' },
            {
                type: 'message',
                id: 'message-1',
                message: {
                    role: 'user',
                    content:
                        '<skill name="tdd">instructions</skill>\n\nFix login',
                },
            },
        ]);
        const output: string[] = [];

        const exitCode = await runMigrationCli(
            ['--force'],
            nodePath.dirname(filePath),
            (message: string) => output.push(message),
        );
        const lastEntry = (await readFile(filePath, 'utf8'))
            .trim()
            .split('\n')
            .map(parseJsonLine)
            .at(-1);

        expect(exitCode).toBe(0);
        expect(lastEntry).toMatchObject({
            type: 'session_info',
            name: '/skill:tdd Fix login',
        });
        expect(output.join('\n')).toContain('migrated');
        expect(output.join('\n')).not.toContain('Run with --force');
    });
});
