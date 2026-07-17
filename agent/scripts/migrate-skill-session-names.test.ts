/// <reference types="bun" />

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import {
    migrateSessionFile,
    migrateSessions,
    runMigrationCli,
} from './migrate-skill-session-names.ts';

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
        });
        expect(await readFile(filePath, 'utf8')).toBe(before);
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
