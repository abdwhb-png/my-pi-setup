import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    cpSync,
    openSync,
    closeSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    writeFileSync,
    symlinkSync,
    unlinkSync,
} from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { cleanupRuntimes } from '../../agent/bin/setup/cleanup.ts';
import {
    packDistribution,
    downloadDraftDistribution,
    DISTRIBUTION_REPOSITORY,
    validateBundle,
    LOCAL_CONNECTION_FILES,
    LOCAL_PROFILE_FILES,
} from '../../agent/bin/setup/distribution.ts';
import {
    archive,
    digest,
    inventory,
    json,
    object,
    run,
    writeJson,
} from '../../agent/bin/setup/files.ts';
import {
    installBundle,
    rollbackInstallation,
    readInstallation,
} from '../../agent/bin/setup/installation.ts';
import { resolveDevelopmentTools } from '../../agent/extensions/sandbox/development-tools.ts';
import { stageRuntimeRelease } from '../../agent/extensions/sandbox/runtime/distribution/stage-release.ts';

assert.equal(
    process.env.GITHUB_ACTIONS,
    'true',
    'Qualification is restricted to disposable CI hosts',
);
const source = resolve(process.argv[2]);
const work = resolve(process.env.QUALIFICATION_ROOT!);
const zero = resolve(process.env.QUALIFICATION_ZEROBOX!);
assert.notEqual(source, join(process.env.HOME!, '.pi'));
const evidence = join(work, 'evidence');
const sources = [
    'npm:pi-hermes-memory@0.9.10',
    'npm:@gotgenes/pi-permission-system@33.0.0',
    'git:github.com/abdwhb-png/pi-fancy-footer@14c979fad9a93aa58c7c38fed736fc03a04a429e',
    './extensions/tool-groups',
];
const profilePreferences = {
    'fancy-footer.json': {
        widgets: {
            model: { enabled: false },
            'provider-status': { enabled: false },
        },
        extensionWidgets: {
            'extension-statuses': { row: 1 },
            'local-compressor': { row: 0 },
        },
    },
    'fancy-footer.local.json': {
        extensionStatusHiddenIds: ['fixture-hidden'],
        responsive: { enabled: false },
        widgets: {
            'extension-statuses': { placement: 'aboveEditor', twoLine: true },
        },
        extensionWidgets: { 'local-compressor': { placement: 'aboveEditor' } },
    },
    'pi-session-recall.json': {
        queryModel: { provider: 'fixture', id: 'query' },
        'fallback-models': [],
    },
};
const localConnections = {
    'models.json': { providers: {} },
    'mcp.json': {
        mcpServers: {
            fixture: {
                url: 'https://fixture.invalid/mcp',
                headers: { Authorization: 'Bearer ${FIXTURE_MCP_TOKEN}' },
                enabled: false,
            },
        },
    },
    'mcp-adapter.json': {
        mcpServers: {
            fixture: {
                command: 'fixture-unavailable',
                env: { FIXTURE_API_KEY: '${FIXTURE_API_KEY}' },
                enabled: false,
            },
        },
    },
};
const milestones: string[] = [];
function passed(name: string) {
    milestones.push(name);
    console.log(`PASS: ${name}`);
    writeJson(join(evidence, 'result.json'), {
        sourceCommit: process.env.QUALIFICATION_SOURCE_SHA,
        toolLayout: process.env.QUALIFICATION_TOOL_LAYOUT,
        platform: process.env.QUALIFICATION_PLATFORM,
        kernel: run('uname', ['-r']),
        milestones,
    });
}

function assertLocalProfilesUnmanaged(root: string) {
    const managed = object(json(join(root, '.pi-setup-state.json')).managed);
    for (const path of LOCAL_PROFILE_FILES)
        assert(
            !Object.hasOwn(managed, path),
            `Setup must not own local profile state: ${path}`,
        );
}

function runTests(
    name: string,
    tests: string[],
    cwd: string,
    env = process.env,
) {
    const log = join(evidence, `${name}.log`);
    const output = openSync(log, 'wx', 0o600);
    let result;
    try {
        result = spawnSync(
            'timeout',
            [
                '--kill-after=10s',
                '300s',
                process.execPath,
                'test',
                '--isolate',
                ...tests,
            ],
            {
                cwd,
                env,
                stdio: ['ignore', output, output],
            },
        );
    } finally {
        closeSync(output);
    }
    assert.equal(
        result.status,
        0,
        `${name} failed: ${result.error?.message ?? result.signal ?? result.status}\n${readFileSync(log, 'utf8').slice(-8000)}`,
    );
}

