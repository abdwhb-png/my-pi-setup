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

import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { compactSkillSessionName } from '../extensions/pi-overrides/session-name.ts';
import {
    formatMigrationFailureLine,
    formatMigrationResultLine,
    formatMigrationSummary,
    migrateSessionFile as coreMigrateSessionFile,
    migrateSessions as coreMigrateSessions,
    SKILL_MIGRATION_LABELS,
    type MigrationMode,
    type SessionNameContext,
    type SessionNameEntry,
} from './session-name-migration.ts';

const DEFAULT_SESSIONS_DIRECTORY = join(homedir(), '.pi', 'agent', 'sessions');

export type { MigrationMode };

export type SessionMigrationResult = SessionNameEntry;

export interface SessionMigrationSummary {
    scanned: number;
    results: Array<{
        filePath: string;
        status: 'would-migrate' | 'migrated';
        name: string;
    }>;
    failures: Array<{ filePath: string; message: string }>;
}

/** Wrapper that adapts compactSkillSessionName to SessionNameContext. */
function skillDetector(context: SessionNameContext): string | undefined {
    if (!context.firstUserText) return undefined;
    return compactSkillSessionName(context.firstUserText);
}

export async function migrateSessionFile(
    filePath: string,
    mode: MigrationMode = 'dry-run',
): Promise<SessionMigrationResult> {
    return coreMigrateSessionFile(filePath, skillDetector, mode);
}

export async function migrateSessions(
    sessionsDirectory: string,
    mode: MigrationMode = 'dry-run',
): Promise<SessionMigrationSummary> {
    const summary = await coreMigrateSessions(
        sessionsDirectory,
        skillDetector,
        mode,
    );
    return {
        scanned: summary.scanned,
        results: summary.results,
        failures: summary.failures,
    };
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
        output(
            formatMigrationResultLine(
                relative(sessionsDirectory, result.filePath),
                result.status,
                result.name,
                SKILL_MIGRATION_LABELS,
            ),
        );
    }
    for (const failure of summary.failures) {
        output(
            formatMigrationFailureLine(
                relative(sessionsDirectory, failure.filePath),
                failure.message,
            ),
        );
    }

    if (summary.results.length === 0 && summary.failures.length === 0) {
        output(SKILL_MIGRATION_LABELS.noSessionsFoundMessage);
    } else if (summary.results.length > 0) {
        output(
            formatMigrationSummary(
                summary.results.length,
                summary.scanned,
                force ? 'force' : 'dry-run',
                SKILL_MIGRATION_LABELS,
            ),
        );
    }

    if (!force) output(SKILL_MIGRATION_LABELS.forceHintMessage);
    return summary.failures.length > 0 ? 1 : 0;
}

if (import.meta.main) {
    process.exitCode = await runMigrationCli();
}
