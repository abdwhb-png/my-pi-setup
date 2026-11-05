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
import { join, resolve, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_OWNERS } from '../../extensions/_shared/config-owners.mts';
import { acquireRuntimeStorageLock } from '../../extensions/_shared/runtime-storage.ts';
import { redactValue } from '../../extensions/_shared/secret-redaction.ts';
import {
    archiveAsync,
    assertInventory,
    child,
    digest,
    inventory,
    json,
    object,
    run,
    runAsync,
    writeJson,
    writableDirectories,
} from './files.ts';
import { setupStep, type SetupProgress } from './progress.ts';

export const DISTRIBUTION_REPOSITORY = 'abdwhb-png/my-pi-distribution';
const PROFILE_EXCLUSIONS: Readonly<Record<string, 'local' | 'development'>> = {
    'agent/config/sandbox.json': 'local',
    'agent/config/package-finalizer.json': 'local',
    'agent/config/pi-dangerous-mode.json': 'local',
    'agent/config/pi-permission-system-addons.json': 'local',
    'agent/config/setup-bindings.json': 'local',
    'agent/trust.json': 'local',
    'agent/mcp-project-approvals.json': 'local',
    'agent/mcp-auth.json': 'local',
    'agent/models-store.json': 'local',
    'agent/mcp-cache.json': 'local',
    'agent/mcp-npx-cache.json': 'local',
    'agent/mcp-onboarding.json': 'local',
    'agent/skills-lock.json': 'local',
    'agent/pi-yolo.json': 'development',
    'agent/.fallowrc.json': 'development',
    'agent/settings.example.json': 'development',
    'agent/ai-providers.secrets.example.json': 'development',
    ...Object.fromEntries(
        Object.values(CONFIG_OWNERS).flatMap((owner) =>
            'legacyFile' in owner
                ? [[`agent/${owner.legacyFile}`, 'local']]
                : [],
        ),
    ),
};

type ProfileKind = 'preferences' | 'models' | 'mcp';
export const LOCAL_CONNECTION_FILES: ReadonlyMap<string, ProfileKind> = new Map(
    [
        ['agent/models.json', 'models'],
        ['agent/mcp.json', 'mcp'],
        ['agent/mcp-adapter.json', 'mcp'],
    ],
);
export const LOCAL_PROFILE_FILES: ReadonlySet<string> = new Set([
    ...LOCAL_CONNECTION_FILES.keys(),
    ...Object.entries(PROFILE_EXCLUSIONS)
        .filter(([, disposition]) => disposition === 'local')
        .map(([path]) => path),
]);
export const PORTABLE_PROFILE_FILES: ReadonlyMap<string, ProfileKind> = new Map(
    [
        'agent/settings.json',
        'agent/hermes-memory-config.json',
        'agent/keybindings.json',
        'agent/fancy-footer.json',
        'agent/fancy-footer.local.json',
        'agent/pi-session-recall.json',
        ...Object.values(CONFIG_OWNERS).map(
            (owner) => `agent/config/${owner.file}`,
        ),
    ]
        .filter((path) => !Object.hasOwn(PROFILE_EXCLUSIONS, path))
        .map((path): [string, ProfileKind] => [path, 'preferences']),
);
// Legacy archives remain admissible, but their connection files are never installed.
const ADMITTED_PROFILE_FILES = new Map([
    ...PORTABLE_PROFILE_FILES,
    ...LOCAL_CONNECTION_FILES,
]);
const CREDENTIAL_FILE = /(^|\/)(auth\.json|\.env[^/]*|.*\.secrets\.json)$/;
function allowedProfilePath(path: string): boolean {
    return (
        ADMITTED_PROFILE_FILES.has(path) ||
        path.startsWith('agent/portable-skills/')
    );
}

function assertClassifiedProfileConfigurations(root: string): void {
    const unclassified: string[] = [];
    for (const directory of ['agent', 'agent/config']) {
        const source = join(root, directory);
        if (!existsSync(source)) continue;
        for (const entry of readdirSync(source, { withFileTypes: true })) {
            if (!entry.isFile() && !entry.isSymbolicLink()) continue;
            if (!/\.(?:jsonc?|ya?ml|toml)$/i.test(entry.name)) continue;
            const path = `${directory}/${entry.name}`;
            if (resourceDisposition(path) !== undefined) continue;
            unclassified.push(path);
        }
    }
    if (unclassified.length)
        throw new Error(
            `Unclassified profile configuration: ${unclassified.toSorted().join(', ')}. Declare its portability policy before packaging.`,
        );
}

