/**
 * Conservative pure inverse matcher for historical expanded prompt-template
 * first messages.
 *
 * Given first-user text and a set of Pi PromptTemplates, determines whether
 * the text is the rendered (expanded) form of one of those templates and
 * returns the compact `/prompt:name [normalized captured args]` form.
 *
 * Rules (from Task 4 specification):
 * - Exact static template body match → `/prompt:name`
 * - Template with exactly one `$ARGUMENTS` or `$@`: prefix/suffix match,
 *   extract substituted middle, trim outer whitespace, normalize newlines.
 * - Requires >= 20 non-whitespace static chars across prefix+suffix
 *   (avoid catch-all templates).
 * - Skip: $1, $2, $N, ${...} placeholders, multiple all-args placeholders,
 *   unchanged placeholder token in stored text, non-match, ambiguous matches.
 */

import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import {
    type PromptTemplate,
    SettingsManager,
    DefaultResourceLoader,
    getAgentDir,
} from '@earendil-works/pi-coding-agent';
import {
    normalizeName,
    migrateSessionFile as coreMigrateSessionFile,
    migrateSessions as coreMigrateSessions,
    formatMigrationFailureLine,
    formatMigrationResultLine,
    formatMigrationSummary,
    type MigrationCliLabels,
    type MigrationMode,
    type SessionNameContext,
    type SessionNameDetector,
    type SessionNameEntry,
    type SessionNameSummary,
} from './session-name-migration.ts';

/** Regex matching any pi prompt-template placeholder. */
const ANY_PLACEHOLDER = /\$(?:ARGUMENTS\b|@|\d+|\{[^}]*\})/g;

/** Regex matching only the all-args placeholders. */
const ALL_ARGS_PLACEHOLDER = /^\$(?:ARGUMENTS|@)$/;

