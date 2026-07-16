/**
 * pi-overrides unified config loader.
 *
 * Wraps the shared `_shared/config-loader.ts` `loadExtensionConfig<T>()` helper.
 * Sources (merged in order, later wins):
 *   1. settings.json key "fileResolver" (global -> project)
 *   2. legacy file pi-file-resolver.json (global -> project) — fallback only
 *
 * Usage:
 *   import { loadFileResolverConfig, setFileResolverConfig, getFileResolverConfig } from './config.ts';
 */

import { loadExtensionConfig } from '../_shared/config-loader.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Config for `fd` command-line flags. */
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

/** Config for `rg` (ripgrep) behaviour. */
export interface RgConfig {
    /** Respect .gitignore (default true). false adds --no-ignore */
    respectGitignore: boolean;
}

/** Config for `ls` behaviour. */
export interface LsConfig {
    /** Respect .gitignore (default true). false shows git-ignored entries */
    respectGitignore: boolean;
}

/** Top-level config for pi-overrides. */
export interface FileResolverConfig {
    fd: FdConfig;
    rg: RgConfig;
    ls: LsConfig;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: FileResolverConfig = {
    fd: {
        respectGitignore: true,
        followSymlinks: true,
        includeHidden: true,
        excludePatterns: ['.git', 'node_modules'],
        types: ['f'],
    },
    rg: {
        respectGitignore: true,
    },
    ls: {
        respectGitignore: true,
    },
};

// ---------------------------------------------------------------------------
// Runtime state (set once per session_start, read by tool operations)
// ---------------------------------------------------------------------------

let runtimeConfig: FileResolverConfig = DEFAULT_CONFIG;

/** Return the currently active config. */
export function getFileResolverConfig(): FileResolverConfig {
    return runtimeConfig;
}

/** Set the active config. Called at session_start. */
export function setFileResolverConfig(config: FileResolverConfig): void {
    runtimeConfig = config;
}

// ---------------------------------------------------------------------------
// Helpers
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

// ---------------------------------------------------------------------------
// Normalize
// ---------------------------------------------------------------------------

function normalizeFdConfig(rawFd: Record<string, unknown>): Partial<FdConfig> {
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

    return fd;
}

function normalizeRgConfig(rawRg: Record<string, unknown>): Partial<RgConfig> {
    const rg: Partial<RgConfig> = {};
    if (isBoolean(rawRg.respectGitignore)) {
        rg.respectGitignore = rawRg.respectGitignore;
    }
    return rg;
}

function normalizeLsConfig(rawLs: Record<string, unknown>): Partial<LsConfig> {
    const ls: Partial<LsConfig> = {};
    if (isBoolean(rawLs.respectGitignore)) {
        ls.respectGitignore = rawLs.respectGitignore;
    }
    return ls;
}

/** Normalize a single parsed JSON object into a partial config, dropping invalid fields. */
export function normalizeFileResolverConfig(
    raw: unknown,
): Partial<FileResolverConfig> {
    if (!isRecord(raw)) return {};

    const top = raw;
    const result: Partial<FileResolverConfig> = {};

    if (isRecord(top.fd)) {
        const fd = normalizeFdConfig(top.fd);
        if (Object.keys(fd).length > 0) result.fd = fd as FdConfig;
    }
    if (isRecord(top.rg)) {
        const rg = normalizeRgConfig(top.rg);
        if (Object.keys(rg).length > 0) result.rg = rg as RgConfig;
    }
    if (isRecord(top.ls)) {
        const ls = normalizeLsConfig(top.ls);
        if (Object.keys(ls).length > 0) result.ls = ls as LsConfig;
    }

    return result;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function mergeFdConfig(base: FdConfig, overlay: Partial<FdConfig>): FdConfig {
    return {
        respectGitignore: overlay.respectGitignore ?? base.respectGitignore,
        followSymlinks: overlay.followSymlinks ?? base.followSymlinks,
        includeHidden: overlay.includeHidden ?? base.includeHidden,
        excludePatterns: [
            ...base.excludePatterns,
            ...(overlay.excludePatterns ?? []),
        ],
        types: overlay.types ?? base.types,
    };
}

function mergeRgConfig(base: RgConfig, overlay: Partial<RgConfig>): RgConfig {
    return {
        respectGitignore: overlay.respectGitignore ?? base.respectGitignore,
    };
}

function mergeLsConfig(base: LsConfig, overlay: Partial<LsConfig>): LsConfig {
    return {
        respectGitignore: overlay.respectGitignore ?? base.respectGitignore,
    };
}

/** Deep-merge: overlay scalars override base; excludePatterns union; types replace. */
export function mergeFileResolverConfig(
    base: FileResolverConfig,
    overlay: Partial<{
        fd: Partial<FdConfig>;
        rg: Partial<RgConfig>;
        ls: Partial<LsConfig>;
    }>,
): FileResolverConfig {
    return {
        fd: overlay.fd ? mergeFdConfig(base.fd, overlay.fd) : base.fd,
        rg: overlay.rg ? mergeRgConfig(base.rg, overlay.rg) : base.rg,
        ls: overlay.ls ? mergeLsConfig(base.ls, overlay.ls) : base.ls,
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