function readProfileFile(root: string, path: string): Record<string, unknown> {
    const source = child(root, path);
    if (!lstatSync(source).isFile())
        throw new Error(`Profile must be a regular file: ${path}`);
    const raw = readFileSync(source, 'utf8');
    try {
        return object(JSON.parse(raw));
    } catch {
        throw new Error(`Invalid JSON profile: ${path}`);
    }
}

function assertPortableProfileValue(
    path: string,
    value: Record<string, unknown>,
): void {
    const kind = ADMITTED_PROFILE_FILES.get(path);
    const connectionProfile = kind === 'models' || kind === 'mcp';
    const reference = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
    const authorizationReference = /^Bearer \$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
    const credentialName =
        /api[-_]?key|private[-_]?key|authorization|cookie|password|secret|token(?:$|[-_])|credential|^key$/i;
    function credentialError(location: string[]): never {
        throw new Error(
            `Profile credential requires an environment reference: ${path}:${location.join('.')}`,
        );
    }
    function scanView(input: unknown, location: string[] = []): unknown {
        if (location.length >= 100)
            throw new Error(`Profile exceeds nesting limit: ${path}`);
        if (Array.isArray(input)) {
            if (input.length > 100000)
                throw new Error(`Profile exceeds array limit: ${path}`);
            if (connectionProfile && location.at(-1) === 'args') {
                for (const [index, argument] of input.entries()) {
                    if (
                        typeof argument !== 'string' ||
                        !argument.startsWith('-')
                    )
                        continue;
                    const separator = argument.indexOf('=');
                    const flag = (
                        separator < 0 ? argument : argument.slice(0, separator)
                    ).replace(/^-+/, '');
                    if (!credentialName.test(flag)) continue;
                    const argumentValue =
                        separator < 0
                            ? input[index + 1]
                            : argument.slice(separator + 1);
                    if (
                        typeof argumentValue !== 'string' ||
                        !reference.test(argumentValue)
                    )
                        credentialError([...location, String(index)]);
                }
            }
            return input.map((nested, index) =>
                scanView(nested, [...location, String(index)]),
            );
        }
        if (!input || typeof input !== 'object') return input;
        const output: Record<string, unknown> = Object.create(null);
        for (const [key, nested] of Object.entries(input)) {
            const field = [...location, key];
            const parent = location.at(-1);
            const credential =
                connectionProfile &&
                (key.toLowerCase() === 'apikey' ||
                    ((parent === 'headers' ||
                        parent === 'env' ||
                        parent === 'auth' ||
                        parent === 'oauth') &&
                        credentialName.test(key)) ||
                    /^(?:token|access_token|refresh_token|password|secret|privatekey)$/i.test(
                        key,
                    ));
            if (
                connectionProfile &&
                parent === 'headers' &&
                typeof nested === 'string' &&
                nested.startsWith('!')
            )
                credentialError(field);
            if (credential) {
                if (
                    typeof nested !== 'string' ||
                    !(
                        reference.test(nested) ||
                        (key.toLowerCase() === 'authorization' &&
                            authorizationReference.test(nested))
                    )
                )
                    credentialError(field);
                // Only the scan view omits validated references. The original
                // configuration is serialized unchanged, never with redactions.
                continue;
            }
            if (
                connectionProfile &&
                /^(?:url|baseUrl)$/i.test(key) &&
                typeof nested === 'string' &&
                URL.canParse(nested)
            ) {
                const url = new URL(nested);
                if (url.username || url.password) credentialError(field);
                for (const [name, parameter] of url.searchParams)
                    if (credentialName.test(name) && !reference.test(parameter))
                        credentialError(field);
            }
            output[key] = scanView(nested, field);
        }
        return output;
    }
    const scan = redactValue(scanView(value), {
        maxDepth: 100,
        maxArrayItems: 100000,
        maxStringLength: 1000000,
    });
    if (Object.values(scan.counters).some((count) => count !== 0))
        throw new Error(
            `Profile requires review for credentials or excessive content: ${path}`,
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
    for (const path of Object.keys(files)) {
        if (
            path.startsWith('setup/') &&
            ADMITTED_PROFILE_FILES.has(path.slice(6))
        )
            assertPortableProfileValue(
                path.slice(6),
                readProfileFile(root, path),
            );
    }
    return manifest;
}

export type ResourceDisposition = 'code' | 'profile' | 'local' | 'development';

function resourceDisposition(path: string): ResourceDisposition | undefined {
    if (
        /(^|\/)(node_modules|sessions|artifacts|cache|git|npm|\.git|\.aws)(\/|$)/.test(
            path,
        ) ||
        CREDENTIAL_FILE.test(path) ||
        LOCAL_PROFILE_FILES.has(path) ||
        path === 'MEMORY.md' ||
        path === 'bin/zerobox' ||
        path === 'agent/pi-subagents/last-seen-version.json'
    )
        return 'local';
    if (Object.hasOwn(PROFILE_EXCLUSIONS, path))
        return PROFILE_EXCLUSIONS[path];
    if (
        PORTABLE_PROFILE_FILES.has(path) ||
        path.startsWith('agent/portable-skills/')
    )
        return 'profile';
    if (
        /^(bin\/|agent\/(bin|extensions|scripts|tooling|agents|roles|prompts|skills|themes|assets)\/|\.agents\/skills\/)/.test(
            path,
        ) ||
        /^agent\/config\/[^/]+\.example\.json$/.test(path) ||
        /^(AGENTS\.md|agent\/(AGENTS\.md|APPEND_SYSTEM\.md|package\.json|bun\.lock|bunfig\.toml|tsconfig[^/]*\.json|\.ox[^/]*\.json))$/.test(
            path,
        )
    )
        return 'code';
    if (
        /^(docs\/|\.github\/|\.agents\/prompts\/|pi-prompts\/|agent\/extensions-legacy\/)/.test(
            path,
        ) ||
        [
            '.fallowrc.json',
            '.gitignore',
            '.pi-lens.json',
            'bunfig.toml',
            'probe-runtime-agent.ts',
            'agent/.gitignore',
            'agent/.probe-runtime-agent.ts',
            'agent/intercom-bridge.md',
            'agent/progress.md',
        ].includes(path)
    )
        return 'development';
    return undefined;
}

export function classifySetupResource(path: string): ResourceDisposition {
    const disposition = resourceDisposition(path);
    if (disposition === undefined)
        throw new Error(
            `Unclassified setup resource: ${path}. Declare its distribution policy before packaging.`,
        );
    return disposition;
}

export function allowedCodePath(path: string): boolean {
    return classifySetupResource(path) === 'code';
}

export function resolveMainCommit(root: string, requested?: string): string {
    let main: string;
    try {
        main = run(
            'git',
            ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'],
            root,
        );
    } catch (cause) {
        throw new Error('Fetch origin/main before preparing a release', {
            cause,
        });
    }
    const commit = requested ?? main;
    if (
        !/^[a-f0-9]{40}$/.test(commit) ||
        spawnSync('git', ['merge-base', '--is-ancestor', commit, main], {
            cwd: root,
        }).status !== 0
    )
        throw new Error(
            'Release source must be a full commit from origin/main',
        );
    return commit;
}

export async function refreshMain(root: string): Promise<void> {
    await runAsync(
        'git',
        ['fetch', '--no-tags', 'origin', 'main:refs/remotes/origin/main'],
        root,
    );
}

function gitFile(root: string, commit: string, path: string): Buffer {
    const result = spawnSync('git', ['show', `${commit}:${path}`], {
        cwd: root,
        maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0)
        throw new Error(`Cannot read committed resource: ${path}`);
    return result.stdout;
}

export function auditDistributionResources(root: string, commit: string) {
    const result = spawnSync('git', ['ls-tree', '-rz', commit], {
        cwd: root,
        maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0)
        throw new Error('Cannot enumerate committed source files');
    const counts: Record<ResourceDisposition, number> = {
        code: 0,
        profile: 0,
        local: 0,
        development: 0,
    };
    const codeFiles: { path: string; mode: number }[] = [];
    for (const line of result.stdout.toString().split('\0').filter(Boolean)) {
        const tab = line.indexOf('\t');
        const [mode, type] = line.slice(0, tab).split(' ');
        const path = line.slice(tab + 1);
        const disposition = classifySetupResource(path);
        counts[disposition]++;
        if (disposition !== 'code') continue;
        if (type !== 'blob' || !['100644', '100755'].includes(mode))
            throw new Error(
                `Code resources must be regular tracked files: ${path}`,
            );
        codeFiles.push({ path, mode: mode === '100755' ? 0o755 : 0o644 });
    }
    return { counts, codeFiles };
}

async function pinnedRuntimes(root: string, commit: string) {
    const pins = object(
        JSON.parse(gitFile(root, commit, 'agent/package.json').toString()),
    );
    const dependencies = object(pins.dependencies);
    const locations = Object.entries(dependencies)
        .filter(([name]) => name.startsWith('@earendil-works/'))
        .map(([name, value]) => {
            if (
                typeof value !== 'string' ||
                !/^file:\.\.\/runtime\/pi-core\/releases\/[A-Za-z0-9._-]+\/packed\/tarballs\/[^/]+\.tgz$/.test(
                    value,
                )
            )
                throw new Error(`Unsupported Pi runtime pin: ${name}`);
            return { name, path: resolve(root, 'agent', value.slice(5)) };
        });
    const packedRoots = new Set(
        locations.map((pin) => dirname(dirname(pin.path))),
    );
    if (packedRoots.size !== 1)
        throw new Error('Pi runtime pins must select one release');
    const packedRoot = [...packedRoots][0]!;
    const target = gitFile(root, commit, 'bin/zerobox').toString();
    const selected =
        /^\.\.\/runtimes\/zerobox\/([A-Za-z0-9._-]+)\/bin\/zerobox$/.exec(
            target,
        );
    if (!selected) throw new Error('Zerobox source must pin a managed release');
    const { parse } = await import('yaml');
    const workflow = object(
        parse(
            gitFile(
                root,
                commit,
                '.github/workflows/private-runtime-validation.yml',
            ).toString(),
        ),
    );
    const native = object(object(workflow.jobs).native);
    if (!Array.isArray(native.steps))
        throw new Error('Missing native engine source pin');
    const engine = native.steps
        .map((step) => object(object(step).with ?? {}))
        .find((step) => step.repository === 'abdwhb-png/zerobox');
    if (
        !engine ||
        typeof engine.ref !== 'string' ||
        !/^[a-f0-9]{40}$/.test(engine.ref)
    )
        throw new Error('Missing exact native engine source pin');
    return {
        packedRoot,
        packages: locations.map((pin) => ({
            name: pin.name,
            tarball: relative(packedRoot, pin.path),
        })),
        zeroRoot: dirname(dirname(resolve(root, 'bin', target))),
        zeroVersion: selected[1],
        engineCommit: engine.ref,
    };
}

async function validateRuntimes(
    pins: Awaited<ReturnType<typeof pinnedRuntimes>>,
    packedRoot: string,
    zeroRoot: string,
) {
    const { validatePackedReleaseDirectory } =
        await import('../pi-fork-release.ts');
    const runtime = validatePackedReleaseDirectory(packedRoot);
    for (const pin of pins.packages)
        if (
            !runtime.packages.some(
                (pkg) => pkg.name === pin.name && pkg.tarball === pin.tarball,
            )
        )
            throw new Error(
                `Pi runtime differs from its source pin: ${pin.name}`,
            );
    const provenancePath = join(zeroRoot, 'provenance.json');
    const { readPrivateRuntimeEntry, resolvePrivateRuntime } =
        await import('../../extensions/sandbox/runtime/runtime-bundle.ts');
    const entry = await readPrivateRuntimeEntry(
        join(zeroRoot, 'bin/zerobox'),
        pathToFileURL(provenancePath),
    );
    const zerobox = await resolvePrivateRuntime({
        binaryPath: entry.binaryPath,
        expectedBinarySha256: entry.provenance.binarySha256,
    });
    if (
        zerobox.version !== pins.zeroVersion ||
        zerobox.manifestSha256 !== entry.provenance.runtimeManifestSha256 ||
        zerobox.helperSha256 !== entry.provenance.helperSha256
    )
        throw new Error('Zerobox differs from its source release pin');
    if (json(provenancePath).sourceCommit !== pins.engineCommit)
        throw new Error('Zerobox engine differs from its source commit pin');
    return zerobox;
}

export async function packDistribution(
    sourceRoot: string,
    output: string,
    sourceCommit = resolveMainCommit(sourceRoot),
    options: { includeGlobalSkills?: boolean; progress?: SetupProgress } = {},
): Promise<void> {
    const lock = acquireRuntimeStorageLock(sourceRoot);
    try {
        await packDistributionLocked(sourceRoot, output, sourceCommit, options);
    } finally {
        lock.release();
    }
}

async function packDistributionLocked(
    sourceRoot: string,
    output: string,
    sourceCommit: string,
    options: { includeGlobalSkills?: boolean; progress?: SetupProgress },
): Promise<void> {
    sourceRoot = resolve(sourceRoot);
    output = resolve(output);
    if (!/^[a-f0-9]{40}$/.test(sourceCommit))
        throw new Error('Invalid source commit');
    assertClassifiedProfileConfigurations(sourceRoot);
    const code = auditDistributionResources(sourceRoot, sourceCommit).codeFiles;
    if (existsSync(output)) throw new Error('Output directory already exists');
    options.progress?.({ stage: 'runtimes', state: 'start' });
    const selected = await pinnedRuntimes(sourceRoot, sourceCommit);
    const packedRoot = selected.packedRoot;
    const zerobox = await validateRuntimes(
        selected,
        packedRoot,
        selected.zeroRoot,
    );
    options.progress?.({ stage: 'runtimes', state: 'done' });
    const temporary = mkdtempSync(join(tmpdir(), 'pi-setup-pack-'));
    try {
        const bundle = join(temporary, 'bundle');
        mkdirSync(bundle, { mode: 0o700 });
        for (const { path, mode } of code) {
            const target = child(join(bundle, 'setup'), path);
            mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
            writeFileSync(target, gitFile(sourceRoot, sourceCommit, path), {
                mode,
            });
            chmodSync(target, mode);
        }
        const packages = await setupStep(options.progress, 'profile', () =>
            captureProfile(
                sourceRoot,
                join(bundle, 'setup'),
                options.includeGlobalSkills ?? false,
            ),
        );
        cpSync(packedRoot, join(bundle, 'pi'), {
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
            sourceCommit,
            packages,
            files: inventory(bundle),
        };
        writeJson(join(bundle, 'manifest.json'), manifest);
        validateBundle(bundle);
        mkdirSync(output, { mode: 0o700 });
        await setupStep(options.progress, 'archive', () =>
            archiveAsync('pack', bundle, join(output, 'setup.tgz')),
        );
        writeJson(join(output, 'release.json'), {
            schemaVersion: 1,
            sourceCommit: manifest.sourceCommit,
            sha256: digest(readFileSync(join(output, 'setup.tgz'))),
        });
        writeJson(join(output, 'inventory.json'), manifest);
    } finally {
        writableDirectories(temporary);
        rmSync(temporary, { recursive: true, force: true });
    }
}

async function captureProfile(
    root: string,
    destination: string,
    includeGlobalSkills: boolean,
): Promise<string[]> {
    const { DefaultPackageManager, SettingsManager } =
        await import('@earendil-works/pi-coding-agent');
    const { toPortableHomePath } =
        await import('../../extensions/_shared/home-path.ts');
    const agentDir = join(root, 'agent');
    const settings = readProfileFile(root, 'agent/settings.json');
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
            const modified = run(
                'git',
                ['status', '--porcelain', '--untracked-files=no'],
                installed,
            );
            if (modified)
                throw new Error(
                    `Modified installed Git package: ${source}\n${modified}`,
                );
            pinned = `${source.split('@')[0]}@${run('git', ['rev-parse', 'HEAD'], installed)}`;
        } else if (
            source === './extensions/tool-groups' ||
            source === 'extensions/tool-groups'
        )
            pinned = './extensions/tool-groups';
        else throw new Error(`Unpackaged external resource: ${source}`);
        validatePackageSource(pinned);
        packages.push(pinned);
        return typeof item === 'string'
            ? pinned
            : { ...object(item), source: pinned };
    });
    settings.npmCommand = ['sfw', '--', 'bun'];
    delete settings.lastChangelogVersion;
    if (Array.isArray(settings.skills)) {
        settings.skills = settings.skills.filter((entry) => {
            if (typeof entry !== 'string' || /^[!+-]/.test(entry)) return true;
            const path = toPortableHomePath(entry, homedir());
            if (
                !includeGlobalSkills &&
                (path === '~/.pi/agent/portable-skills' ||
                    path.startsWith('~/.pi/agent/portable-skills/'))
            )
                return false;
            if (path === '~/.pi' || path.startsWith('~/.pi/')) return true;
            if (
                includeGlobalSkills &&
                (path === '~/.agents/skills' ||
                    path.startsWith('~/.agents/skills/'))
            )
                return true;
            return !path.startsWith('~/') && !path.startsWith('/');
        });
    }
    if (includeGlobalSkills) {
        const globalSkills = join(homedir(), '.agents/skills');
        if (!existsSync(globalSkills))
            throw new Error(
                'Global skills directory is absent: ~/.agents/skills. Omit --include-global-skills or synchronize it first.',
            );
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
            ...new Set(
                [
                    ...(Array.isArray(settings.skills) ? settings.skills : []),
                    '~/.pi/agent/portable-skills',
                ].map((entry) =>
                    entry === '~/.agents/skills'
                        ? '~/.pi/agent/portable-skills'
                        : entry,
                ),
            ),
        ];
    }
    function portable(value: unknown): unknown {
        if (typeof value === 'string') {
            const next = toPortableHomePath(value, homedir());
            if (
                includeGlobalSkills &&
                (next === '~/.agents/skills' ||
                    next.startsWith('~/.agents/skills/'))
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
        assertPortableProfileValue(path, object(normalized));
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
    for (const path of PORTABLE_PROFILE_FILES.keys()) {
        if (path === 'agent/settings.json') continue;
        if (lstatSync(join(root, path), { throwIfNoEntry: false }))
            save(path, readProfileFile(root, path));
    }
    return packages;
}

async function requirePrivateRepository(): Promise<void> {
    if (
        (await runAsync('gh', [
            'repo',
            'view',
            DISTRIBUTION_REPOSITORY,
            '--json',
            'isPrivate',
            '--jq',
            '.isPrivate',
        ])) !== 'true'
    )
        throw new Error('Distribution repository must be private');
}
export function releaseTag(tag: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(tag))
        throw new Error('Invalid release tag');
    return tag;
}
function distributionDescriptor(directory: string): {
    sourceCommit: string;
    sha256: string;
} {
    const value = json(join(directory, 'release.json'));
    if (
        value.schemaVersion !== 1 ||
        typeof value.sourceCommit !== 'string' ||
        !/^[a-f0-9]{40}$/.test(value.sourceCommit) ||
        typeof value.sha256 !== 'string' ||
        value.sha256 !== digest(readFileSync(join(directory, 'setup.tgz')))
    )
        throw new Error(
            'Distribution archive checksum or source descriptor mismatch',
        );
    return { sourceCommit: value.sourceCommit, sha256: value.sha256 };
}

async function unpackDistribution(
    directory: string,
    destination: string,
): Promise<SetupManifest> {
    const descriptor = distributionDescriptor(directory);
    await archiveAsync('extract', join(directory, 'setup.tgz'), destination);
    const manifest = validateBundle(destination);
    if (descriptor.sourceCommit !== manifest.sourceCommit)
        throw new Error('Release source descriptors disagree');
    return manifest;
}

export async function validateReleaseSource(
    root: string,
    bundle: string,
    expectedCommit: string,
): Promise<SetupManifest> {
    const lock = acquireRuntimeStorageLock(root);
    try {
        return await validateReleaseSourceLocked(root, bundle, expectedCommit);
    } finally {
        lock.release();
    }
}

async function validateReleaseSourceLocked(
    root: string,
    bundle: string,
    expectedCommit: string,
): Promise<SetupManifest> {
    resolveMainCommit(root, expectedCommit);
    const manifest = validateBundle(bundle);
    if (manifest.sourceCommit !== expectedCommit)
        throw new Error('Candidate and qualification source commits disagree');
    const expected = auditDistributionResources(root, expectedCommit).codeFiles;
    const actual = Object.keys(manifest.files)
        .filter(
            (path) =>
                path.startsWith('setup/') && allowedCodePath(path.slice(6)),
        )
        .sort();
    if (
        actual.join('\n') !==
        expected
            .map((file) => `setup/${file.path}`)
            .sort()
            .join('\n')
    )
        throw new Error('Candidate code inventory differs from main');
    for (const file of expected)
        if (
            manifest.files[`setup/${file.path}`] !==
            `${file.mode}:${digest(gitFile(root, expectedCommit, file.path))}`
        )
            throw new Error(`Candidate code differs from main: ${file.path}`);
    await validateRuntimes(
        await pinnedRuntimes(root, expectedCommit),
        join(bundle, 'pi'),
        join(bundle, 'zerobox'),
    );
    return manifest;
}

export async function publishDistribution(
    directory: string,
    tag: string,
    sourceRoot: string,
): Promise<string> {
    releaseTag(tag);
    await requirePrivateRepository();
    const temporary = mkdtempSync(join(tmpdir(), 'pi-setup-publish-'));
    try {
        const bundle = join(temporary, 'bundle');
        const manifest = await unpackDistribution(directory, bundle);
        await validateReleaseSource(sourceRoot, bundle, manifest.sourceCommit);
        const config = JSON.parse(
            await runAsync('gh', [
                'api',
                `repos/${DISTRIBUTION_REPOSITORY}/immutable-releases`,
            ]),
        );
        if (!config.enabled)
            throw new Error(
                'Enable immutable releases on the private distribution repository before publishing',
            );
        await runAsync('gh', [
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
            'Private Pi setup awaiting qualification. Memories and credentials are excluded.',
        ]);
        const descriptor = distributionDescriptor(directory);
        await runAsync('gh', [
            'workflow',
            'run',
            'portable-private-qualification.yml',
            '--repo',
            DISTRIBUTION_REPOSITORY,
            '--ref',
            'main',
            '-f',
            `source_sha=${manifest.sourceCommit}`,
            '-f',
            `candidate_release=${tag}`,
            '-f',
            `candidate_sha256=${descriptor.sha256}`,
            '-f',
            'publish=true',
        ]);
        return `https://github.com/${DISTRIBUTION_REPOSITORY}/actions/workflows/portable-private-qualification.yml`;
    } finally {
        writableDirectories(temporary);
        rmSync(temporary, { recursive: true, force: true });
    }
}

interface DraftRelease {
    tag: string;
    releaseId: number;
    assets: { id: number; name: string; size: number }[];
}
function draftRelease(tag: string): DraftRelease {
    releaseTag(tag);
    const value = object(
        JSON.parse(
            run('gh', [
                'release',
                'view',
                tag,
                '--repo',
                DISTRIBUTION_REPOSITORY,
                '--json',
                'databaseId,isDraft,tagName',
            ]),
        ),
    );
    if (
        value.isDraft !== true ||
        value.tagName !== tag ||
        !Number.isSafeInteger(value.databaseId) ||
        Number(value.databaseId) <= 0
    )
        throw new Error('Candidate must be an existing private draft');
    const releaseId = Number(value.databaseId);
    const raw: unknown = JSON.parse(
        run('gh', [
            'api',
            `repos/${DISTRIBUTION_REPOSITORY}/releases/${releaseId}/assets`,
        ]),
    );
    if (!Array.isArray(raw)) throw new Error('Invalid draft assets');
    const assets = raw
        .map((entry) => {
            const item = object(entry);
            if (
                !Number.isSafeInteger(item.id) ||
                !Number.isSafeInteger(item.size) ||
                Number(item.size) <= 0 ||
                !['setup.tgz', 'release.json'].includes(String(item.name))
            )
                throw new Error(
                    'Draft must contain only setup.tgz and release.json',
                );
            return {
                id: Number(item.id),
                name: String(item.name),
                size: Number(item.size),
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    if (
        assets.length !== 2 ||
        new Set(assets.map((asset) => asset.name)).size !== 2
    )
        throw new Error('Draft must contain exactly two candidate assets');
    return { tag, releaseId, assets };
}

export async function downloadDraftDistribution(options: {
    tag: string;
    directory: string;
    sourceRoot: string;
    sourceCommit: string;
    archiveSha256: string;
}): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(options.archiveSha256))
        throw new Error('Expected candidate archive SHA-256');
    resolveMainCommit(options.sourceRoot, options.sourceCommit);
    await requirePrivateRepository();
    const release = draftRelease(options.tag);
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    run('gh', [
        'release',
        'download',
        options.tag,
        '--repo',
        DISTRIBUTION_REPOSITORY,
        '--dir',
        options.directory,
        '--pattern',
        'setup.tgz',
        '--pattern',
        'release.json',
    ]);
    if (
        digest(readFileSync(join(options.directory, 'setup.tgz'))) !==
        options.archiveSha256
    )
        throw new Error('Candidate archive differs from the requested SHA-256');
    const bundle = join(options.directory, 'bundle');
    await unpackDistribution(options.directory, bundle);
    await validateReleaseSource(
        options.sourceRoot,
        bundle,
        options.sourceCommit,
    );
    if (JSON.stringify(release) !== JSON.stringify(draftRelease(options.tag)))
        throw new Error('Draft changed while downloading');
    writeJson(join(options.directory, 'candidate.json'), {
        schemaVersion: 1,
        ...release,
        sourceCommit: options.sourceCommit,
        archiveSha256: options.archiveSha256,
        descriptorSha256: digest(
            readFileSync(join(options.directory, 'release.json')),
        ),
    });
    return bundle;
}

function verifyPublishedRelease(tag: string): void {
    for (let attempt = 0; ; attempt++) {
        try {
            run('gh', [
                'release',
                'verify',
                tag,
                '--repo',
                DISTRIBUTION_REPOSITORY,
            ]);
            return;
        } catch (error) {
            if (
                attempt >= 29 ||
                !(error instanceof Error) ||
                (!error.message.includes('no attestations for tag') &&
                    !error.message.includes(
                        'no attestations found for release',
                    ))
            )
                throw error;
            Bun.sleepSync(1000);
        }
    }
}

export async function finalizeDistribution(options: {
    sourceRoot: string;
    directory: string;
    evidenceDirectory: string;
}): Promise<void> {
    if (
        process.env.GITHUB_ACTIONS !== 'true' ||
        process.env.GITHUB_REPOSITORY !== DISTRIBUTION_REPOSITORY ||
        process.env.GITHUB_ACTOR !== DISTRIBUTION_REPOSITORY.split('/')[0]
    )
        throw new Error(
            'Publication is restricted to the owner qualification workflow',
        );
    const receipt = json(join(options.directory, 'candidate.json'));
    if (
        receipt.schemaVersion !== 1 ||
        typeof receipt.tag !== 'string' ||
        typeof receipt.sourceCommit !== 'string' ||
        typeof receipt.archiveSha256 !== 'string' ||
        typeof receipt.descriptorSha256 !== 'string'
    )
        throw new Error('Invalid candidate receipt');
    const qualification = json(
        join(options.evidenceDirectory, 'qualification.json'),
    );
    if (
        qualification.status !== 'passed' ||
        qualification.scope !== 'full' ||
        qualification.sourceCommit !== receipt.sourceCommit ||
        qualification.bundleSourceCommit !== receipt.sourceCommit ||
        qualification.bundleSha256 !== receipt.archiveSha256
    )
        throw new Error(
            'Publication requires full qualification of the exact candidate',
        );
    const profile = json(join(options.evidenceDirectory, 'profile.json'));
    if (
        profile.status !== 'passed' ||
        profile.sourceCommit !== receipt.sourceCommit ||
        profile.bundleSha256 !== receipt.archiveSha256
    )
        throw new Error(
            'Publication requires complete profile qualification of the exact candidate',
        );
    if (
        digest(readFileSync(join(options.directory, 'setup.tgz'))) !==
            receipt.archiveSha256 ||
        digest(readFileSync(join(options.directory, 'release.json'))) !==
            receipt.descriptorSha256
    )
        throw new Error('Qualified candidate changed');
    await requirePrivateRepository();
    const release = draftRelease(receipt.tag);
    if (
        receipt.releaseId !== release.releaseId ||
        JSON.stringify(receipt.assets) !== JSON.stringify(release.assets)
    )
        throw new Error('Qualified draft assets changed');
    const temporary = mkdtempSync(join(tmpdir(), 'pi-setup-finalize-'));
    try {
        const downloaded = join(temporary, 'draft');
        await downloadDraftDistribution({
            tag: receipt.tag,
            directory: downloaded,
            sourceRoot: options.sourceRoot,
            sourceCommit: receipt.sourceCommit,
            archiveSha256: receipt.archiveSha256,
        });
        const current = json(join(downloaded, 'candidate.json'));
        if (JSON.stringify(receipt) !== JSON.stringify(current))
            throw new Error('Qualified draft changed');
        const config = object(
            JSON.parse(
                run('gh', [
                    'api',
                    `repos/${DISTRIBUTION_REPOSITORY}/immutable-releases`,
                ]),
            ),
        );
        if (config.enabled !== true)
            throw new Error('Immutable releases must remain enabled');
        run('gh', [
            'release',
            'edit',
            receipt.tag,
            '--repo',
            DISTRIBUTION_REPOSITORY,
            '--draft=false',
            '--latest',
            '--notes',
            `Qualified Pi setup. Source: ${receipt.sourceCommit}. Archive SHA-256: ${receipt.archiveSha256}.`,
        ]);
        verifyPublishedRelease(receipt.tag);
        const published = join(temporary, 'published');
        await downloadDistribution(receipt.tag, published);
        if (
            digest(readFileSync(join(published, 'setup.tgz'))) !==
                receipt.archiveSha256 ||
            digest(readFileSync(join(published, 'release.json'))) !==
                receipt.descriptorSha256
        )
            throw new Error(
                'Published assets differ from the qualified candidate',
            );
        writeJson(join(options.evidenceDirectory, 'publication.json'), {
            status: 'passed',
            tag: receipt.tag,
            sourceCommit: receipt.sourceCommit,
            archiveSha256: receipt.archiveSha256,
        });
    } finally {
        writableDirectories(temporary);
        rmSync(temporary, { recursive: true, force: true });
    }
}

export async function downloadDistribution(
    tag: string,
    directory: string,
    progress?: SetupProgress,
): Promise<string> {
    releaseTag(tag);
    await setupStep(progress, 'repository', () => requirePrivateRepository());
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    await setupStep(progress, 'release', () =>
        runAsync('gh', [
            'release',
            'verify',
            tag,
            '--repo',
            DISTRIBUTION_REPOSITORY,
        ]),
    );
    await setupStep(progress, 'download', () =>
        runAsync('gh', [
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
        ]),
    );
    await setupStep(progress, 'attestations', async () => {
        for (const file of ['setup.tgz', 'release.json'])
            await runAsync('gh', [
                'release',
                'verify-asset',
                tag,
                join(directory, file),
                '--repo',
                DISTRIBUTION_REPOSITORY,
            ]);
    });
    const bundle = join(directory, 'bundle');
    await setupStep(progress, 'extract', () =>
        unpackDistribution(directory, bundle),
    );
    return bundle;
}
