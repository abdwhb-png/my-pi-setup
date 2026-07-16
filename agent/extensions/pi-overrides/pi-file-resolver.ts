import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { fuzzyFilter } from '@earendil-works/pi-tui';
import {
    type FileResolverConfig,
    loadFileResolverConfig,
} from './pi-file-resolver-config.ts';

// ---------------------------------------------------------------------------
// Public interface — exported for testing
// ---------------------------------------------------------------------------

export interface ParsedAtValue {
    path: string;
    isQuoted: boolean;
    isDirectory: boolean;
}

/**
 * Parse an @-prefixed autocomplete value into its components.
 */
export function parseAtValue(value: string): ParsedAtValue {
    let raw = value.startsWith('@') ? value.slice(1) : value;
    let isQuoted = false;

    if (raw.startsWith('"') && raw.endsWith('"')) {
        isQuoted = true;
        raw = raw.slice(1, -1);
    }

    const isDirectory = raw.endsWith('/');
    return { path: raw, isQuoted, isDirectory };
}

/**
 * Rebuild an @-prefixed autocomplete value from an absolute path and parsed metadata.
 */
export function rebuildAtValue(path: string, parsed: ParsedAtValue): string {
    const needsSlash = parsed.isDirectory && !path.endsWith('/');
    const display = needsSlash ? `${path}/` : path;
    if (parsed.isQuoted) return `@"${display}"`;
    return `@${display}`;
}

/**
 * Find unresolved bare @references in text.
 * Only matches `@bareword` (no `/`, no `~`, not already absolute).
 */
export function findUnresolvedAtRefs(
    text: string,
): Array<{ raw: string; name: string }> {
    const refs: Array<{ raw: string; name: string }> = [];
    const regex = /(?:^|\s)@([^\s@]+)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
        const name = match[1];
        if (name.startsWith('/') || name.startsWith('~/')) continue;
        if (name.includes('/')) continue;
        refs.push({ raw: match[0].trim(), name });
    }
    return refs;
}

/**
 * Transform an @-prefixed autocomplete value from relative → absolute path.
 * Absolute and ~/ paths are left untouched.
 */
export function transformAtValue(value: string, cwd: string): string {
    const parsed = parseAtValue(value);
    const { path } = parsed;

    if (path.startsWith('/') || path.startsWith('~')) {
        return rebuildAtValue(path, parsed);
    }

    const absolute = resolve(cwd, path);
    return rebuildAtValue(absolute, parsed);
}

/**
 * Compute the Levenshtein (edit) distance between two strings.
 * Case-insensitive. Returns the minimum number of single-character
 * edits (insertions, deletions, substitutions) to transform a into b.
 */
export function levenshteinDistance(a: string, b: string): number {
    const s = a.toLowerCase();
    const t = b.toLowerCase();

    if (s.length === 0) return t.length;
    if (t.length === 0) return s.length;

    // Use two rows for O(min(m,n)) space
    let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
    let curr = new Array<number>(t.length + 1);

    for (let i = 0; i < s.length; i++) {
        curr[0] = i + 1;
        for (let j = 0; j < t.length; j++) {
            const cost = s[i] === t[j] ? 0 : 1;
            curr[j + 1] = Math.min(
                curr[j] + 1, // insertion
                prev[j + 1] + 1, // deletion
                prev[j] + cost, // substitution
            );
        }
        // Swap rows
        [prev, curr] = [curr, prev];
    }

    return prev[t.length];
}

/**
 * Match files by basename using Levenshtein distance as fallback.
 * Only returns files whose basename is within threshold edit distance.
 * Results sorted by ascending distance (best match first).
 */
export function fuzzyMatchBasename(files: string[], query: string): string[] {
    if (!query || files.length === 0) return [];

    const threshold = Math.max(2, Math.floor(query.length / 2));
    const scored: Array<{ file: string; distance: number }> = [];

    for (const file of files) {
        const basename = file.split('/').pop() ?? '';
        const distance = levenshteinDistance(basename, query);
        if (distance <= threshold) {
            scored.push({ file, distance });
        }
    }

    scored.sort((a, b) => a.distance - b.distance);
    return scored.map((entry) => entry.file);
}

