import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toPortableHomePath } from '../../extensions/_shared/home-path.ts';
import { deployFork, verifyRuntimeCoherence } from '../pi-fork-release.ts';
import { validateBundle } from './distribution.ts';
import { json, object, run, writeJson } from './files.ts';

/** Runs only after the transaction has placed the candidate at its final path. */
export async function provision(root: string, bundle: string): Promise<void> {
    const manifest = validateBundle(bundle);
    const agentDir = join(root, 'agent');
    const runtime = await deployFork({
        packedRoot: join(bundle, 'pi'),
        runtimeRoot: join(root, 'runtime/pi-core'),
        agentDir,
    });
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
    for (const source of manifest.packages) {
        if (source.startsWith('npm:')) {
            const separator = source.lastIndexOf('@');
            const name = source.slice(4, separator),
                version = source.slice(separator + 1);
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
        run(
            process.execPath,
            [join(root, 'bin/pi'), 'install', source, '--no-approve'],
            agentDir,
            installEnv,
        );
    }
    // Preserve resource filters: package installation owns persistence, the profile owns selection.
    writeJson(settingsPath, settings);
    run(
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
    await stageRuntimeRelease({
        candidateRoot: join(bundle, 'zerobox'),
        runtimeBase: join(root, 'runtimes'),
        managedBinary: join(root, 'bin/zerobox'),
        provenanceSource: join(bundle, 'zerobox/provenance.json'),
        expectedBinarySha256: provenance.binarySha256,
    });
    // The existing builder creates machine identity and retains local network/trust decisions.
    const bindings = join(agentDir, 'config/setup-bindings.json');
    if (process.env.PI_SETUP_BINDINGS)
        writeJson(bindings, json(process.env.PI_SETUP_BINDINGS));
    const configured = run(
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
    );
    const unavailable = configured
        .split('\n')
        .filter((line) => line.startsWith('Unavailable:'));
    if (unavailable.length)
        throw new Error(
            `Host tools are missing: ${unavailable.join('; ')}. Install them or retry with --bindings FILE; no host tools were installed automatically.`,
        );
    const coherence = verifyRuntimeCoherence(runtime, agentDir);
    if (!coherence.ok) throw new Error(coherence.errors.join('\n'));
    await verifyPackages(root, manifest.packages);
}

export function prepareInstalledProfile(
    root: string,
    files: Record<string, string>,
    runtimeVersion: string,
): Record<string, unknown> {
    const settingsPath = join(root, 'agent/settings.json');
    const settings = json(settingsPath);
    function relocate(value: unknown): unknown {
        if (
            typeof value === 'string' &&
            (value === '~/.pi' || value.startsWith('~/.pi/'))
        )
            return toPortableHomePath(root + value.slice(5));
        if (Array.isArray(value)) return value.map(relocate);
        if (value && typeof value === 'object')
            return Object.fromEntries(
                Object.entries(value).map(([key, item]) => [
                    key,
                    relocate(item),
                ]),
            );
        return value;
    }
    for (const path of Object.keys(files)) {
        if (
            /^setup\/agent\/(config\/[^/]+|hermes-memory-config|keybindings)\.json$/.test(
                path,
            )
        ) {
            const target = join(root, path.slice(6));
            writeJson(target, relocate(json(target)));
        }
    }
    const prepared = object(relocate(settings));
    // Pi writes this on first interactive launch; initialize it before recording integrity.
    prepared.lastChangelogVersion = runtimeVersion;
    writeJson(settingsPath, prepared);
    return prepared;
}

export async function verifyPackages(
    root: string,
    sources: string[],
): Promise<void> {
    const agentDir = join(root, 'agent');
    // Resolve after deployment: a fresh bootstrap starts without agent dependencies.
    const entry = createRequire(join(agentDir, 'package.json')).resolve(
        '@earendil-works/pi-coding-agent',
    );
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
        await provision(resolve(process.argv[2]!), resolve(process.argv[3]!));
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