const privateProfile = process.env.QUALIFICATION_MODE === 'private';
const profileOnly = process.env.QUALIFICATION_PROFILE_ONLY === 'true';
assert(
    !profileOnly || privateProfile,
    'Profile-only diagnosis requires a private candidate',
);
let bundle: string;
if (privateProfile) {
    const downloaded = join(work, 'release-one');
    bundle = await downloadDraftDistribution({
        tag: process.env.QUALIFICATION_RELEASE!,
        directory: downloaded,
        sourceRoot: source,
        sourceCommit: process.env.QUALIFICATION_SOURCE_SHA!,
        archiveSha256: process.env.QUALIFICATION_ARCHIVE_SHA256!,
    });
    passed('verified private draft downloaded without publication');
    delete process.env.PI_PACKAGE_FINALIZER_ACTIVE;
    delete process.env.GH_TOKEN;
} else {
    // Only disposable checkout state is replaced; no personal profile enters CI.
    for (const entry of readdirSync(join(source, 'agent/config'))) {
        if (entry.endsWith('.json') && !entry.endsWith('.example.json'))
            rmSync(join(source, 'agent/config', entry));
    }
    writeJson(join(source, 'agent/settings.json'), {
        packages: sources,
        npmCommand: ['sfw', '--', 'bun'],
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
        enableSkillCommands: false,
    });
    for (const [name, value] of Object.entries({
        ...profilePreferences,
        ...localConnections,
    }))
        writeJson(join(source, 'agent', name), value);
    writeJson(join(source, 'agent/config/ai-providers.json'), {
        providers: {
            cpa: {
                enabled: false,
                baseUrl: 'http://127.0.0.1:18317/v1',
                refreshTtlMs: 30000,
            },
        },
    });
    for (const packageSource of sources) {
        run(
            process.execPath,
            [join(source, 'bin/pi'), 'install', packageSource, '--no-approve'],
            join(source, 'agent'),
        );
    }
    delete process.env.PI_PACKAGE_FINALIZER_ACTIVE;
    run(
        process.execPath,
        [join(source, 'bin/pi'), 'list', '--no-approve'],
        source,
    );
    const stagedRelease = await stageRuntimeRelease({
        candidateRoot: zero,
        runtimeBase: join(source, 'runtimes'),
        managedBinary: join(source, 'bin/zerobox'),
        provenanceSource: join(zero, 'provenance.json'),
        expectedBinarySha256: String(
            json(join(zero, 'provenance.json')).binarySha256,
        ),
    });
    const managedBinary = join(source, 'bin/zerobox');
    unlinkSync(managedBinary);
    symlinkSync(
        relative(dirname(managedBinary), join(stagedRelease, 'bin/zerobox')),
        managedBinary,
    );
    // The importer owns these generated manifests; record the disposable producer snapshot.
    run(
        'git',
        [
            '-c',
            'user.name=Pi CI',
            '-c',
            'user.email=pi-ci@example.invalid',
            'add',
            'agent/package.json',
            'agent/bun.lock',
            'bin/zerobox',
        ],
        source,
    );
    run(
        'git',
        [
            '-c',
            'user.name=Pi CI',
            '-c',
            'user.email=pi-ci@example.invalid',
            'commit',
            '--allow-empty',
            '-m',
            'Record qualification producer dependency graph',
        ],
        source,
    );
    passed('producer imports the frozen Pi runtime and real package sources');

    writeFileSync(
        join(evidence, 'portable-types.log'),
        run(
            join(source, 'agent/node_modules/.bin/tsc'),
            [
                '--noEmit',
                '-p',
                join(source, '.github/scripts/tsconfig.portability.json'),
            ],
            join(source, 'agent'),
        ),
    );
    passed('portable operator and qualification types');
    runTests(
        'operator-regressions',
        [
            'bin/setup',
            'extensions/ai-providers',
            'extensions/notify',
            'extensions/slow-mode',
            'bin/pi-cpa-startup.integration.test.ts',
            'bin/pi-fork-cli.test.ts',
            'bin/pi-fork-release.test.ts',
            'bin/pi-runtime-store.test.ts',
            'bin/pi-wrapper-lib.test.ts',
            'scripts/configure-sandbox.test.ts',
            '../.github/scripts/qualify-portable-setup.test.ts',
            'extensions/sandbox/capabilities/development-tools.test.ts',
            'extensions/sandbox/capabilities/php-discovery.integration.test.ts',
            'extensions/sandbox/capabilities/development-setup.test.ts',
            'extensions/sandbox/doctor.test.ts',
            'extensions/_shared/redaction.test.ts',
            'extensions/_shared/runtime-storage.test.ts',
            'extensions/sandbox/runtime/distribution/distribution.test.ts',
            'extensions/sandbox/runtime/private-temp.test.ts',
            'extensions/sandbox/runtime/runtime-bundle.test.ts',
            'extensions/sandbox/preparation.test.ts',
        ],
        join(source, 'agent'),
        {
            ...process.env,
            PI_PHP_DISCOVERY_CONTRACT: '1',
            PI_CPA_AVAILABILITY_CONTRACT: '1',
        },
    );
    passed('operator and launcher regression suites');

    await packDistribution(
        source,
        join(work, 'release-one'),
        run('git', ['rev-parse', 'HEAD'], source),
    );
    archive(
        'extract',
        join(work, 'release-one/setup.tgz'),
        join(work, 'bundle-one'),
    );
    bundle = join(work, 'bundle-one');
}
const manifest = validateBundle(bundle);
const roleFiles = run(
    'git',
    [
        'ls-tree',
        '-r',
        '-z',
        '--name-only',
        manifest.sourceCommit,
        '--',
        'agent/roles',
    ],
    source,
)
    .split('\0')
    .filter(Boolean);