// ---------------------------------------------------------------------------
// Search roots
// ---------------------------------------------------------------------------

const HOME = homedir();
const AGENT_DIR = join(HOME, '.pi', 'agent');
const EXTENSIONS_DIR = join(AGENT_DIR, 'extensions');
const PI_PROMPTS_DIR = join(HOME, '.pi', 'pi-prompts');
const PI_DOCS_DIR = join(HOME, '.pi', 'docs');

/**
 * Get the list of search roots for background indexing.
 * Roots are deduplicated.
 */
export function getSearchRoots(cwd: string): string[] {
    const roots: string[] = [
        cwd,
        AGENT_DIR,
        EXTENSIONS_DIR,
        PI_PROMPTS_DIR,
        PI_DOCS_DIR,
    ];
    const seen = new Set<string>();
    return roots.filter((r) => {
        const key = r.replace(/\/+$/, '');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// ---------------------------------------------------------------------------
// Background file index
// ---------------------------------------------------------------------------

interface FileCache {
    files: string[];
    ready: boolean;
    running: boolean;
}

function buildFdArgs(
    baseDir: string,
    maxResults: number,
    config: FileResolverConfig,
): string[] {
    const args: string[] = [
        '--base-directory',
        baseDir,
        '--max-results',
        String(maxResults),
    ];

    // --type flags
    for (const t of config.fd.types) {
        args.push('--type', t);
    }

    if (config.fd.followSymlinks) args.push('--follow');
    if (config.fd.includeHidden) args.push('--hidden');
    if (!config.fd.respectGitignore) args.push('--no-ignore-vcs');

    // --exclude patterns (each generates 3 levels: dir, dir/*, dir/**)
    for (const pattern of config.fd.excludePatterns) {
        if (!pattern) continue;
        args.push('--exclude', pattern);
        args.push('--exclude', `${pattern}/*`);
        args.push('--exclude', `${pattern}/**`);
    }

    return args;
}

async function walkDirFd(
    baseDir: string,
    maxResults: number,
    signal: AbortSignal,
    config: FileResolverConfig,
): Promise<string[]> {
    return new Promise<string[]>((resolve) => {
        const args = buildFdArgs(baseDir, maxResults, config);

        const child = spawn('fd', args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            signal,
        });

        let stdout = '';
        const finish = (results: string[]) => {
            resolve(results);
        };

        child.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });

        child.on('error', () => finish([]));
        child.on('close', (code) => {
            if (signal.aborted || code !== 0 || !stdout) {
                finish([]);
                return;
            }
            const lines = stdout.trim().split('\n').filter(Boolean);
            const results: string[] = [];
            for (const line of lines) {
                const normalized = line.replace(/\/$/, '');
                if (
                    normalized === '.git' ||
                    normalized.startsWith('.git/') ||
                    normalized.includes('/.git/')
                ) {
                    continue;
                }
                results.push(join(baseDir, normalized));
            }
            finish(results);
        });
    });
}

function buildIndexBackground(
    cache: FileCache,
    roots: string[],
    config: FileResolverConfig,
): void {
    if (cache.running || cache.ready) return;
    cache.running = true;
    (async () => {
        const allFiles: string[] = [];
        const controller = new AbortController();
        indexAbortController = controller;
        for (const root of roots) {
            try {
                const entries = await walkDirFd(
                    root,
                    10000,
                    controller.signal,
                    config,
                );
                allFiles.push(...entries);
            } catch {
                // root not found, skip
            }
        }
        cache.files = [
            ...new Set(
                allFiles.map((p) => {
                    try {
                        return realpathSync(p);
                    } catch {
                        return p;
                    }
                }),
            ),
        ];
        cache.ready = true;
        cache.running = false;
    })().catch(() => {
        cache.running = false;
    });
}

// ---------------------------------------------------------------------------
// Module-level state (session-scoped, replaced on each session_start)
// ---------------------------------------------------------------------------