/** Regex matching unsupported positional/bracket placeholders. */
const UNSUPPORTED_PLACEHOLDER = /^\$\d+$|^\$\{/;

function normalizeLineEndings(value: string): string {
    return value.replace(/\r\n?/g, '\n');
}

/**
 * Pure inverse matcher.
 *
 * @param firstUserText - The first user message from a session (the
 *   expanded/rendered text).
 * @param templates     - PromptTemplate[] to attempt inverse match against.
 * @returns A compact `/prompt:name [args]` string, or `undefined` when no
 *   single template produces an unambiguous, safe inverse match.
 */
export function compactPromptSessionName(
    firstUserText: string,
    templates: PromptTemplate[],
): string | undefined {
    let bestMatch: { name: string; captured: string } | undefined;

    for (const template of templates) {
        const result = matchTemplate(firstUserText, template);
        if (!result) continue;
        // Ambiguous: two different templates match
        if (bestMatch) return undefined;
        bestMatch = result;
    }

    if (!bestMatch) return undefined;

    const { name, captured } = bestMatch;
    return captured ? `/prompt:${name} ${captured}` : `/prompt:${name}`;
}

/**
 * Attempt to match a single template against expanded text.
 *
 * Returns `{ name, captured }` on success, or `undefined` for any
 * skip condition (unsupported placeholders, non-match, catch-all, etc.).
 */
function matchTemplate(
    text: string,
    template: PromptTemplate,
): { name: string; captured: string } | undefined {
    const content = template.content;

    // Collect all placeholder locations
    const placeholders: Array<{ raw: string; index: number }> = [];
    let match: RegExpExecArray | null;
    ANY_PLACEHOLDER.lastIndex = 0;
    while ((match = ANY_PLACEHOLDER.exec(content)) !== null) {
        placeholders.push({ raw: match[0], index: match.index });
    }

    // ── Case A: No placeholders — exact match ──────────────────────
    if (placeholders.length === 0) {
        if (
            normalizeLineEndings(text).trim() ===
            normalizeLineEndings(content).trim()
        ) {
            return { name: template.name, captured: '' };
        }
        return undefined;
    }

    // ── Case B: Has placeholders — validate ────────────────────────

    // Reject unsupported placeholders ($1, $2, ${...})
    for (const ph of placeholders) {
        if (UNSUPPORTED_PLACEHOLDER.test(ph.raw)) return undefined;
    }

    // Must have exactly one all-args placeholder ($ARGUMENTS or $@)
    const allArgsPlaceholders = placeholders.filter((ph) =>
        ALL_ARGS_PLACEHOLDER.test(ph.raw),
    );
    if (allArgsPlaceholders.length !== 1) return undefined;

    const ph = allArgsPlaceholders[0];
    const prefix = content.slice(0, ph.index);
    const suffix = content.slice(ph.index + ph.raw.length);

    // Catch-all guard: require >= 20 non-whitespace static chars
    const staticCharCount = (prefix + suffix).replace(/\s/g, '').length;
    if (staticCharCount < 20) return undefined;

    // Prefix/suffix match
    if (!text.startsWith(prefix) || !text.endsWith(suffix)) return undefined;

    // Extract the substituted middle
    const rawCaptured = text.slice(prefix.length, text.length - suffix.length);

    // Check for unchanged placeholder token in stored text
    if (rawCaptured.includes(ph.raw)) return undefined;

    // Normalize captured text: trim outer separator whitespace, then
    // apply shared newline normalization from the migration engine.
    const captured = normalizeName(rawCaptured);

    return { name: template.name, captured };
}

// ============================================================
// Prompt Session Name Migration (Task 5)
// ============================================================

/** Re-export shared migration types for consumers (Task 6). */
export type { MigrationMode, SessionNameEntry, SessionNameSummary };

/**
 * Injectable async prompt loader seam.
 *
 * Accepts a session cwd and agent dir, returns resolved PromptTemplate[]
 * for that working directory.  Tests inject a mock loader to avoid
 * touching real settings or filesystem resources.
 */
export type PromptLoader = (
    cwd: string,
    agentDir: string,
) => Promise<PromptTemplate[]>;

// -----------------------------------------------------------------
// Narrow factory seam — testable without loading real Pi resources.
// -----------------------------------------------------------------

/** Default PromptLoader using Pi real SettingsManager and DefaultResourceLoader. */
export const defaultPromptLoader: PromptLoader = async (
    cwd: string,
    agentDir: string,
) => {
    const settingsManager = SettingsManager.create(cwd, agentDir);
    settingsManager.setProjectTrusted(true);
    const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noThemes: true,
        noContextFiles: true,
    });
    await loader.reload();
    return loader.getPrompts().prompts;
};

const DEFAULT_SESSIONS_DIRECTORY = join(homedir(), '.pi', 'agent', 'sessions');

/** CLI labels for prompt migration output. */
export const PROMPT_MIGRATION_LABELS: MigrationCliLabels = {
    wouldMigrateVerb: 'would migrate',
    migratedVerb: 'migrated',
    wouldMigrateSummaryPrefix: 'Would migrate',
    migratedSummaryPrefix: 'Migrated prompts',
    noSessionsFoundMessage:
        'No unnamed prompt-prefixed sessions found (safe current-template matching).',
    forceHintMessage: 'Run with --force to apply prompt name changes.',
};

/**
 * Create a SessionNameDetector that composes compactPromptSessionName
 * with prompts loaded per session cwd.
 *
 * @param options.loader - Injectable prompt loader (defaults to defaultPromptLoader).
 * @param options.cache  - Shared Map keyed by cwd (scoped to one migrateSessions run).
 */
