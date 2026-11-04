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
import {
    packDistribution,
    downloadDraftDistribution,
    DISTRIBUTION_REPOSITORY,
    validateBundle,
} from '../../agent/bin/setup/distribution.ts';
import {
    archive,
    digest,
    inventory,
    json,
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
    'git:github.com/abdwhb-png/pi-fancy-footer@98da1a46df80d88ad9842c967676d80a99e275d9',
    './extensions/tool-groups',
];
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
    ['extensions/sandbox/runtime/installed-runtime.integration.test.ts'],
    join(target, 'agent'),
    { ...process.env, PI_SANDBOX_INSTALLED_CONTRACT: '1' },
);
passed('real bash and safe_bash through the installed native sandbox');

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
    writeJson(join(target, 'agent/auth.json'), {});
    mkdirSync(join(target, 'agent/sessions'), { recursive: true });
    writeFileSync(
        join(target, 'agent/sessions/ci-marker'),
        'preserve local sessions',
    );
    const next = join(work, 'bundle-two');
    cpSync(bundle, next, { recursive: true, verbatimSymlinks: true });
    writeFileSync(
        join(next, 'setup/agent/prompts/qualification-version.md'),
        'Synthetic update marker',
    );
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
    });
    assert(existsSync(join(target, 'agent/prompts/qualification-version.md')));
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
    passed('real update, idempotency, rollback and post-rollback integrity');
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