/** Guard against duplicate autocomplete provider registration. */
let autocompleteRegistered = false;

/** Current CWD, refreshed each session_start. Used by autocomplete wrapper. */
let sessionCwd = '';

/** Current config, loaded at session_start. Default config used as fallback. */
let fileResolverConfig: FileResolverConfig = {
    fd: {
        respectGitignore: true,
        followSymlinks: true,
        includeHidden: true,
        excludePatterns: ['.git', 'node_modules'],
        types: ['f'],
    },
};

/** Per-session file cache. Replaced on session_start, cleared on session_shutdown. */
let currentCache: FileCache = { files: [], ready: false, running: false };
let currentRoots: string[] = [];

/** AbortController for in-flight fd indexing. Aborted on session_shutdown. */
let indexAbortController: AbortController | null = null;

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
    // --- Part A: Autocomplete wrapper (registered ONCE) -----------------------

    pi.on('session_start', (_event, ctx) => {
        // Refresh CWD every session so /new ~/other-project/ uses right CWD
        sessionCwd = ctx.cwd;
        fileResolverConfig = loadFileResolverConfig(ctx.cwd);

        if (!autocompleteRegistered) {
            ctx.ui.addAutocompleteProvider((current) => ({
                ...current,
                triggerCharacters: current.triggerCharacters,
                async getSuggestions(lines, cursorLine, cursorCol, options) {
                    const result = await current.getSuggestions(
                        lines,
                        cursorLine,
                        cursorCol,
                        options,
                    );
                    if (!result) return null;

                    if (!result.prefix.startsWith('@')) return result;

                    return {
                        ...result,
                        items: result.items.map((item) => ({
                            ...item,
                            value: transformAtValue(item.value, sessionCwd),
                        })),
                    };
                },
                applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
                    const transformedItem = prefix.startsWith('@')
                        ? {
                              ...item,
                              value: transformAtValue(item.value, sessionCwd),
                          }
                        : item;
                    return current.applyCompletion(
                        lines,
                        cursorLine,
                        cursorCol,
                        transformedItem,
                        prefix,
                    );
                },
            }));

            autocompleteRegistered = true;
        }

        // Abort any previous indexing still running
        if (indexAbortController) {
            indexAbortController.abort();
            indexAbortController = null;
        }

        // --- Part B: Preprocessor state (per-session) ---------------------------

        currentCache = { files: [], ready: false, running: false };
        currentRoots = getSearchRoots(ctx.cwd);
        buildIndexBackground(currentCache, currentRoots, fileResolverConfig);
    });

    // Clear cache on session end
    pi.on('session_shutdown', async () => {
        if (indexAbortController) {
            indexAbortController.abort();
            indexAbortController = null;
        }
        currentCache = { files: [], ready: false, running: false };
        currentRoots = [];
    });

    // --- Part B: Preprocessor (top-level, fires once per turn) ---------------

    pi.on('before_agent_start', async (event) => {
        // Ensure background indexing has started
        buildIndexBackground(currentCache, currentRoots, fileResolverConfig);

        const refs = findUnresolvedAtRefs(event.prompt);
        if (refs.length === 0) return;

        // Skip if cache still building M-bM-^@M-^T next turn will have it
        if (!currentCache.ready) return;

        const resolutions: string[] = [];
        let anyResolved = false;

        for (const ref of refs) {
            // Try exact sequential fuzzy match first (current behaviour)
            let matches = fuzzyFilter(currentCache.files, ref.name, (p) => {
                const base = p.split('/').pop() ?? '';
                return base;
            });

            // Fallback: typo-tolerant Levenshtein match on basename
            if (matches.length === 0) {
                matches = fuzzyMatchBasename(currentCache.files, ref.name);
            }

            if (matches.length > 0) {
                anyResolved = true;
                resolutions.push(`${ref.raw} → ${matches[0]}`);
            }
        }

        if (!anyResolved) return;

        return {
            message: {
                customType: 'file-resolver',
                content: `Resolved: ${resolutions.join('; ')}`,
                display: false,
            },
        };
    });
}
