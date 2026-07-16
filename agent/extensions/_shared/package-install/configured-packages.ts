import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type PackageScope = 'user' | 'project';

export interface ConfiguredPackageSource {
    source: string;
    scope: PackageScope;
}

type PackageExports = string | { [key: string]: PackageExports };

export interface PackageJsonLike {
    name?: string;
    packageManager?: string;
    scripts?: Record<string, string>;
    trustedDependencies?: string[];
    pi?: {
        extensions?: string[];
        skills?: string[];
        prompts?: string[];
        themes?: string[];
    };
    exports?: PackageExports;
}

interface ParsedNpmSource {
    type: 'npm';
    name: string;
}

interface ParsedGitSource {
    type: 'git';
    host: string;
    path: string;
}

interface ParsedLocalSource {
    type: 'local';
    path: string;
}

type ParsedSource = ParsedNpmSource | ParsedGitSource | ParsedLocalSource;

/**
 * A package encountered during traversal of configured pi packages.
 * `pkg` is null when the package root exists but package.json is missing or unreadable.
 */
export interface PackageVisit {
    entry: ConfiguredPackageSource;
    packageRoot: string;
    pkg: PackageJsonLike | null;
}

export interface IterateEnvironment {
    cwd: string;
    agentDir: string;
    force?: boolean;
}

/**
 * Read all package sources declared in settings.json (global + project-local).
 * Order: global first, then project. Project entries override global for the
 * same source key in downstream consumers.
 */
export function readConfiguredPackageSources(
    cwd: string,
    agentDir: string,
): ConfiguredPackageSource[] {
    const sources: ConfiguredPackageSource[] = [];
    const globalSettingsPath = join(agentDir, 'settings.json');
    const projectSettingsPath = join(cwd, '.pi', 'settings.json');

    for (const [settingsPath, scope] of [
        [globalSettingsPath, 'user'],
        [projectSettingsPath, 'project'],
    ] as const) {
        if (!existsSync(settingsPath)) continue;
        try {
            const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
                packages?: Array<string | { source: string }>;
            };
            for (const entry of parsed.packages ?? []) {
                const source = typeof entry === 'string' ? entry : entry.source;
                if (typeof source === 'string' && source.trim()) {
                    sources.push({ source, scope });
                }
            }
        } catch {
            // Ignore malformed settings; Pi itself will report them elsewhere.
        }
    }

    return sources;
}

export function parsePackageSource(source: string): ParsedSource {
    if (source.startsWith('npm:')) {
        return { type: 'npm', name: parseNpmPackageName(source) };
    }

    if (isLocalPathSource(source)) {
        return { type: 'local', path: source };
    }

    const parsedGit = parseGitSource(source);
    if (parsedGit) return parsedGit;
    return { type: 'local', path: source };
}

export function parseNpmPackageName(source: string): string {
    const spec = source.slice('npm:'.length).trim();
    const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@.+)?$/);
    return match?.[1] ?? spec;
}

export function isLocalPathSource(source: string): boolean {
    return (
        source.startsWith('/') ||
        source.startsWith('./') ||
        source.startsWith('../') ||
        source.startsWith('~/')
    );
}

export function parseGitSource(source: string): ParsedGitSource | null {
    let spec = source.trim();
    if (spec.startsWith('git:')) spec = spec.slice(4);

    const sshShort = spec.match(/^git@([^:]+):(.+)$/);
    if (sshShort) {
        const pathWithRef = sshShort[2];
        return {
            type: 'git',
            host: sshShort[1],
            path: stripGitSuffixAndRef(pathWithRef),
        };
    }

    const protocol = spec.match(/^(?:https?|ssh|git):\/\/([^/]+)\/(.+)$/);
    if (protocol) {
        const host = protocol[1].replace(/^.+@/, '');
        const pathWithRef = protocol[2];
        return { type: 'git', host, path: stripGitSuffixAndRef(pathWithRef) };
    }

    const shorthand = spec.match(/^([^/]+)\/(.+)$/);
    if (shorthand) {
        return {
            type: 'git',
            host: shorthand[1],
            path: stripGitSuffixAndRef(shorthand[2]),
        };
    }

    return null;
}

function stripGitSuffixAndRef(pathWithRef: string): string {
    const refIndex = pathWithRef.lastIndexOf('@');
    const withoutRef =
        refIndex > pathWithRef.indexOf('/')
            ? pathWithRef.slice(0, refIndex)
            : pathWithRef;
    return withoutRef.replace(/\.git$/, '');
}

export function resolveInstalledPackageRoot(
    source: string,
    scope: PackageScope,
    cwd: string,
    agentDir: string,
): string | null {
    const parsed = parsePackageSource(source);
    if (parsed.type === 'local') {
        const baseDir = scope === 'project' ? join(cwd, '.pi') : agentDir;
        return resolvePathFromBase(parsed.path, baseDir);
    }
    if (parsed.type === 'git') {
        const gitRoot =
            scope === 'project'
                ? join(cwd, '.pi', 'git')
                : join(agentDir, 'git');
        return join(gitRoot, parsed.host, parsed.path);
    }
    const npmRoot =
        scope === 'project'
            ? join(cwd, '.pi', 'npm', 'node_modules')
            : join(agentDir, 'npm', 'node_modules');
    return join(npmRoot, parsed.name);
}

export function resolvePathFromBase(input: string, baseDir: string): string {
    const expanded = input.startsWith('~/')
        ? join(homedir(), input.slice(2))
        : input;
    return resolve(baseDir, expanded);
}

export function readPackageJson(packageRoot: string): PackageJsonLike | null {
    const packageJsonPath = join(packageRoot, 'package.json');
    if (!existsSync(packageJsonPath)) return null;
    try {
        return JSON.parse(
            readFileSync(packageJsonPath, 'utf-8'),
        ) as PackageJsonLike;
    } catch {
        return null;
    }
}

/**
 * Traverse every configured pi package and invoke the visitor with a resolved
 * PackageVisit. The visitor may be sync or async. Reads only (no side effects):
 * the caller owns all mutations. This is the single shared entry point used by
 * both the build/symlink finalizer and the lifecycle-trust module, so the
 * package-iteration cycle is not duplicated.
 */
export async function forEachConfiguredPackage(
    env: IterateEnvironment,
    visitor: (visit: PackageVisit) => void | Promise<void>,
): Promise<void> {
    const configured = readConfiguredPackageSources(env.cwd, env.agentDir);
    for (const entry of configured) {
        const packageRoot = resolveInstalledPackageRoot(
            entry.source,
            entry.scope,
            env.cwd,
            env.agentDir,
        );
        if (!packageRoot) continue;
        const pkg = readPackageJson(packageRoot);
        await visitor({ entry, packageRoot, pkg });
    }
}
