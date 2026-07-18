/**
 * Shared path resolution — determines which directories to search
 * based on a raw path prefix, driven by the fileResolver config.
 *
 * Used by autocomplete providers (yeet getArgumentCompletions,
 * pi-file-resolver realtimeFdSearch) to know WHERE to run fd.
 */

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { loadFileResolverConfig } from '../../pi-overrides/config';

/** Config cache per CWD to avoid re-loading on every keystroke. */
const configCache = new Map<
    string,
    ReturnType<typeof loadFileResolverConfig>
>();

function getConfig(cwd: string): ReturnType<typeof loadFileResolverConfig> {
    let cfg = configCache.get(cwd);
    if (!cfg) {
        cfg = loadFileResolverConfig(cwd);
        configCache.set(cwd, cfg);
    }
    return cfg;
}

/**
 * Clear the config cache (called at session_start).
 */
export function clearPathResolverCache(): void {
    configCache.clear();
}

export interface SearchDirectoriesOptions {
    /** Fallback CWD for relative path resolution. */
    cwd: string;
}

export interface SearchDirectoriesResult {
    /** Directories to search. Empty if no valid search roots found. */
    dirs: string[];
    /** Basename query for fuzzy filtering results. Empty if listing all. */
    query: string;
}

/**
 * Given a raw path prefix, return the set of directories to search
 * and the basename query to fuzzy-filter against.
 *
 * - Absolute paths (starting with `/`): searches that specific directory.
 *   Root `/` and non-existent directories are skipped (empty result).
 * - `~/` paths: expanded to home directory, then treated as absolute.
 * - Relative / bare names: searches the CWD plus any `additionalDirectories`
 *   from the fileResolver config.
 */
export function getSearchDirectories(
    prefix: string,
    options: SearchDirectoriesOptions,
): SearchDirectoriesResult {
    let searchPath = prefix;

    // Expand ~/ if needed
    if (searchPath.startsWith('~')) {
        searchPath = join(
            homedir(),
            searchPath.slice(searchPath[1] === '/' ? 2 : 1),
        );
    }

    // Absolute path
    if (searchPath.startsWith('/')) {
        const isTrailing = prefix.endsWith('/') || searchPath.endsWith('/');
        const dir = isTrailing ? searchPath : dirname(searchPath);
        const query = isTrailing ? '' : basename(searchPath);

        // Guard: skip root
        if (dir === '/') return { dirs: [], query };

        // Guard: skip non-existent or non-directory
        try {
            const s = statSync(dir);
            if (!s.isDirectory()) return { dirs: [], query };
        } catch {
            return { dirs: [], query };
        }

        return { dirs: [dir], query };
    }

    // Relative / bare name — search CWD + additional roots
    const config = getConfig(options.cwd);
    const dirs = [options.cwd, ...config.additionalDirectories];
    return { dirs, query: prefix };
}
