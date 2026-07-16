import { spawnSync } from 'node:child_process';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type {
    ConfiguredPackageSource,
    PackageJsonLike,
    PackageScope,
} from './configured-packages.js';
import {
    readConfiguredPackageSources,
    readPackageJson,
    resolveInstalledPackageRoot,
} from './configured-packages.js';

export type {
    ConfiguredPackageSource,
    PackageJsonLike,
    PackageScope,
} from './configured-packages.js';
export { parsePackageSource } from './configured-packages.js';

export interface RepairLogger {
    info(message: string): void;
    warn(message: string): void;
}

export interface RepairSummary {
    inspected: number;
    skipped: number;
    built: string[];
    linked: string[];
    warnings: string[];
}

export interface RepairEnvironment {
    cwd: string;
    agentDir: string;
    logger?: RepairLogger;
    force?: boolean;
}

interface PackageFinalizerState {
    version: 1;
    packages: Record<string, PackageFinalizerStateEntry>;
}

interface PackageFinalizerStateEntry {
    source: string;
    scope: PackageScope;
    packageRoot: string;
    packageJsonMtimeMs: number;
    packageJsonSize: number;
    globalSettingsMtimeMs: number;
    projectSettingsMtimeMs: number;
    managedLinkPaths?: string[];
}

type PackageExports = string | { [key: string]: PackageExports };

const DEFAULT_LOGGER: RepairLogger = {
    info: (message) => console.log(message),
    warn: (message) => console.warn(message),
};

const STATE_VERSION = 1 as const;

export function getDefaultAgentDir(): string {
    return getAgentDir();
}

function stripGitSuffixAndRef(pathWithRef: string): string {
    const refIndex = pathWithRef.lastIndexOf('@');
    const withoutRef =
        refIndex > pathWithRef.indexOf('/')
            ? pathWithRef.slice(0, refIndex)
            : pathWithRef;
    return withoutRef.replace(/\.git$/, '');
}

export function collectExpectedArtifactPaths(
    packageRoot: string,
    pkg: PackageJsonLike,
): string[] {
    const expected = new Set<string>();

    for (const extensionPath of pkg.pi?.extensions ?? []) {
        expected.add(resolve(packageRoot, extensionPath));
    }

    collectExportTargets(pkg.exports).forEach((relativePath) => {
        if (/\.(js|mjs|cjs)$/.test(relativePath)) {
            expected.add(resolve(packageRoot, relativePath));
        }
    });

    return [...expected];
}

function collectExportTargets(
    exportsField: PackageJsonLike['exports'],
): string[] {
    const targets = new Set<string>();
    const visit = (value: PackageExports | undefined) => {
        if (!value) return;
        if (typeof value === 'string') {
            if (value.startsWith('./')) targets.add(value);
            return;
        }
        for (const nested of Object.values(value)) {
            visit(nested);
        }
    };
    visit(exportsField);
    return [...targets];
}

export function chooseScriptRunner(
    packageRoot: string,
    pkg: PackageJsonLike,
): { command: string; args: string[] } {
    if (
        pkg.packageManager?.startsWith('bun@') ||
        existsSync(join(packageRoot, 'bun.lock')) ||
        existsSync(join(packageRoot, 'bun.lockb'))
    ) {
        return { command: 'bun', args: ['run'] };
    }
    if (
        pkg.packageManager?.startsWith('pnpm@') ||
        existsSync(join(packageRoot, 'pnpm-lock.yaml'))
    ) {
        return { command: 'pnpm', args: ['run'] };
    }
    return { command: 'npm', args: ['run'] };
}