assert(roleFiles.length > 0, 'Expected a committed role catalog');
for (const path of roleFiles)
    assert(manifest.files[`setup/${path}`], `Missing committed role: ${path}`);
for (const path of LOCAL_CONNECTION_FILES.keys())
    assert(
        !manifest.files[`setup/${path}`],
        `Machine-local connection file was packaged: ${path}`,
    );
assert(
    !Object.keys(manifest.files).some((path) =>
        /auth\.json|sessions\/|pi-hermes-memory\//.test(path),
    ),
);
passed(
    privateProfile
        ? 'validate private profile inventory'
        : 'pack and extract a synthetic profile with real validated runtimes',
);

const home = resolve(process.env.QUALIFICATION_HOME!);
assert(
    !existsSync(join(home, '.pi')),
    'Destination must not already contain Pi',
);
process.env.HOME = home;
if (process.env.QUALIFICATION_TOOL_LAYOUT === 'mise') {
    // Starting Bun through mise activates direct tool paths; restore shims to qualify their resolution too.
    const shims = join(home, '.local/share/mise/shims');
    assert(
        existsSync(join(shims, 'node')),
        'The mise layout must provide real shims',
    );
    process.env.PATH = `${shims}:${process.env.PATH ?? ''}`;
}
const target = join(home, '.pi');
process.env.PI_CODING_AGENT_DIR = join(target, 'agent');
const profile = json(
    join(bundle, 'setup/agent/config/sandbox.development.example.json'),
);
const logicalTools = profile.tools !== undefined;
let bindings: string | undefined;
let expectedTools: ReturnType<typeof resolveDevelopmentTools>['tools'] = [];
if (logicalTools) {
    const discovered = resolveDevelopmentTools(profile.tools, {
        variables:
            profile.environment && typeof profile.environment === 'object'
                ? (profile.environment as Record<string, unknown>).variables
                : undefined,
    });
    assert.deepEqual(discovered.unavailable, []);
    expectedTools = discovered.tools;
    writeJson(join(evidence, 'tool-discovery.json'), {
        tools: expectedTools,
        installations: discovered.installations,
    });
} else {
    const hostBinary = (name: string) => realpathSync(run('which', [name]));
    const binding = (name: string) => {
        const binary = hostBinary(name);
        return [
            {
                root: dirname(binary),
                files: [binary.slice(dirname(binary).length + 1)],
                path: ['.'],
            },
        ];
    };
    bindings = join(work, 'bindings.json');
    writeJson(bindings, {
        environment: {
            installations: {
                'pnpm-corepack': [
                    ...binding('node'),
                    {
                        root: dirname(dirname(hostBinary('pnpm'))),
                        path: ['dist'],
                    },
                ],
                bun: binding('bun'),
                go: [
                    { root: dirname(dirname(hostBinary('go'))), path: ['bin'] },
                ],
                python: binding('python3'),
                php: [...binding('php'), ...binding('composer')],
            },
        },
    });
}
await installBundle({
    root: target,
    bundle,
    release: 'qualification-one',
    bindings,
    dryRun: true,
});
assert(!existsSync(target));
await installBundle({
    root: target,
    bundle,
    release: 'qualification-one',
    bindings,
});
assert(!existsSync(join(target, '.git')));
run(process.execPath, [join(target, 'bin/pi-fork'), 'verify'], home);
run(process.execPath, [join(target, 'bin/pi'), '--version'], home);
run(process.execPath, [join(target, 'bin/pi'), 'list'], home);
passed('clean target installation, runtime coherence and daily launcher');
assertLocalProfilesUnmanaged(target);
for (const path of LOCAL_CONNECTION_FILES.keys())
    assert(
        !existsSync(join(target, path)),
        `Fresh installation created a local connection file: ${path}`,
    );

