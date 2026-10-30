import { spawnSync } from 'node:child_process';
import {
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
    mkdtempSync,
    lstatSync,
    readdirSync,
    chmodSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { CONFIG_OWNERS } from '../../extensions/_shared/config-owners.mts';
import {
    archive,
    assertInventory,
    child,
    digest,
    inventory,
    json,
    object,
    run,
    writeJson,
} from './files.ts';

export const DISTRIBUTION_REPOSITORY = 'abdwhb-png/my-pi-distribution';
const LOCAL_AUTHORITY = new Set([
    'sandbox.json',
    'package-finalizer.json',
    'pi-dangerous-mode.json',
    'pi-permission-system-addons.json',
]);
function allowedProfilePath(path: string): boolean {
    return (
        [
            'agent/settings.json',
            'agent/hermes-memory-config.json',
            'agent/keybindings.json',
        ].includes(path) ||
        path.startsWith('agent/portable-skills/') ||
        Object.values(CONFIG_OWNERS).some(
            (owner) =>
                !LOCAL_AUTHORITY.has(owner.file) &&
                path === `agent/config/${owner.file}`,
        )
    );
}
export interface SetupManifest {
    schemaVersion: 1;
    platform: 'linux-x64';
    sourceCommit: string;
    files: Record<string, string>;
    packages: string[];
}
export function validatePackageSource(source: string): void {
    if (
        source !== './extensions/tool-groups' &&
        !/^npm:(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(
            source,
        ) &&
        !/^git:github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/.test(
            source,
        )
    )
        throw new Error(`Unsupported or unpinned package source: ${source}`);
}
export function validateBundle(root: string): SetupManifest {
    const value = json(join(root, 'manifest.json'));
    if (
        value.schemaVersion !== 1 ||
        value.platform !== 'linux-x64' ||
        typeof value.sourceCommit !== 'string' ||
        !/^[a-f0-9]{40}$/.test(value.sourceCommit)
    )
        throw new Error('Unsupported setup manifest');
    const files = object(value.files);
    for (const [path, hash] of Object.entries(files)) {
        child(root, path);
        if (
            !/^(setup|pi|zerobox)\//.test(path) ||
            typeof hash !== 'string' ||
            !(/^[0-9]+:[a-f0-9]{64}$/.test(hash) || hash.startsWith('link:'))
        )
            throw new Error('Invalid setup file inventory');
        if (
            path.startsWith('setup/') &&
            !allowedCodePath(path.slice(6)) &&
            !allowedProfilePath(path.slice(6))
        )
            throw new Error(`Excluded setup resource: ${path}`);
    }
    if (
        !Array.isArray(value.packages) ||
        !value.packages.every((p) => typeof p === 'string')
    )
        throw new Error('Invalid package inventory');
    for (const source of value.packages) validatePackageSource(source);
    const manifest = value as unknown as SetupManifest;
    assertInventory(root, manifest.files);
    const actual = inventory(root);
    delete actual['manifest.json'];
    if (
        Object.keys(actual).toSorted().join('\n') !==
        Object.keys(files).toSorted().join('\n')
    )
        throw new Error('Unlisted distribution files');
    for (const required of [
        'setup/bin/pi',
        'setup/bin/pi-setup',
        'setup/agent/settings.json',
        'pi/release-manifest.json',
        'zerobox/manifest.json',
        'zerobox/provenance.json',
    ])
        if (!files[required])
            throw new Error(`Missing distribution file: ${required}`);
    return manifest;
}

export function allowedCodePath(path: string): boolean {
    if (path === 'bin/zerobox') return false;
    if (
        /(^|\/)(node_modules|sessions|artifacts|cache|git|npm|\.git|\.aws)(\/|$)/.test(
            path,
        ) ||
        /(^|\/)(auth\.json|\.env[^/]*|.*\.secrets\.json)$/.test(path)
    )
        return false;
    return (
        /^(bin\/|agent\/(bin|extensions|scripts|tooling|agents|prompts|skills|themes|assets)\/|\.agents\/skills\/)/.test(
            path,
        ) ||
        /^agent\/config\/[^/]+\.example\.json$/.test(path) ||
        /^(AGENTS\.md|agent\/(AGENTS\.md|APPEND_SYSTEM\.md|package\.json|bun\.lock|bunfig\.toml|tsconfig[^/]*\.json|\.ox[^/]*\.json))$/.test(
            path,
        )
    );
}

export async function packDistribution(
    sourceRoot: string,
    output: string,
): Promise<void> {
    sourceRoot = resolve(sourceRoot);
    output = resolve(output);
    const code = run(
        'git',
        ['ls-tree', '-r', '--name-only', 'HEAD'],
        sourceRoot,
    )
        .split('\n')
        .filter(allowedCodePath);
    const changed = run('git', ['diff', '--name-only', 'HEAD'], sourceRoot)
        .split('\n')
        .filter(allowedCodePath);
    const untracked = run(
        'git',
        ['ls-files', '--others', '--exclude-standard'],
        sourceRoot,
    )
        .split('\n')
        .filter(allowedCodePath);
    if (changed.length || untracked.length)
        throw new Error(
            `Uncommitted setup code: ${[...changed, ...untracked].join(', ')}`,
        );
    if (existsSync(output)) throw new Error('Output directory already exists');
    const { loadCurrentPiRuntime } = await import('../pi-runtime-store.ts');
    const { validatePackedReleaseDirectory } =
        await import('../pi-fork-release.ts');
    const runtime = loadCurrentPiRuntime(join(sourceRoot, 'runtime/pi-core'));
    validatePackedReleaseDirectory(join(runtime.releaseRoot, 'packed'));
    const { readPrivateRuntimeEntry, resolvePrivateRuntime } =
        await import('../../extensions/sandbox/runtime/runtime-bundle.ts');
    const entry = await readPrivateRuntimeEntry(
        join(sourceRoot, 'bin/zerobox'),
        new URL(
            '../../extensions/sandbox/runtime/zerobox-provenance.json',
            import.meta.url,
        ),
    );
    const zerobox = await resolvePrivateRuntime({
        binaryPath: entry.binaryPath,
        expectedBinarySha256: entry.provenance.binarySha256,
    });
    const temporary = mkdtempSync(join(tmpdir(), 'pi-setup-pack-'));
    try {
        const bundle = join(temporary, 'bundle');
        mkdirSync(bundle, { mode: 0o700 });
        for (const path of code) {
            const target = child(join(bundle, 'setup'), path);
            const stat = lstatSync(join(sourceRoot, path));
            if (!stat.isFile())
                throw new Error(
                    `Code resources must be regular tracked files: ${path}`,
                );
            const result = spawnSync('git', ['show', `HEAD:${path}`], {
                cwd: sourceRoot,
                maxBuffer: 64 * 1024 * 1024,
            });
            if (result.status !== 0)
                throw new Error(`Cannot read committed code: ${path}`);
            mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
            writeFileSync(target, result.stdout, { mode: stat.mode & 0o755 });
        }
        const packages = await captureProfile(
            sourceRoot,
            join(bundle, 'setup'),
        );
        cpSync(join(runtime.releaseRoot, 'packed'), join(bundle, 'pi'), {
            recursive: true,
            verbatimSymlinks: true,
        });
        cpSync(zerobox.root, join(bundle, 'zerobox'), {
            recursive: true,
            verbatimSymlinks: true,
        });
        // Match the archive's permission normalization before recording fingerprints.
        for (const [path, hash] of Object.entries(inventory(bundle))) {
            if (!hash.startsWith('link:'))
                chmodSync(
                    child(bundle, path),
                    Number(hash.split(':')[0]) & 0o755,
                );
        }
        const manifest: SetupManifest = {
            schemaVersion: 1,
            platform: 'linux-x64',
            sourceCommit: run('git', ['rev-parse', 'HEAD'], sourceRoot),
            packages,
            files: inventory(bundle),
        };
        writeJson(join(bundle, 'manifest.json'), manifest);
        validateBundle(bundle);
        mkdirSync(output, { mode: 0o700 });
        archive('pack', bundle, join(output, 'setup.tgz'));
        writeJson(join(output, 'release.json'), {
            schemaVersion: 1,
            sourceCommit: manifest.sourceCommit,
            sha256: digest(readFileSync(join(output, 'setup.tgz'))),
        });
        writeJson(join(output, 'inventory.json'), manifest);
    } finally {
        rmSync(temporary, { recursive: true, force: true });
    }
}

async function captureProfile(
    root: string,
    destination: string,
): Promise<string[]> {
    const { DefaultPackageManager, SettingsManager } =
        await import('@earendil-works/pi-coding-agent');
    const { redactValue } =
        await import('../../extensions/_shared/secret-redaction.ts');
    const { toPortableHomePath } =
        await import('../../extensions/_shared/home-path.ts');
    const agentDir = join(root, 'agent');
    const settings = json(join(agentDir, 'settings.json'));
    const manager = new DefaultPackageManager({
        cwd: root,
        agentDir,
        settingsManager: SettingsManager.create(root, agentDir),
    });
    const packages: string[] = [];
    if (!Array.isArray(settings.packages))
        throw new Error('Missing package configuration');
    settings.packages = settings.packages.map((item) => {
        const source = typeof item === 'string' ? item : object(item).source;
        if (typeof source !== 'string')
            throw new Error('Invalid package source');
        const installed = manager.getInstalledPath(source, 'user');
        if (!installed || !existsSync(installed))
            throw new Error(`Package is not installed: ${source}`);
        let pinned: string;
        if (source.startsWith('npm:')) {
            const pkg = json(join(installed, 'package.json'));
            if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string')
                throw new Error('Invalid installed package metadata');
            pinned = `npm:${pkg.name}@${pkg.version}`;
        } else if (source.startsWith('git:github.com/')) {
            if (
                run(
                    'git',
                    ['status', '--porcelain', '--untracked-files=no'],
                    installed,
                )
            )
                throw new Error(`Modified installed Git package: ${source}`);
            pinned = `${source.split('@')[0]}@${run('git', ['rev-parse', 'HEAD'], installed)}`;
        } else if (source === './extensions/tool-groups') pinned = source;
        else throw new Error(`Unpackaged external resource: ${source}`);
        validatePackageSource(pinned);
        packages.push(pinned);
        return typeof item === 'string'
            ? pinned
            : { ...object(item), source: pinned };
    });
    settings.npmCommand = ['sfw', '--', 'bun'];
    delete settings.lastChangelogVersion;
    const globalSkills = join(homedir(), '.agents/skills');
    if (existsSync(globalSkills)) {
        const exported = join(destination, 'agent/portable-skills');
        function captureSkills(source: string, target: string) {
            mkdirSync(target, { recursive: true, mode: 0o700 });
            for (const entry of readdirSync(source, { withFileTypes: true })) {
                if (
                    ['.git', 'node_modules', '__pycache__'].includes(entry.name)
                )
                    continue;
                if (
                    entry.name.startsWith('.env') ||
                    /secrets|auth\.json/i.test(entry.name)
                )
                    throw new Error(
                        'A global skill contains excluded credential files',
                    );
                const input = join(source, entry.name),
                    output = join(target, entry.name);
                if (entry.isSymbolicLink())
                    throw new Error(
                        `Global skill link requires an explicit portable resource: ${input}`,
                    );
                if (entry.isDirectory()) captureSkills(input, output);
                else if (entry.isFile()) cpSync(input, output);
                else throw new Error('Unsupported global skill resource');
            }
        }
        captureSkills(globalSkills, exported);
        settings.skills = [
            ...(Array.isArray(settings.skills) ? settings.skills : []),
            '~/.pi/agent/portable-skills',
        ];
    }
    function portable(value: unknown): unknown {
        if (typeof value === 'string') {
            const next = toPortableHomePath(value, homedir());
            if (
                next === '~/.agents/skills' ||
                next.startsWith('~/.agents/skills/')
            )
                return `~/.pi/agent/portable-skills${next.slice('~/.agents/skills'.length)}`;
            if (next.startsWith('./agent/')) return `~/.pi/${next.slice(2)}`;
            return next;
        }
        if (Array.isArray(value)) return value.map(portable);
        if (value && typeof value === 'object')
            return Object.fromEntries(
                Object.entries(value).map(([key, nested]) => [
                    key,
                    portable(nested),
                ]),
            );
        return value;
    }
    function save(path: string, value: unknown) {
        const normalized = portable(value);
        const scan = redactValue(normalized, {
            maxDepth: 100,
            maxArrayItems: 100000,
            maxStringLength: 1000000,
        });
        if (Object.values(scan.counters).some((count) => count !== 0))
            throw new Error(
                `Profile requires review for credentials or excessive content: ${path}`,
            );
        writeJson(join(destination, path), normalized);
    }
    function validateResources(value: unknown): void {
        if (!Array.isArray(value)) return;
        for (const item of value) {
            if (
                typeof item !== 'string' ||
                /^[!+-]/.test(item) ||
                item.startsWith('builtin:')
            )
                continue;
            const path = portable(item);
            if (typeof path !== 'string')
                throw new Error('Invalid resource path');
            if (path.startsWith('~/.pi/')) {
                if (!existsSync(join(destination, path.slice(6))))
                    throw new Error(
                        `Resource is not included in the distribution: ${path}`,
                    );
            } else if (path.includes('/'))
                throw new Error(
                    `External resource needs a portable declaration: ${path}`,
                );
        }
    }
    for (const key of ['extensions', 'skills', 'prompts', 'themes'])
        validateResources(settings[key]);
    const subagents = settings.subagents ? object(settings.subagents) : {};
    if (subagents.agentOverrides)
        for (const override of Object.values(object(subagents.agentOverrides)))
            validateResources(object(override).subagentOnlyExtensions);
    save('agent/settings.json', settings);
    for (const file of new Set(
        Object.values(CONFIG_OWNERS).map((owner) => owner.file),
    )) {
        const path = `agent/config/${file}`;
        if (!LOCAL_AUTHORITY.has(file) && existsSync(join(root, path)))
            save(path, json(join(root, path)));
    }
    for (const file of ['hermes-memory-config.json', 'keybindings.json']) {
        const path = `agent/${file}`;
        if (existsSync(join(root, path))) save(path, json(join(root, path)));
    }
    return packages;
}

function requirePrivateRepository(): void {
    if (
        run('gh', [
            'repo',
            'view',
            DISTRIBUTION_REPOSITORY,
            '--json',
            'isPrivate',
            '--jq',
            '.isPrivate',
        ]) !== 'true'
    )
        throw new Error('Distribution repository must be private');
}
export function releaseTag(tag: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(tag))
        throw new Error('Invalid release tag');
    return tag;
}
export function publishDistribution(directory: string, tag: string): void {
    releaseTag(tag);
    requirePrivateRepository();
    const descriptor = json(join(directory, 'release.json'));
    if (
        descriptor.schemaVersion !== 1 ||
        descriptor.sha256 !== digest(readFileSync(join(directory, 'setup.tgz')))
    )
        throw new Error('Distribution archive checksum mismatch');
    const temporary = mkdtempSync(join(tmpdir(), 'pi-setup-publish-'));
    try {
        archive(
            'extract',
            join(directory, 'setup.tgz'),
            join(temporary, 'bundle'),
        );
        validateBundle(join(temporary, 'bundle'));
        // Publication is an explicit operator action, never part of pack or tests.
        const config = JSON.parse(
            run('gh', [
                'api',
                `repos/${DISTRIBUTION_REPOSITORY}/immutable-releases`,
            ]),
        );
        if (!config.enabled)
            throw new Error(
                'Enable immutable releases on the private distribution repository before publishing',
            );
        run('gh', [
            'release',
            'create',
            tag,
            join(directory, 'setup.tgz'),
            join(directory, 'release.json'),
            '--repo',
            DISTRIBUTION_REPOSITORY,
            '--draft',
            '--title',
            tag,
            '--notes',
            'Private Pi setup distribution. Memories and credentials are excluded.',
        ]);
        run('gh', [
            'release',
            'edit',
            tag,
            '--repo',
            DISTRIBUTION_REPOSITORY,
            '--draft=false',
        ]);
        run('gh', [
            'release',
            'verify',
            tag,
            '--repo',
            DISTRIBUTION_REPOSITORY,
        ]);
    } finally {
        rmSync(temporary, { recursive: true, force: true });
    }
}

export function downloadDistribution(tag: string, directory: string): string {
    releaseTag(tag);
    requirePrivateRepository();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    run('gh', ['release', 'verify', tag, '--repo', DISTRIBUTION_REPOSITORY]);
    run('gh', [
        'release',
        'download',
        tag,
        '--repo',
        DISTRIBUTION_REPOSITORY,
        '--dir',
        directory,
        '--pattern',
        'setup.tgz',
        '--pattern',
        'release.json',
    ]);
    for (const file of ['setup.tgz', 'release.json'])
        run('gh', [
            'release',
            'verify-asset',
            tag,
            join(directory, file),
            '--repo',
            DISTRIBUTION_REPOSITORY,
        ]);
    const descriptor = json(join(directory, 'release.json'));
    if (
        descriptor.schemaVersion !== 1 ||
        descriptor.sha256 !== digest(readFileSync(join(directory, 'setup.tgz')))
    )
        throw new Error('Downloaded archive checksum mismatch');
    const bundle = join(directory, 'bundle');
    archive('extract', join(directory, 'setup.tgz'), bundle);
    validateBundle(bundle);
    return bundle;
}
