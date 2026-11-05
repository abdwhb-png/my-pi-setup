import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deployFork, verifyRuntimeCoherence } from '../pi-fork-release.ts';
import { PORTABLE_PROFILE_FILES, validateBundle } from './distribution.ts';
import { json, object, run, runAsync, writeJson } from './files.ts';
import { materializeProfile } from './profiles.ts';
import {
    childSetupProgress,
    setupStep,
    type SetupProgress,
} from './progress.ts';

/** Runs only after the transaction has placed the candidate at its final path. */
export async function provision(
    root: string,
    bundle: string,
    progress: SetupProgress | undefined = childSetupProgress(),
): Promise<void> {
    const manifest = validateBundle(bundle);
    const agentDir = join(root, 'agent');
    const runtime = await setupStep(progress, 'core', () =>
        deployFork({
            packedRoot: join(bundle, 'pi'),
            runtimeRoot: join(root, 'runtime/pi-core'),
            agentDir,
        }),
    );
    await setupStep(progress, 'dependencies', () =>
        restoreBundledExtensionDependencies(root, manifest.files),
    );
    const settingsPath = join(agentDir, 'settings.json');
    const settings = prepareInstalledProfile(
        root,
        manifest.files,
        runtime.manifest.packages.find(
            (pkg) => pkg.name === '@earendil-works/pi-coding-agent',
        )!.version,
    );
    const installEnv = {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_PACKAGE_FINALIZER_ACTIVE: '1',
        PI_REAL_BIN: undefined,
        PI_SUBAGENT_PI_BINARY: join(root, 'bin/pi'),
    };
    for (const [index, source] of manifest.packages.entries()) {
        await setupStep(
            progress,
            'packages',
            async () => {
                if (source.startsWith('npm:')) {
                    const separator = source.lastIndexOf('@');
                    const name = source.slice(4, separator),
                        version = source.slice(separator + 1);
                    await verifyRegistryVersion(name, version);
                }
                await runAsync(
                    process.execPath,
                    [join(root, 'bin/pi'), 'install', source, '--no-approve'],
                    agentDir,
                    installEnv,
                );
            },
            { current: index + 1, total: manifest.packages.length },
        );
    }
    // Preserve resource filters: package installation owns persistence, the profile owns selection.
    writeJson(settingsPath, settings);
    await runAsync(
        process.execPath,
        [join(root, 'bin/pi'), 'list', '--no-approve'],
        root,
        {
            ...process.env,
            PI_CODING_AGENT_DIR: agentDir,
            PI_REAL_BIN: undefined,
            PI_PACKAGE_FINALIZER_ACTIVE: undefined,
        },
    );
    const { stageRuntimeRelease } =
        await import('../../extensions/sandbox/runtime/distribution/stage-release.ts');
    const provenance = json(join(bundle, 'zerobox/provenance.json'));
    if (typeof provenance.binarySha256 !== 'string')
        throw new Error('Missing Zerobox binary digest');
    const binarySha256 = provenance.binarySha256;
    await setupStep(progress, 'zerobox', () =>
        stageRuntimeRelease({
            candidateRoot: join(bundle, 'zerobox'),
            runtimeBase: join(root, 'runtimes'),
            managedBinary: join(root, 'bin/zerobox'),
            provenanceSource: join(bundle, 'zerobox/provenance.json'),
            expectedBinarySha256: binarySha256,
        }),
    );
    // The existing builder creates machine identity and retains local network/trust decisions.
    const bindings = join(agentDir, 'config/setup-bindings.json');
    if (process.env.PI_SETUP_BINDINGS)
        writeJson(bindings, json(process.env.PI_SETUP_BINDINGS));
    const configured = await setupStep(progress, 'sandbox', () =>
        runAsync(
            process.execPath,
            [
                join(agentDir, 'scripts/configure-sandbox.ts'),
                'apply',
                '--agent-dir',
                agentDir,
                ...(existsSync(bindings) ? ['--bindings', bindings] : []),
            ],
            root,
            { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        ),
    );
    const unavailable = configured
        .split('\n')
        .filter((line) => line.startsWith('Unavailable:'));
    if (unavailable.length)
        throw new Error(
            `Host tools are missing: ${unavailable.join('; ')}. Install them or retry with --bindings FILE; no host tools were installed automatically.`,
        );
    await setupStep(progress, 'verify', async () => {
        const coherence = verifyRuntimeCoherence(runtime, agentDir);
        if (!coherence.ok) throw new Error(coherence.errors.join('\n'));
        await verifyPackages(root, manifest.packages);
    });
}

async function verifyRegistryVersion(
    name: string,
    version: string,
): Promise<void> {
    const response = await fetch(
        `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
        { signal: AbortSignal.timeout(30000) },
    );
    if (!response.ok)
        throw new Error(
            `Official registry lookup failed for ${name}@${version}`,
        );
    const metadata = object(await response.json());
    if (
        metadata.name !== name ||
        metadata.version !== version ||
        typeof object(metadata.dist).integrity !== 'string'
    )
        throw new Error(
            'Registry metadata does not match the requested package',
        );
}

export async function restoreBundledExtensionDependencies(
    root: string,
    files: Record<string, string>,
): Promise<void> {
    for (const path of Object.keys(files).toSorted()) {
        if (!/^setup\/agent\/extensions\/[^/]+\/package\.json$/.test(path))
            continue;
        const packagePath = join(root, path.slice(6));
        const pkg = json(packagePath);
        const dependencies = {
            ...object(pkg.dependencies ?? {}),
            ...object(pkg.devDependencies ?? {}),
            ...object(pkg.optionalDependencies ?? {}),
        };
        if (Object.keys(dependencies).length === 0) continue;
        const lockPath = path.replace(/package\.json$/, 'bun.lock');
        if (!files[lockPath])
            throw new Error(`Missing bundled Bun lockfile: ${lockPath}`);
        const lock = object(
            Bun.JSONC.parse(
                readFileSync(join(root, lockPath.slice(6)), 'utf8'),
            ),
        );
        const packages = object(lock.packages);
        for (const name of Object.keys(dependencies)) {
            const entry = packages[name];
            if (!Array.isArray(entry) || typeof entry[0] !== 'string')
                throw new Error(`Missing locked dependency: ${name}`);
            const separator = entry[0].lastIndexOf('@');
            const resolvedName = entry[0].slice(0, separator);
            const version = entry[0].slice(separator + 1);
            if (
                !/^(@[\w.-]+\/)?[\w.-]+$/.test(resolvedName) ||
                !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)
            )
                throw new Error(`Unsupported locked dependency: ${name}`);
            await verifyRegistryVersion(resolvedName, version);
        }
        await runAsync('sfw', ['--version']);
        await runAsync(
            'sfw',
            ['bun', 'install', '--frozen-lockfile', '--ignore-scripts'],
            dirname(packagePath),
        );
    }
}

export function prepareInstalledProfile(
    root: string,
    files: Record<string, string>,
    runtimeVersion: string,
): Record<string, unknown> {
    const settingsPath = join(root, 'agent/settings.json');
    const settings = json(settingsPath);
    for (const path of Object.keys(files)) {
        if (
            path !== 'setup/agent/settings.json' &&
            path.startsWith('setup/') &&
            PORTABLE_PROFILE_FILES.has(path.slice(6))
        ) {
            const target = join(root, path.slice(6));
            const value = materializeProfile(json(target), root);
            writeJson(target, value);
        }
    }
    const prepared = materializeProfile(settings, root, runtimeVersion);
    writeJson(settingsPath, prepared);
    return prepared;
}

export async function verifyPackages(
    root: string,
    sources: string[],
): Promise<void> {
    // Deployment creates node_modules after Bun has cached absent directories.
    // A fresh process must resolve the complete runtime graph, including transitives.
    await runAsync(
        process.execPath,
        [import.meta.filename, '--verify-packages', root, ...sources],
        root,
        {
            ...process.env,
            PI_CODING_AGENT_DIR: join(root, 'agent'),
        },
    );
}

async function verifyPackagesInProcess(
    root: string,
    sources: string[],
): Promise<void> {
    const agentDir = join(root, 'agent');
    const entry = Bun.resolveSync('@earendil-works/pi-coding-agent', agentDir);
    const {
        DefaultPackageManager,
        SettingsManager,
    }: typeof import('@earendil-works/pi-coding-agent') = await import(
        pathToFileURL(entry).href
    );
    const manager = new DefaultPackageManager({
        cwd: root,
        agentDir,
        settingsManager: SettingsManager.create(root, agentDir),
    });
    for (const source of sources) {
        const path = manager.getInstalledPath(source, 'user');
        if (!path) throw new Error(`Unresolved installed package: ${source}`);
        if (source.startsWith('git:')) {
            if (
                run('git', ['rev-parse', 'HEAD'], path) !==
                source.slice(source.lastIndexOf('@') + 1)
            )
                throw new Error(`Installed Git revision differs: ${source}`);
        } else if (source.startsWith('npm:')) {
            const pkg = json(join(path, 'package.json'));
            if (
                typeof pkg.name !== 'string' ||
                typeof pkg.version !== 'string' ||
                `npm:${pkg.name}@${pkg.version}` !== source
            )
                throw new Error(`Installed npm version differs: ${source}`);
        }
    }
}
if (import.meta.main) {
    try {
        if (process.argv[2] === '--verify-packages')
            await verifyPackagesInProcess(
                resolve(process.argv[3]!),
                process.argv.slice(4),
            );
        else
            await provision(
                resolve(process.argv[2]!),
                resolve(process.argv[3]!),
            );
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