export function promptSessionNameDetector(options?: {
    loader?: PromptLoader;
    cache?: Map<string, PromptTemplate[]>;
}): SessionNameDetector {
    const load = options?.loader ?? defaultPromptLoader;
    const cache = options?.cache ?? new Map<string, PromptTemplate[]>();
    const agentDir = getAgentDir();

    return async (context: SessionNameContext): Promise<string | undefined> => {
        if (!context.cwd || !context.firstUserText) return undefined;

        let templates = cache.get(context.cwd);
        if (!templates) {
            templates = await load(context.cwd, agentDir);
            cache.set(context.cwd, templates);
        }

        return compactPromptSessionName(context.firstUserText, templates);
    };
}

/**
 * Migrate a single session file using prompt-template matching.
 *
 * Creates a fresh per-invocation cache for its internal detector.
 * Suitable for Task 6's CLI integration.
 */
export async function migrateSessionFile(
    filePath: string,
    mode: MigrationMode = 'dry-run',
    loader?: PromptLoader,
): Promise<SessionNameEntry> {
    const cache = new Map<string, PromptTemplate[]>();
    const detector = promptSessionNameDetector({ cache, loader });
    return coreMigrateSessionFile(filePath, detector, mode);
}

/**
 * Migrate all session files in a directory using prompt-template matching.
 *
 * Shares one prompt cache across all files so sessions with the same cwd
 * load prompts only once per run.  Suitable for Task 6's CLI integration.
 */
export async function migrateSessions(
    sessionsDirectory: string,
    mode: MigrationMode = 'dry-run',
    loader?: PromptLoader,
): Promise<SessionNameSummary> {
    const cache = new Map<string, PromptTemplate[]>();
    const detector = promptSessionNameDetector({ cache, loader });
    return coreMigrateSessions(sessionsDirectory, detector, mode);
}

/**
 * CLI entry-point for prompt session-name migration.
 *
 * No args = dry-run; prints per-result `would migrate`, summary, and
 * `Run with --force to apply changes.`
 *
 * Invalid args = prompt-specific usage, exit code 1.
 *
 * ## Safety
 *
 * 1) Matching uses only currently-installed/current template bodies;
 *    deleted or edited templates remain unmatched.
 * 2) Captured args are normalized (outer whitespace trimmed, newlines
 *    collapsed) and original quoting/whitespace cannot be recovered.
 *    The original JSONL message is never touched.
 * 3) Dry-run is the default; `--force` is required to write.
 * 4) Stop all active Pi sessions before `--force` to avoid concurrent
 *    writes.
 *
 * @param args              CLI arguments (default: process.argv.slice(2)).
 * @param sessionsDirectory Directory containing .jsonl session files.
 * @param output            Output sink (default: stdout.write).
 * @param loader            Injectable PromptLoader for tests.
 * @returns Exit code (0 for success, 1 for usage/error).
 */
export async function runMigrationCli(
    args: string[] = process.argv.slice(2),
    sessionsDirectory = DEFAULT_SESSIONS_DIRECTORY,
    output: (message: string) => void = (message) =>
        process.stdout.write(`${message}\n`),
    loader?: PromptLoader,
): Promise<number> {
    const force = args.length === 1 && args[0] === '--force';
    if (args.length > 0 && !force) {
        output(
            'Usage: bun run scripts/migrate-prompt-session-names.ts [--force]',
        );
        output('Dry-run is the default. Use --force to apply changes.');
        return 1;
    }

    let summary: SessionNameSummary;
    try {
        summary = await migrateSessions(
            sessionsDirectory,
            force ? 'force' : 'dry-run',
            loader,
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
                PROMPT_MIGRATION_LABELS,
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
        output(PROMPT_MIGRATION_LABELS.noSessionsFoundMessage);
    } else if (summary.results.length > 0) {
        output(
            formatMigrationSummary(
                summary.results.length,
                summary.scanned,
                force ? 'force' : 'dry-run',
                PROMPT_MIGRATION_LABELS,
            ),
        );
    }

    if (!force) output(PROMPT_MIGRATION_LABELS.forceHintMessage);
    return summary.failures.length > 0 ? 1 : 0;
}

if (import.meta.main) {
    process.exitCode = await runMigrationCli();
}
