/// <reference types="node" />
/// <reference types="bun" />

/**
 * Shared session-name migration engine.
 *
 * Owns JSONL parsing, malformed-line tolerance, current-name lookup,
 * first-user-message extraction, recursive .jsonl discovery, name CR/LF
 * normalisation, dry-run/force, Pi-compatible session_info append,
 * summary, and configurable CLI output labels/messages.
 *
 * Detector is injected (sync or async) so this module is reusable for
 * both skill-name migration and future prompt-name migration.
 */

import { randomUUID } from 'node:crypto';
import { appendFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────────

export type MigrationMode = 'dry-run' | 'force';

/** Context passed to a SessionNameDetector. */
export interface SessionNameContext {
    entries: Record<string, unknown>[];
    firstUserText: string | undefined;
    cwd: string | undefined;
    currentName: string | undefined;
}

/** Sync or async name detector.  Receives session context, returns compact name or undefined. */
export type SessionNameDetector = (
    context: SessionNameContext,
) => string | undefined | Promise<string | undefined>;

/** Outcome for a single session file (no filePath). */
export type SessionNameEntry =
    | { status: 'would-migrate'; name: string }
    | { status: 'migrated'; name: string }
    | { status: 'skipped' };

/** Non-skipped result with resolved file path. */
export interface SessionNameResult {
    filePath: string;
    status: 'would-migrate' | 'migrated';
    name: string;
}

/** Per-file failure preserved while the remaining batch continues. */
export interface SessionNameFailure {
    filePath: string;
    message: string;
}

/** Aggregate summary of a migration run. */
export interface SessionNameSummary {
    scanned: number;
    results: SessionNameResult[];
    failures: SessionNameFailure[];
}

/** Injectable labels for CLI output formatting. */
export interface MigrationCliLabels {
    wouldMigrateVerb: string;
    migratedVerb: string;
    wouldMigrateSummaryPrefix: string;
    migratedSummaryPrefix: string;
    noSessionsFoundMessage: string;
    forceHintMessage: string;
}

// ── Default labels (skill flavour) ───────────────────────────────────────────

export const SKILL_MIGRATION_LABELS: MigrationCliLabels = {
    wouldMigrateVerb: 'would migrate',
    migratedVerb: 'migrated',
    wouldMigrateSummaryPrefix: 'Would migrate',
    migratedSummaryPrefix: 'Migrated',
    noSessionsFoundMessage: 'No unnamed skill-prefixed sessions found.',
    forceHintMessage: 'Run with --force to apply changes.',
};

// ── Pure helpers ─────────────────────────────────────────────────────────────

export function parseSessionLines(content: string): Record<string, unknown>[] {
    const entries: Record<string, unknown>[] = [];

    for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
            const value: unknown = JSON.parse(line);
            if (typeof value === 'object' && value !== null) {
                entries.push(value as Record<string, unknown>);
            }
        } catch {
            // Malformed lines remain untouched.
        }
    }

    return entries;
}

export function firstUserMessageText(
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

export function currentSessionName(
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

export function normalizeName(name: string): string {
    return name.replace(/[\r\n]+/g, ' ').trim();
}

/** Extract session cwd from the first `type: "session"` header entry. */
export function sessionCwd(
    entries: Record<string, unknown>[],
): string | undefined {
    for (const entry of entries) {
        if (entry.type === 'session' && typeof entry.cwd === 'string') {
            return entry.cwd;
        }
    }
    return undefined;
}

// ── File discovery ───────────────────────────────────────────────────────────

export async function findSessionFiles(directory: string): Promise<string[]> {
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

// ── Migration: single file ───────────────────────────────────────────────────

export async function migrateSessionFile(
    filePath: string,
    detector: SessionNameDetector,
    mode: MigrationMode = 'dry-run',
): Promise<SessionNameEntry> {
    const content = await readFile(filePath, 'utf8');
    const entries = parseSessionLines(content);
    const curName = currentSessionName(entries);
    const text = firstUserMessageText(entries);
    const cwd = sessionCwd(entries);
    const context: SessionNameContext = {
        entries,
        firstUserText: text,
        cwd,
        currentName: curName,
    };

    if (curName) return { status: 'skipped' };
    if (!text) return { status: 'skipped' };

    const rawName = await detector(context);
    const name = rawName ? normalizeName(rawName) : '';
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

// ── Migration: directory ─────────────────────────────────────────────────────

export async function migrateSessions(
    sessionsDirectory: string,
    detector: SessionNameDetector,
    mode: MigrationMode = 'dry-run',
): Promise<SessionNameSummary> {
    const files = await findSessionFiles(sessionsDirectory);
    const results: SessionNameResult[] = [];
    const failures: SessionNameFailure[] = [];

    for (const filePath of files) {
        try {
            const entry = await migrateSessionFile(filePath, detector, mode);
            if (entry.status !== 'skipped') {
                results.push({
                    filePath,
                    status: entry.status,
                    name: entry.name,
                });
            }
        } catch (error) {
            failures.push({
                filePath,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }

    return { scanned: files.length, results, failures };
}

// ── Output formatting ────────────────────────────────────────────────────────

export function formatMigrationResultLine(
    relativePath: string,
    status: 'would-migrate' | 'migrated',
    name: string,
    labels: MigrationCliLabels,
): string {
    const verb =
        status === 'would-migrate'
            ? labels.wouldMigrateVerb
            : labels.migratedVerb;
    return `  ${relativePath} → ${verb}: ${name}`;
}

export function formatMigrationFailureLine(
    relativePath: string,
    message: string,
): string {
    return `  ${relativePath} → failed: ${message}`;
}

export function formatMigrationSummary(
    count: number,
    total: number,
    mode: MigrationMode,
    labels: MigrationCliLabels,
): string {
    const prefix =
        mode === 'dry-run'
            ? labels.wouldMigrateSummaryPrefix
            : labels.migratedSummaryPrefix;
    return `${prefix} ${count} of ${total} session files.`;
}
