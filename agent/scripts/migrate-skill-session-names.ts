/// <reference types="node" />
/// <reference types="bun" />

/**
 * Backfill compact names for unnamed sessions whose first user message starts
 * with one or more Pi skill envelopes.
 *
 * Usage:
 *   bun run scripts/migrate-skill-session-names.ts
 *   bun run scripts/migrate-skill-session-names.ts --force
 *
 * Dry-run is the default. Stop active Pi sessions before using --force so this
 * offline migration cannot race session writes.
 */

import { randomUUID } from 'node:crypto';
import { appendFile, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { compactSkillSessionName } from '../extensions/pi-overrides/session-name.ts';

const DEFAULT_SESSIONS_DIRECTORY = join(homedir(), '.pi', 'agent', 'sessions');

export type MigrationMode = 'dry-run' | 'force';

export type SessionMigrationResult =
    | { status: 'would-migrate'; name: string }
    | { status: 'migrated'; name: string }
    | { status: 'skipped' };

function parseSessionLines(content: string): Record<string, unknown>[] {
    const entries: Record<string, unknown>[] = [];

    for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
            const value: unknown = JSON.parse(line);
            if (typeof value === 'object' && value !== null) {
                entries.push(value as Record<string, unknown>);
            }
        } catch {
            // Malformed lines remain untouched and do not stop migration.
        }
    }

    return entries;
}

function firstUserMessageText(
    entries: Record<string, unknown>[],
): string | undefined {
    for (const entry of entries) {
        if (entry.type !== 'message') continue;
        const message = entry.message;
        if (typeof message !== 'object' || message === null) continue;
        const record = message as Record<string, unknown>;
        if (record.role !== 'user') continue;

        const content = record.content;
        if (typeof content === 'string') return content;
        if (!Array.isArray(content)) return undefined;

        return content
            .flatMap((block) => {
                if (typeof block !== 'object' || block === null) return [];
                const record = block as Record<string, unknown>;
                return record.type === 'text' && typeof record.text === 'string'
                    ? [record.text]
                    : [];
            })
            .join(' ');
    }

    return undefined;
}

function currentSessionName(
    entries: Record<string, unknown>[],
): string | undefined {
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (entry.type !== 'session_info') continue;
        return typeof entry.name === 'string'
            ? entry.name.trim() || undefined
            : undefined;
    }

    return undefined;
}

export async function migrateSessionFile(
    filePath: string,
    mode: MigrationMode = 'dry-run',
): Promise<SessionMigrationResult> {
    const content = await readFile(filePath, 'utf8');
    const entries = parseSessionLines(content);
    if (currentSessionName(entries)) return { status: 'skipped' };

    const text = firstUserMessageText(entries);
    const compactName = text ? compactSkillSessionName(text) : undefined;
    const name = compactName?.replace(/[\r\n]+/g, ' ').trim();
    if (!name) return { status: 'skipped' };
    if (mode === 'dry-run') return { status: 'would-migrate', name };

    const parentId = entries.findLast(
        (entry) => typeof entry.id === 'string',
    )?.id;
    const sessionInfo = {
        type: 'session_info',
        id: randomUUID().slice(0, 8),
        parentId: parentId ?? null,
        timestamp: new Date().toISOString(),
        name,
    };
    const prefix = content.endsWith('\n') ? '' : '\n';
    await appendFile(filePath, `${prefix}${JSON.stringify(sessionInfo)}\n`);

    return { status: 'migrated', name };
}

export interface SessionMigrationSummary {
    scanned: number;
    results: Array<{
        filePath: string;
        status: 'would-migrate' | 'migrated';
        name: string;
    }>;
}

async function findSessionFiles(directory: string): Promise<string[]> {
    const files: string[] = [];
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await findSessionFiles(fullPath)));
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            files.push(fullPath);
        }
    }

    return files.toSorted((left, right) => left.localeCompare(right));
}

export async function migrateSessions(
    sessionsDirectory: string,
    mode: MigrationMode = 'dry-run',
): Promise<SessionMigrationSummary> {
    const files = await findSessionFiles(sessionsDirectory);
    const results: SessionMigrationSummary['results'] = [];

    for (const filePath of files) {
        const result = await migrateSessionFile(filePath, mode);
        if (result.status !== 'skipped') {
            results.push({ filePath, ...result });
        }
    }

    return { scanned: files.length, results };
}

export async function runMigrationCli(
    args: string[] = process.argv.slice(2),
    sessionsDirectory = DEFAULT_SESSIONS_DIRECTORY,
    output: (message: string) => void = (message) =>
        process.stdout.write(`${message}\n`),
): Promise<number> {
    const force = args.length === 1 && args[0] === '--force';
    if (args.length > 0 && !force) {
        output(
            'Usage: bun run scripts/migrate-skill-session-names.ts [--force]',
        );
        output('Dry-run is the default. Use --force to apply changes.');
        return 1;
    }

    let summary: SessionMigrationSummary;
    try {
        summary = await migrateSessions(
            sessionsDirectory,
            force ? 'force' : 'dry-run',
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output(`Migration failed: ${message}`);
        return 1;
    }

    for (const result of summary.results) {
        const action = force ? 'migrated' : 'would migrate';
        output(
            `  ${relative(sessionsDirectory, result.filePath)} → ${action}: ${result.name}`,
        );
    }

    if (summary.results.length === 0) {
        output('No unnamed skill-prefixed sessions found.');
    } else {
        const verb = force ? 'Migrated' : 'Would migrate';
        output(
            `${verb} ${summary.results.length} of ${summary.scanned} session files.`,
        );
    }

    if (!force) output('Run with --force to apply changes.');
    return 0;
}

if (import.meta.main) {
    process.exitCode = await runMigrationCli();
}