export function isReplaceablePackageShim(
    linkPath: string,
    packageName: string,
): boolean {
    if (!existsSync(linkPath)) return false;
    let stats;
    try {
        stats = lstatSync(linkPath);
    } catch {
        return false;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;

    const pkg = readPackageJson(linkPath);
    if (!pkg || pkg.name !== packageName) return false;

    const files = readdirSync(linkPath);
    const jsFiles = files.filter((file) => file.endsWith('.js'));
    if (jsFiles.length === 0) return false;

    return jsFiles.every((file) => {
        try {
            const content = readFileSync(join(linkPath, file), 'utf-8').trim();
            return /^export \* from ["'].+["'];?$/.test(content);
        } catch {
            return false;
        }
    });
}

export function ensurePackageLinks(
    packageRoot: string,
    packageName: string,
    scope: PackageScope,
    cwd: string,
    agentDir: string,
    options?: { ownedLinkPaths?: string[] },
): string[] {
    const changed: string[] = [];
    const ownedLinkPaths = new Set(options?.ownedLinkPaths ?? []);
    for (const linkRoot of getPackageLinkRoots(scope, cwd, agentDir)) {
        mkdirSync(linkRoot, { recursive: true });
        const linkPath = join(linkRoot, packageName);
        const targetPath = packageRoot;
        mkdirSync(dirname(linkPath), { recursive: true });

        let linkExists = false;
        try {
            linkExists = !!lstatSync(linkPath);
        } catch {}
        if (linkExists) {
            try {
                const stats = lstatSync(linkPath);
                if (stats.isSymbolicLink()) {
                    const currentRealPath = realpathSync(linkPath);
                    const targetRealPath = realpathSync(targetPath);
                    if (currentRealPath === targetRealPath) continue;
                    rmSync(linkPath, { recursive: true, force: true });
                } else if (
                    isReplaceablePackageShim(linkPath, packageName) ||
                    ownedLinkPaths.has(linkPath)
                ) {
                    rmSync(linkPath, { recursive: true, force: true });
                } else {
                    continue;
                }
            } catch {
                // Broken symlink or inaccessible path — remove it so we can create a fresh one.
                try {
                    rmSync(linkPath, { recursive: true, force: true });
                } catch {}
            }
        }

        symlinkSync(targetPath, linkPath, 'dir');
        changed.push(linkPath);
    }
    return changed;
}

export function getPackageLinkRoots(
    scope: PackageScope,
    cwd: string,
    agentDir: string,
): string[] {
    const roots = new Set<string>();
    roots.add(join(agentDir, 'node_modules'));
    roots.add(join(cwd, '.pi', 'node_modules'));
    if (scope === 'project') {
        roots.add(join(cwd, 'node_modules'));
    }
    return [...roots];
}

export function removePackageLinks(
    packageRoot: string,
    packageName: string,
    scope: PackageScope,
    cwd: string,
    agentDir: string,
): string[] {
    const removed: string[] = [];
    for (const linkRoot of getPackageLinkRoots(scope, cwd, agentDir)) {
        const linkPath = join(linkRoot, packageName);
        if (!existsSync(linkPath)) continue;
        try {
            const stats = lstatSync(linkPath);
            if (!stats.isSymbolicLink()) continue;
            if (realpathSync(linkPath) !== realpathSync(packageRoot)) continue;
            rmSync(linkPath, { recursive: true, force: true });
            removed.push(linkPath);
        } catch {
            // ignore cleanup failures
        }
    }
    return removed;
}

export function finalizePackageRoot(
    packageRoot: string,
    scope: PackageScope,
    cwd: string,
    agentDir: string,
    logger: RepairLogger = DEFAULT_LOGGER,
    options?: { ownedLinkPaths?: string[] },
): { built: boolean; linked: string[]; warnings: string[] } {
    const warnings: string[] = [];
    if (!existsSync(packageRoot)) {
        return { built: false, linked: [], warnings };
    }

    const pkg = readPackageJson(packageRoot);
    if (!pkg?.name) {
        return { built: false, linked: [], warnings };
    }

    const expectedArtifacts = collectExpectedArtifactPaths(packageRoot, pkg);
    const missingArtifacts = expectedArtifacts.filter(
        (artifactPath) => !existsSync(artifactPath),
    );
    let built = false;

    if (missingArtifacts.length > 0) {
        const scriptName = pkg.scripts?.prepare
            ? 'prepare'
            : pkg.scripts?.build
              ? 'build'
              : null;
        if (!scriptName) {
            warnings.push(
                `Missing artifacts for ${pkg.name}: ${missingArtifacts.join(', ')}`,
            );
        } else {
            const runner = chooseScriptRunner(packageRoot, pkg);
            const result = spawnSync(
                runner.command,
                [...runner.args, scriptName],
                {
                    cwd: packageRoot,
                    stdio: 'pipe',
                    encoding: 'utf-8',
                },
            );
            if (result.status !== 0) {
                warnings.push(
                    `Failed to build ${pkg.name} with '${runner.command} ${[...runner.args, scriptName].join(' ')}'` +
                        (result.stderr ? `: ${result.stderr.trim()}` : ''),
                );
            } else {
                built = true;
            }
        }
    }

    const linked = ensurePackageLinks(
        packageRoot,
        pkg.name,
        scope,
        cwd,
        agentDir,
        options,
    );
    for (const warning of warnings)
        logger.warn(`[package-install-finalizer] ${warning}`);
    if (built) logger.info(`[package-install-finalizer] Built ${pkg.name}`);
    for (const linkPath of linked)
        logger.info(
            `[package-install-finalizer] Linked ${pkg.name} -> ${linkPath}`,
        );

    return { built, linked, warnings };
}

export function getStateFilePath(agentDir: string): string {
    return join(agentDir, 'package-finalizer-state.json');
}

export function loadFinalizerState(agentDir: string): PackageFinalizerState {
    const statePath = getStateFilePath(agentDir);
    if (!existsSync(statePath)) {
        return { version: STATE_VERSION, packages: {} };
    }
    try {
        const parsed = JSON.parse(
            readFileSync(statePath, 'utf-8'),
        ) as PackageFinalizerState;
        if (
            parsed.version !== STATE_VERSION ||
            !parsed.packages ||
            typeof parsed.packages !== 'object'
        ) {
            return { version: STATE_VERSION, packages: {} };
        }
        return parsed;
    } catch {
        return { version: STATE_VERSION, packages: {} };
    }
}

export function saveFinalizerState(
    agentDir: string,
    state: PackageFinalizerState,
): void {
    writeFileSync(getStateFilePath(agentDir), JSON.stringify(state, null, 2));
}

function getSettingsMtimeMs(path: string): number {
    if (!existsSync(path)) return 0;
    return lstatSync(path).mtimeMs;
}

function getPackageStateKey(entry: ConfiguredPackageSource): string {
    return `${entry.scope}:${entry.source}`;
}

function computeStateEntry(
    entry: ConfiguredPackageSource,
    packageRoot: string,
    cwd: string,
    agentDir: string,
): PackageFinalizerStateEntry | null {
    const packageJsonPath = join(packageRoot, 'package.json');
    if (!existsSync(packageJsonPath)) return null;
    const packageJsonStats = lstatSync(packageJsonPath);
    return {
        source: entry.source,
        scope: entry.scope,
        packageRoot: realpathSync(packageRoot),
        packageJsonMtimeMs: packageJsonStats.mtimeMs,
        packageJsonSize: packageJsonStats.size,
        globalSettingsMtimeMs: getSettingsMtimeMs(
            join(agentDir, 'settings.json'),
        ),
        projectSettingsMtimeMs: getSettingsMtimeMs(
            join(cwd, '.pi', 'settings.json'),
        ),
    };
}

function stateEntriesEqual(
    a: PackageFinalizerStateEntry | undefined,
    b: PackageFinalizerStateEntry | null,
): boolean {
    if (!a || !b) return false;
    return (
        a.source === b.source &&
        a.scope === b.scope &&
        a.packageRoot === b.packageRoot &&
        a.packageJsonMtimeMs === b.packageJsonMtimeMs &&
        a.packageJsonSize === b.packageJsonSize &&
        a.globalSettingsMtimeMs === b.globalSettingsMtimeMs &&
        a.projectSettingsMtimeMs === b.projectSettingsMtimeMs
    );
}

/**
 * Repair configured pi packages: build missing artifacts and ensure node_modules symlinks.
 *
 * Delegates traversal to forEachConfiguredPackage (configured-packages.ts) so the
 * package-iteration cycle is shared with the lifecycle-trust module.
 */
export async function repairConfiguredPiPackages(
    env: RepairEnvironment,
): Promise<RepairSummary> {
    const logger = env.logger ?? DEFAULT_LOGGER;
    const summary: RepairSummary = {
        inspected: 0,
        skipped: 0,
        built: [],
        linked: [],
        warnings: [],
    };
    const state = loadFinalizerState(env.agentDir);
    const nextState: PackageFinalizerState = {
        version: STATE_VERSION,
        packages: {},
    };

    const { forEachConfiguredPackage } =
        await import('./configured-packages.js');

    await forEachConfiguredPackage(env, (visit) => {
        const { entry, packageRoot, pkg } = visit;
        summary.inspected += 1;

        const stateKey = getPackageStateKey(entry);
        const currentStateEntry = computeStateEntry(
            entry,
            packageRoot,
            env.cwd,
            env.agentDir,
        );
        const existingStateEntry = state.packages[stateKey];
        const packageName = pkg?.name;
        const linkRoots = packageName
            ? getPackageLinkRoots(entry.scope, env.cwd, env.agentDir)
            : [];
        const linksHealthy = packageName
            ? linkRoots.every((root) => {
                  const linkPath = join(root, packageName);
                  try {
                      return (
                          existsSync(linkPath) &&
                          lstatSync(linkPath).isSymbolicLink() &&
                          realpathSync(linkPath) === realpathSync(packageRoot)
                      );
                  } catch {
                      return false;
                  }
              })
            : false;

        if (
            !env.force &&
            stateEntriesEqual(existingStateEntry, currentStateEntry) &&
            linksHealthy
        ) {
            summary.skipped += 1;
            if (currentStateEntry)
                nextState.packages[stateKey] = currentStateEntry;
            return;
        }

        const result = finalizePackageRoot(
            packageRoot,
            entry.scope,
            env.cwd,
            env.agentDir,
            logger,
            {
                ownedLinkPaths: existingStateEntry?.managedLinkPaths,
            },
        );
        if (result.built) summary.built.push(packageRoot);
        summary.linked.push(...result.linked);
        summary.warnings.push(...result.warnings);
        if (currentStateEntry) {
            currentStateEntry.managedLinkPaths = Array.from(
                new Set([
                    ...(existingStateEntry?.managedLinkPaths ?? []),
                    ...result.linked,
                ]),
            );
            nextState.packages[stateKey] = currentStateEntry;
        }
    });

    saveFinalizerState(env.agentDir, nextState);
    return summary;
}

export function uninstallConfiguredPackageLinks(
    source: string,
    scope: PackageScope,
    cwd: string,
    agentDir: string,
): string[] {
    const packageRoot = resolveInstalledPackageRoot(
        source,
        scope,
        cwd,
        agentDir,
    );
    if (!packageRoot) return [];
    const pkg = readPackageJson(packageRoot);
    if (!pkg?.name) return [];
    return removePackageLinks(packageRoot, pkg.name, scope, cwd, agentDir);
}

export function writeManagedShim(
    linkPath: string,
    packageName: string,
    targetIndexPath: string,
    subpathTargets: Record<string, string> = {},
): void {
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(
        join(linkPath, 'package.json'),
        JSON.stringify(
            {
                name: packageName,
                version: '0.0.0-shim',
                type: 'module',
                exports: {
                    '.': './index.js',
                    ...Object.fromEntries(
                        Object.keys(subpathTargets).map((key) => [
                            key,
                            `.${key}.js`,
                        ]),
                    ),
                },
            },
            null,
            2,
        ),
    );
    writeFileSync(
        join(linkPath, 'index.js'),
        `export * from ${JSON.stringify(targetIndexPath)};\n`,
    );
    for (const [subpath, target] of Object.entries(subpathTargets)) {
        writeFileSync(
            join(linkPath, `.${subpath}.js`),
            `export * from ${JSON.stringify(target)};\n`,
        );
    }
}