if (!privateProfile) {
    for (const [name, expected] of Object.entries(profilePreferences))
        assert.deepEqual(
            json(join(target, 'agent', name)),
            expected,
            `Restored ${name} differs from the synthetic profile`,
        );
}

if (logicalTools)
    runTests(
        'installed-development-tools',
        ['extensions/sandbox/runtime/development-tools.integration.test.ts'],
        join(target, 'agent'),
        {
            ...process.env,
            PI_INSTALLED_TOOL_DISCOVERY_CONTRACT: '1',
            PI_TOOL_DISCOVERY_EXPECTED: JSON.stringify(expectedTools),
        },
    );
assert.equal(
    readFileSync(join(home, '.host-tools-marker'), 'utf8'),
    'host tools remain local\n',
);
if (logicalTools)
    passed(
        'discovered host tools execute inside the sandbox without writing to their installations',
    );

runTests(
    'installed-sandbox',
    [
        'extensions/sandbox/runtime/installed-runtime.integration.test.ts',
        ...(!privateProfile ? ['bin/setup/profile.runtime.test.ts'] : []),
    ],
    join(target, 'agent'),
    {
        ...process.env,
        PI_SANDBOX_INSTALLED_CONTRACT: '1',
        PI_PORTABLE_PROFILE_CONTRACT: privateProfile ? undefined : '1',
        PI_PORTABLE_ROLE_FILES: JSON.stringify(roleFiles),
    },
);
passed('real bash and safe_bash through the installed native sandbox');
if (!privateProfile)
    passed(
        'installed profile preferences and real footer rendering preserve the exported configuration',
    );

if (!privateProfile) {
    const sourceMemory = join(source, 'agent/pi-hermes-memory');
    mkdirSync(sourceMemory, { recursive: true });
    writeFileSync(
        join(sourceMemory, 'MEMORY.md'),
        'CI global memory survives transfer',
    );
    writeFileSync(
        join(sourceMemory, 'session.jsonl'),
        'CI excluded source session',
    );
    const memoryArchive = join(work, 'global-memory.json');
    run(
        process.execPath,
        [
            join(source, 'bin/pi-setup'),
            'memory',
            'export',
            '--root',
            source,
            '--output',
            memoryArchive,
        ],
        work,
    );
    assert(
        !readFileSync(memoryArchive, 'utf8').includes(
            'CI excluded source session',
        ),
    );
    run(
        process.execPath,
        [
            join(target, 'bin/pi-setup'),
            'memory',
            'import',
            '--input',
            memoryArchive,
        ],
        home,
    );
    const db = new Database(
        join(target, 'agent/pi-hermes-memory/sessions.db'),
        {
            readonly: true,
        },
    );
    assert.deepEqual(db.query('SELECT COUNT(*) AS n FROM messages').get(), {
        n: 0,
    });
    assert.deepEqual(
        db
            .query(
                "SELECT COUNT(*) AS n FROM memory_fts WHERE memory_fts MATCH 'survives'",
            )
            .get(),
        { n: 1 },
    );
    db.close();
    passed('global memory transfer rebuilds search without session messages');
}

