/**
 * pi-file-resolver config loader.
 *
 * Wraps the shared `_shared/config-loader.ts` `loadExtensionConfig<T>()` helper.
 * Sources (merged in order, later wins):
 *   1. settings.json key "fileResolver" (global -> project)
 *   2. legacy file pi-file-resolver.json (global -> project) — fallback only
 */

import { loadExtensionConfig } from '../_shared/config-loader.ts';

/** Config for `fd` command-line flags used during file indexing. */
export interface FdConfig {
    /** Respect .gitignore (default true). false adds --no-ignore-vcs */
    respectGitignore: boolean;
    /** Follow symlinks (default true). false omits --follow */
    followSymlinks: boolean;
    /** Include hidden/dot files (default true). false omits --hidden */
    includeHidden: boolean;
    /** Extra exclusion patterns (default ['.git', 'node_modules']). Union-merged. */
    excludePatterns: string[];
    /** File types to include (default ['f']). fd --type flags. */
    types: string[];
}

/** Top-level config for pi-file-resolver. */
export interface FileResolverConfig {
    fd: FdConfig;
}

export const DEFAULT_CONFIG: FileResolverConfig = {
    fd: {
        respectGitignore: true,
        followSymlinks: true,
        includeHidden: true,
        excludePatterns: ['.git', 'node_modules'],
        types: ['f'],
    },
};

// ---------------------------------------------------------------------------
// Normalize
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoolean(v: unknown): v is boolean {
    return typeof v === 'boolean';
}

function isStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === 'string');
}

/** Normalize a single parsed JSON object into a partial config, dropping invalid fields. */
export function normalizeFileResolverConfig(
    raw: unknown,
): Partial<FileResolverConfig> {
    if (!isRecord(raw)) return {};

    const top = raw;
    const result: Partial<FileResolverConfig> = {};

    if (isRecord(top.fd)) {
        const rawFd = top.fd;
        const fd: Partial<FdConfig> = {};

        if (isBoolean(rawFd.respectGitignore)) {
            fd.respectGitignore = rawFd.respectGitignore;
        }
        if (isBoolean(rawFd.followSymlinks)) {
            fd.followSymlinks = rawFd.followSymlinks;
        }
        if (isBoolean(rawFd.includeHidden)) {
            fd.includeHidden = rawFd.includeHidden;
        }
        if (
            rawFd.excludePatterns !== undefined &&
            Array.isArray(rawFd.excludePatterns)
        ) {
            fd.excludePatterns = isStringArray(rawFd.excludePatterns);
        }
        if (rawFd.types !== undefined && Array.isArray(rawFd.types)) {
            fd.types = isStringArray(rawFd.types);
        }

        if (Object.keys(fd).length > 0) {
            result.fd = fd as FdConfig;
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** Deep-merge: overlay scalars override base; excludePatterns union; types replace. */
export function mergeFileResolverConfig(
    base: FileResolverConfig,
    overlay: Partial<{ fd: Partial<FdConfig> }>,
): FileResolverConfig {
    if (!overlay.fd) return base;

    const ofd = overlay.fd;

    return {
        fd: {
            respectGitignore: ofd.respectGitignore ?? base.fd.respectGitignore,
            followSymlinks: ofd.followSymlinks ?? base.fd.followSymlinks,
            includeHidden: ofd.includeHidden ?? base.fd.includeHidden,
            excludePatterns: [
                ...base.fd.excludePatterns,
                ...(ofd.excludePatterns ?? []),
            ],
            types: ofd.types ?? base.fd.types,
        },
    };
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/** Load and merge the file-resolver config from all configured sources. */
export function loadFileResolverConfig(
    cwd: string,
    agentDir?: string,
): FileResolverConfig {
    return loadExtensionConfig<FileResolverConfig>(cwd, {
        defaults: DEFAULT_CONFIG,
        normalize: normalizeFileResolverConfig,
        merge: mergeFileResolverConfig,
        sources: [
            {
                settingsKey: 'fileResolver',
                legacyFilename: 'pi-file-resolver.json',
                projectLocal: true,
            },
        ],
        agentDir,
    });
}
