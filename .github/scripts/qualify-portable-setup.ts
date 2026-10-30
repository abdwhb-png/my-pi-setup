import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import {
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
    packDistribution,
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
        platform: process.env.QUALIFICATION_PLATFORM,
        kernel: run('uname', ['-r']),
        milestones,
    });
}

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
        [join(source, 'bin/pi'), 'install', packageSource],
        join(source, 'agent'),
    );
}
delete process.env.PI_PACKAGE_FINALIZER_ACTIVE;
run(process.execPath, [join(source, 'bin/pi'), 'list'], source);
await stageRuntimeRelease({
    candidateRoot: zero,
    runtimeBase: join(source, 'runtimes'),
    managedBinary: join(source, 'bin/zerobox'),
    provenanceSource: join(zero, 'provenance.json'),
    expectedBinarySha256: String(
        json(join(zero, 'provenance.json')).binarySha256,
    ),
});
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

run(
    process.execPath,
    [
        'test',
        '--isolate',
        'bin/setup',
        'bin/pi-fork-cli.test.ts',
        'bin/pi-fork-release.test.ts',
        'bin/pi-runtime-store.test.ts',
        'bin/pi-wrapper-lib.test.ts',
        'extensions/_shared/redaction.test.ts',
    ],
    join(source, 'agent'),
);
passed('operator and launcher regression suites');

await packDistribution(source, join(work, 'release-one'));
archive(
    'extract',
    join(work, 'release-one/setup.tgz'),
    join(work, 'bundle-one'),
);
const bundle = join(work, 'bundle-one');
const manifest = validateBundle(bundle);
assert(
    !Object.keys(manifest.files).some((path) =>
        /auth\.json|sessions\/|pi-hermes-memory\//.test(path),
    ),
);
passed('pack and extract a synthetic profile with real validated runtimes');

const home = join(work, 'destination-home');
mkdirSync(home);
process.env.HOME = home;
const target = join(home, '.pi');
process.env.PI_CODING_AGENT_DIR = join(target, 'agent');
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
const bindings = join(work, 'bindings.json');
writeJson(bindings, {
    environment: {
        installations: {
            'pnpm-corepack': [
                ...binding('node'),
                { root: dirname(dirname(hostBinary('pnpm'))), path: ['dist'] },
            ],
            bun: binding('bun'),
            go: [{ root: dirname(dirname(hostBinary('go'))), path: ['bin'] }],
            python: binding('python3'),
            php: [...binding('php'), ...binding('composer')],
        },
    },
});
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

run(
    process.execPath,
    [
        'test',
        '--isolate',
        'extensions/sandbox/runtime/installed-runtime.integration.test.ts',
    ],
    join(target, 'agent'),
    { ...process.env, PI_SANDBOX_INSTALLED_CONTRACT: '1' },
);
passed('real bash and safe_bash through the installed native sandbox');

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
    !readFileSync(memoryArchive, 'utf8').includes('CI excluded source session'),
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
const db = new Database(join(target, 'agent/pi-hermes-memory/sessions.db'), {
    readonly: true,
});
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

writeJson(join(target, 'agent/auth.json'), {});
mkdirSync(join(target, 'agent/sessions'), { recursive: true });
writeFileSync(
    join(target, 'agent/sessions/ci-marker'),
    'preserve local sessions',
);
const next = join(work, 'bundle-two');
cpSync(bundle, next, { recursive: true });
writeFileSync(
    join(next, 'setup/agent/prompts/qualification-version.md'),
    'Synthetic update marker',
);
rmSync(join(next, 'manifest.json'));
writeJson(join(next, 'manifest.json'), { ...manifest, files: inventory(next) });
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
assert(
    readFileSync(
        join(target, 'agent/pi-hermes-memory/MEMORY.md'),
        'utf8',
    ).includes('survives'),
);
run(process.execPath, [join(target, 'bin/pi-setup'), 'check'], home);
passed('real update, idempotency, rollback and post-rollback integrity');
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
passed('modified managed files refuse updates');
writeJson(join(evidence, 'qualification.json'), {
    status: 'passed',
    sourceCommit: process.env.QUALIFICATION_SOURCE_SHA,
    platform: process.env.QUALIFICATION_PLATFORM,
    kernel: run('uname', ['-r']),
    bundleSha256: digest(readFileSync(join(work, 'release-one/setup.tgz'))),
    packages: manifest.packages,
    milestones,
    exclusions: [
        'personal profile',
        'private GitHub publication and download',
        'provider connectivity',
    ],
});