if (!profileOnly) {
    for (const [name, value] of Object.entries(localConnections))
        writeJson(join(target, 'agent', name), value);
    const catalogPath = join(target, 'agent/models-store.json');
    if (!existsSync(catalogPath)) writeJson(catalogPath, {});
    // Reproduce an older operator's ownership before personal changes.
    const legacyState = json(join(target, '.pi-setup-state.json'));
    const legacyFiles = inventory(target);
    legacyState.managed = {
        ...object(legacyState.managed),
        ...Object.fromEntries(
            [...LOCAL_CONNECTION_FILES.keys(), 'agent/models-store.json'].map(
                (path) => [path, legacyFiles[path]],
            ),
        ),
    };
    legacyState.schemaVersion = 1;
    delete legacyState.profileDefaults;
    delete legacyState.profilePreferences;
    delete legacyState.previousProfileDefaults;
    writeJson(join(target, '.pi-setup-state.json'), legacyState);
    writeJson(catalogPath, {
        ...json(catalogPath),
        'qualification-fixture': { models: [], checkedAt: 1 },
    });
    run(
        process.execPath,
        [
            join(target, 'bin/pi'),
            '--no-extensions',
            '--list-models',
            '--no-approve',
        ],
        home,
    );
    writeJson(join(target, 'agent/mcp.json'), {
        mcpServers: {},
        personal: true,
    });
    rmSync(join(target, 'agent/models.json'));
    const adapter = join(work, 'local-mcp-adapter.json');
    writeJson(adapter, localConnections['mcp-adapter.json']);
    rmSync(join(target, 'agent/mcp-adapter.json'));
    symlinkSync(adapter, join(target, 'agent/mcp-adapter.json'));
    const localBeforeUpdate = inventory(target);
    const assertLocalConnections = () => {
        assertLocalProfilesUnmanaged(target);
        assert.deepEqual(object(json(catalogPath)['qualification-fixture']), {
            models: [],
            checkedAt: 1,
        });
        const current = inventory(target);
        for (const path of LOCAL_CONNECTION_FILES.keys()) {
            assert.equal(
                current[path],
                localBeforeUpdate[path],
                `Changed local connection file: ${path}`,
            );
            assert.equal(
                readInstallation(target).managed[path],
                undefined,
                `Managed a local connection file: ${path}`,
            );
        }
    };
    writeJson(join(target, 'agent/auth.json'), {});
    mkdirSync(join(target, 'agent/sessions'), { recursive: true });
    writeFileSync(
        join(target, 'agent/sessions/ci-marker'),
        'preserve local sessions',
    );
    const settingsPath = join(target, 'agent/settings.json');
    writeJson(settingsPath, { ...json(settingsPath), hideThinkingBlock: true });
    const footerLocalPath = join(target, 'agent/fancy-footer.local.json');
    const hidden = json(footerLocalPath).extensionStatusHiddenIds;
    const machineHidden = [
        ...(Array.isArray(hidden) ? hidden : []),
        'machine-only-fixture',
    ];
    writeJson(footerLocalPath, {
        ...json(footerLocalPath),
        extensionStatusHiddenIds: machineHidden,
    });
    const cpaPath = join(target, 'agent/config/ai-providers.json');
    if (!privateProfile) {
        const config = json(cpaPath);
        const providers = object(config.providers);
        writeJson(cpaPath, {
            ...config,
            providers: {
                ...providers,
                cpa: {
                    ...object(providers.cpa),
                    baseUrl: 'http://127.0.0.1:28317/v1',
                },
            },
        });
    }
    const assertMachinePreferences = () => {
        assert.equal(json(settingsPath).hideThinkingBlock, true);
        assert.deepEqual(
            json(footerLocalPath).extensionStatusHiddenIds,
            machineHidden,
        );
        if (!privateProfile)
            assert.equal(
                object(object(json(cpaPath).providers).cpa).baseUrl,
                'http://127.0.0.1:28317/v1',
            );
    };
    const next = join(work, 'bundle-two');
    cpSync(bundle, next, { recursive: true, verbatimSymlinks: true });
    writeFileSync(
        join(next, 'setup/agent/prompts/qualification-version.md'),
        'Synthetic update marker',
    );
    writeJson(join(next, 'setup/agent/settings.json'), {
        ...json(join(next, 'setup/agent/settings.json')),
        hideThinkingBlock: false,
    });
    writeJson(join(next, 'setup/agent/fancy-footer.json'), {
        ...json(join(next, 'setup/agent/fancy-footer.json')),
        gaugeWidth: 18,
    });
    rmSync(join(next, 'manifest.json'));
    writeJson(join(next, 'manifest.json'), {
        ...manifest,
        files: inventory(next),
    });
    await installBundle({
        root: target,
        bundle: next,
        release: 'qualification-two',
        update: true,
        bindings,
        loadPreviousBundle: async (release) => {
            assert.equal(release, 'qualification-one');
            return bundle;
        },
    });
    assert(existsSync(join(target, 'agent/prompts/qualification-version.md')));
    assertMachinePreferences();
    assert.equal(json(join(target, 'agent/fancy-footer.json')).gaugeWidth, 18);
    assertLocalConnections();
    assert.equal(
        await installBundle({
            root: target,
            bundle: next,
            release: 'qualification-two',
            update: true,
            bindings,
        }),
        'Already installed',
    );
    await rollbackInstallation(target);
    assert.equal(readInstallation(target).release, 'qualification-one');
    assertMachinePreferences();
    passed(
        'machine preferences survive real update and rollback while defaults advance',
    );
    assertLocalConnections();
    passed(
        'local connections and a refreshed model catalog survive runtime initialization, update and rollback',
    );
    assert(!existsSync(join(target, 'agent/prompts/qualification-version.md')));
    assert.equal(
        readFileSync(join(target, 'agent/sessions/ci-marker'), 'utf8'),
        'preserve local sessions',
    );
    if (!privateProfile)
        assert(
            readFileSync(
                join(target, 'agent/pi-hermes-memory/MEMORY.md'),
                'utf8',
            ).includes('survives'),
        );
    run(process.execPath, [join(target, 'bin/pi-setup'), 'check'], home);
    await cleanupRuntimes(target, true);
    passed(
        'real update, idempotency, rollback, runtime cleanup and post-rollback integrity',
    );
    const incompatibleSettingsPath = join(next, 'setup/agent/settings.json');
    const validSettings = readFileSync(incompatibleSettingsPath);
    writeJson(incompatibleSettingsPath, {
        ...json(incompatibleSettingsPath),
        hideThinkingBlock: { incompatible: true },
    });
    rmSync(join(next, 'manifest.json'));
    writeJson(join(next, 'manifest.json'), {
        ...validateBundle(bundle),
        files: inventory(next),
    });
    const beforeConflict = inventory(target);
    await assert.rejects(
        installBundle({
            root: target,
            bundle: next,
            release: 'qualification-two',
            update: true,
            bindings,
        }),
        /Incompatible local preference/,
    );
    assert.deepEqual(inventory(target), beforeConflict);
    writeFileSync(incompatibleSettingsPath, validSettings);
    rmSync(join(next, 'manifest.json'));
    writeJson(join(next, 'manifest.json'), {
        ...validateBundle(bundle),
        files: inventory(next),
    });
    passed(
        'incompatible preferences stop before activation without changing the installed tree',
    );
    const originalLauncher = readFileSync(join(target, 'bin/pi'));
    writeFileSync(join(target, 'bin/pi'), '\n// local change\n', { flag: 'a' });
    await assert.rejects(
        installBundle({
            root: target,
            bundle: next,
            release: 'qualification-two',
            update: true,
            bindings,
        }),
        /Local change/,
    );
    writeFileSync(join(target, 'bin/pi'), originalLauncher);
    passed('modified managed files refuse updates');
}
writeJson(join(evidence, 'qualification.json'), {
    status: 'passed',
    scope: profileOnly ? 'profile-installation' : 'full',
    sourceCommit: process.env.QUALIFICATION_SOURCE_SHA,
    toolLayout: process.env.QUALIFICATION_TOOL_LAYOUT,
    platform: process.env.QUALIFICATION_PLATFORM,
    kernel: run('uname', ['-r']),
    bundleSourceCommit: manifest.sourceCommit,
    bundleSha256: digest(readFileSync(join(work, 'release-one/setup.tgz'))),
    packages: manifest.packages,
    milestones,
    exclusions: privateProfile
        ? [
              'personal memory transfer (optional memory mechanism is covered by synthetic qualification)',
              ...(profileOnly
                  ? [
                        'update, idempotency, rollback and modified-file refusal omitted for profile-only diagnosis',
                    ]
                  : []),
              'private GitHub publication (separate publication.json evidence after full qualification)',
              'personal extension lifecycle and provider connectivity (separate profile.json evidence)',
          ]
        : [
              'personal profile',
              'private GitHub publication and download',
              'provider connectivity',
          ],
});
