import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PackageJsonLike, PackageVisit } from './configured-packages.js';
import { forEachConfiguredPackage } from './configured-packages.js';

/**
 * npm lifecycle scripts that Bun blocks by default for untrusted dependencies.
 * Order matches npm's execution order; presence is all that matters here.
 */
const LIFECYCLE_SCRIPTS = [
    'preinstall',
    'install',
    'postinstall',
    'prepare',
] as const;

/** Interface mirroring finalizer's logger so both modules share a console shape. */
export interface TrustLogger {
    info(message: string): void;
    warn(message: string): void;
}

export interface TrustEnvironment {
    cwd: string;
    agentDir: string;
    logger?: TrustLogger;
    /**
     * When true, call onConfirm before trusting a package and respect a false return.
     * Default: false (trust silently with an info log).
     */
    confirm?: boolean;
    /**
     * Confirmation callback. Receives the package visit and the detected lifecycle
     * script names. Returning false (or Promise<false>) skips trust for that package.
     * Only invoked when confirm is true.
     */
    onConfirm?: (
        visit: PackageVisit,
        scripts: string[],
    ) => Promise<boolean> | boolean;
}

export interface TrustSummary {
    inspected: number;
    /** Package names that were trusted during this run. */
    trusted: string[];
    /** Packages skipped (already trusted, no lifecycle scripts, or unresolvable). */
    skipped: number;
    warnings: string[];
}

const DEFAULT_LOGGER: TrustLogger = {
    info: (message) => console.log(message),
    warn: (message) => console.warn(message),
};

/**
 * Lifecycle scripts declared on a package (preinstall/install/postinstall/prepare).
 * Returns their keys in npm execution order.
 */
export function getLifecycleScripts(pkg: PackageJsonLike): string[] {
    return LIFECYCLE_SCRIPTS.filter((script) => pkg.scripts?.[script]);
}

/**
 * Read the trustedDependencies set from a bun.lock file at installRoot.
 * Bun stores this as a top-level JSON array. Missing file or field → empty set.
 */
export function readTrustedDependencies(installRoot: string): Set<string> {
    const lockPath = join(installRoot, 'bun.lock');
    if (!existsSync(lockPath)) return new Set();
    try {
        const lock = JSON.parse(readFileSync(lockPath, 'utf-8')) as {
            trustedDependencies?: unknown;
        };
        if (!Array.isArray(lock.trustedDependencies)) return new Set();
        return new Set(
            lock.trustedDependencies.filter(
                (name): name is string => typeof name === 'string',
            ),
        );
    } catch {
        return new Set();
    }
}

function getNpmInstallRoot(
    scope: 'user' | 'project',
    cwd: string,
    agentDir: string,
): string {
    return scope === 'project'
        ? join(cwd, '.pi', 'npm')
        : join(agentDir, 'npm');
}

function trustPackage(
    packageName: string,
    installRoot: string,
): { ok: boolean; error: string } {
    const result = spawnSync(
        'bun',
        ['pm', 'trust', packageName, '--cwd', installRoot],
        {
            encoding: 'utf-8',
        },
    );
    const stderr =
        typeof result.stderr === 'string' ? result.stderr.trim() : '';
    if (result.status === 0) return { ok: true, error: '' };
    // bun pm trust exits non-zero when the package is already trusted
    // (built-in allowlist or already in trustedDependencies). Treat as success.
    if (stderr.toLowerCase().includes('already trusted')) {
        return { ok: true, error: '' };
    }
    return {
        ok: false,
        error: stderr || `bun pm trust exited with status ${result.status}`,
    };
}

/**
 * Inspect every configured pi package and ensure lifecycle scripts are trusted.
 *
 * For each package that declares a lifecycle script (preinstall/install/postinstall/prepare)
 * and is not yet listed in bun.lock's trustedDependencies:
 *   - log the detected scripts
 *   - when confirm is enabled, ask onConfirm and skip on refusal
 *   - run `bun pm trust <name> --cwd <installRoot>`
 *
 * Pure read/write of bun.lock is owned by bun; this module only invokes the CLI.
 */
export async function repairConfiguredPackageTrust(
    env: TrustEnvironment,
): Promise<TrustSummary> {
    const logger = env.logger ?? DEFAULT_LOGGER;
    const summary: TrustSummary = {
        inspected: 0,
        trusted: [],
        skipped: 0,
        warnings: [],
    };

    await forEachConfiguredPackage(env, (visit) => {
        const { entry, pkg } = visit;
        if (!pkg?.name) {
            summary.skipped += 1;
            return;
        }

        const scripts = getLifecycleScripts(pkg);
        if (scripts.length === 0) {
            summary.skipped += 1;
            return;
        }

        const installRoot = getNpmInstallRoot(
            entry.scope,
            env.cwd,
            env.agentDir,
        );
        const trusted = readTrustedDependencies(installRoot);
        if (trusted.has(pkg.name)) {
            summary.inspected += 1;
            summary.skipped += 1;
            return;
        }

        summary.inspected += 1;
        logger.info(
            `[package-lifecycle-trust] Detected lifecycle scripts for ${pkg.name}: ${scripts.join(', ')}`,
        );

        if (env.confirm && env.onConfirm) {
            const accepted = env.onConfirm(visit, scripts);
            const decision = accepted instanceof Promise ? false : accepted;
            // Sync result used directly; async confirm treated as refused for safety in sync visitor.
            if (!decision) {
                logger.warn(
                    `[package-lifecycle-trust] Skipped ${pkg.name}: trust refused by user`,
                );
                summary.warnings.push(`Skipped ${pkg.name}: trust refused`);
                return;
            }
        }

        const trustResult = trustPackage(pkg.name, installRoot);
        if (trustResult.ok) {
            summary.trusted.push(pkg.name);
            logger.info(`[package-lifecycle-trust] Trusted ${pkg.name}`);
        } else {
            summary.warnings.push(`${pkg.name}: ${trustResult.error}`);
            logger.warn(
                `[package-lifecycle-trust] Failed to trust ${pkg.name}: ${trustResult.error}`,
            );
        }
    });

    return summary;
}
