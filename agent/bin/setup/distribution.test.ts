import { test, expect, spyOn } from 'bun:test';
import {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    rmSync,
    symlinkSync,
    readFileSync,
    chmodSync,
    existsSync,
    cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireRuntimeStorageLock } from '../../extensions/_shared/runtime-storage.ts';
import {
    allowedCodePath,
    releaseTag,
    packDistribution,
    validateBundle,
    publishDistribution,
    downloadDistribution,
    resolveMainCommit,
} from './distribution.ts';
import * as distribution from './distribution.ts';
import { run, writeJson, digest, archive, inventory } from './files.ts';
test('packing cannot race runtime garbage collection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-pack-lock-'));
    const lock = acquireRuntimeStorageLock(root);
    try {
        await expect(
            packDistribution(root, join(root, 'output'), 'a'.repeat(40)),
        ).rejects.toThrow('Runtime storage is busy');
    } finally {
        lock.release();
        rmSync(root, { recursive: true, force: true });
        rmSync(`${root}.runtime.lock`, { force: true });
    }
});
test('distribution code selection excludes credentials and runtime user state', () => {
    for (const path of [
        'agent/auth.json',
        'agent/.env',
        'agent/sessions/a.jsonl',
        'agent/config/ai-providers.secrets.json',
        'bin/zerobox',
        '.aws/config',
    ])
        expect(allowedCodePath(path)).toBe(false);
    for (const path of [
        'bin/pi-setup',
        'agent/extensions/foo/index.ts',
        'agent/agents/worker.md',
        'agent/config/tool-summary.example.json',
    ])
        expect(allowedCodePath(path)).toBe(true);
    expect(() => releaseTag('--latest')).toThrow('Invalid release tag');
});

test('pack snapshots main and publish requests qualification without finalizing the draft', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pi-setup-distribution-'));
    const root = join(home, '.pi');
    try {
        mkdirSync(root);
        const write = (path: string, content: string) => {
            mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
            writeFileSync(path, content, { mode: 0o700 });
        };
        write(join(root, 'bin/pi'), '#!/bin/sh\n');
        write(join(root, 'bin/pi-setup'), '#!/bin/sh\n');
        write(
            join(root, 'agent/skills/bundled/SKILL.md'),
            '# Bundled skill\nRepository resource.',
        );
        writeJson(join(root, 'agent/extensions/tool-groups/package.json'), {
            name: 'fixture-tool-groups',
            version: '1.0.0',
            pi: { extensions: ['./index.ts'] },
        });
        write(
            join(root, 'agent/extensions/tool-groups/index.ts'),
            'export default function () {}',
        );
        write(
            join(root, 'agent/extensions/space é.ts'),
            'export const approved = true;',
        );
        run('git', ['init', '--quiet'], root);
        run('git', ['add', 'bin', 'agent/extensions', 'agent/skills'], root);
        run(
            'git',
            [
                '-c',
                'user.name=Fixture',
                '-c',
                'user.email=fixture@example.invalid',
                'commit',
                '-qm',
                'fixture',
            ],
            root,
        );
        writeJson(join(root, 'agent/settings.json'), {
            packages: ['extensions/tool-groups'],
            defaultProvider: 'fixture',
            defaultModel: 'fixture-model',
            skills: [
                '!agent-browser',
                '~/.agents/skills',
                '~/.pi/agent/portable-skills',
            ],
        });
        writeJson(join(root, 'agent/auth.json'), {
            credential: 'EXCLUDED_FIXTURE_CREDENTIAL',
        });
        write(
            join(home, '.agents/skills/example/SKILL.md'),
            '# Example skill\nUse deterministic checks.',
        );
        chmodSync(join(home, '.agents/skills/example/SKILL.md'), 0o664);
        const runtime = join(root, 'runtime/pi-core/releases/fixture');
        write(join(runtime, 'package/pi'), '#!/bin/sh\n');
        writeJson(join(runtime, 'package/package.json'), {
            name: '@earendil-works/pi-coding-agent',
        });
        const packages = [
            {
                name: '@earendil-works/pi-coding-agent',
                version: '1.0.0',
                tarball: 'tarballs/pi.tgz',
                sha256: digest('fixture archive'),
            },
        ];
        const source = {
            repository: 'fixture',
            commit: 'b'.repeat(40),
            dirty: false,
        };
        write(join(runtime, 'packed/tarballs/pi.tgz'), 'fixture archive');
        writeJson(join(runtime, 'packed/release-manifest.json'), {
            schemaVersion: 1,
            source,
            packages,
        });
        writeJson(join(runtime, 'runtime-manifest.json'), {
            schemaVersion: 1,
            releaseId: 'fixture',
            createdAt: '2026-01-01T00:00:00Z',
            source,
            packages,
            executable: 'package/pi',
            packageRoot: 'package',
        });
        symlinkSync('releases/fixture', join(root, 'runtime/pi-core/current'));
        const zero = join(root, 'runtimes/zerobox/fixture');
        for (const [name, text] of Object.entries({
            'bin/zerobox': 'engine',
            'helper/zerobox-linux-sandbox': 'helper',
            'components/shell/bin/bash': 'bash',
            'components/shell/bin/env': 'env',
            'components/analysis/bin/node': 'node',
        }))
            write(join(zero, name), text);
        const zeroManifest = {
            schema: 1,
            target: 'x86_64-unknown-linux-gnu',
            version: 'fixture',
            helper: {
                path: 'helper/zerobox-linux-sandbox',
                sha256: digest('helper'),
            },
            components: {
                shell: {
                    root: 'components/shell',
                    files: [
                        { path: 'bin/bash', sha256: digest('bash') },
                        { path: 'bin/env', sha256: digest('env') },
                    ],
                },
                analysis: {
                    root: 'components/analysis',
                    files: [{ path: 'bin/node', sha256: digest('node') }],
                },
            },
        };
        writeJson(join(zero, 'manifest.json'), zeroManifest);
        writeJson(join(zero, 'provenance.json'), {
            version: 'fixture',
            sourceCommit: 'b'.repeat(40),
            binarySha256: digest('engine'),
            runtimeManifestSha256: digest(
                readFileSync(join(zero, 'manifest.json')),
            ),
            helperSha256: digest('helper'),
        });
        symlinkSync(
            '../runtimes/zerobox/fixture/bin/zerobox',
            join(root, 'bin/zerobox'),
        );
        writeJson(join(root, 'agent/package.json'), {
            dependencies: {
                '@earendil-works/pi-coding-agent':
                    'file:../runtime/pi-core/releases/fixture/packed/tarballs/pi.tgz',
            },
        });
        write(
            join(root, '.github/workflows/private-runtime-validation.yml'),
            `jobs:\n  native:\n    steps:\n      - with:\n          repository: abdwhb-png/zerobox\n          ref: ${'b'.repeat(40)}\n`,
        );
        run(
            'git',
            ['add', 'bin/zerobox', 'agent/package.json', '.github'],
            root,
        );
        run(
            'git',
            [
                '-c',
                'user.name=Fixture',
                '-c',
                'user.email=fixture@example.invalid',
                'commit',
                '-qm',
                'Pin fixture runtimes',
            ],
            root,
        );
        const mainCommit = run('git', ['rev-parse', 'HEAD'], root);
        run(
            'git',
            ['update-ref', 'refs/remotes/origin/main', mainCommit],
            root,
        );
        run('git', ['switch', '-qc', 'develop'], root);
        write(join(root, 'bin/pi'), 'development version');
        run('git', ['add', 'bin/pi'], root);
        run(
            'git',
            [
                '-c',
                'user.name=Fixture',
                '-c',
                'user.email=fixture@example.invalid',
                'commit',
                '-qm',
                'Development edit',
            ],
            root,
        );
        write(join(root, 'bin/pi'), 'uncommitted version');
        write(join(root, 'agent/extensions/work-in-progress.ts'), 'unfinished');
        const script = join(home, 'pack.ts');
        write(
            script,
            `process.umask(0o077); const {packDistribution}=await import(${JSON.stringify(resolve(import.meta.dir, 'distribution.ts'))}); await packDistribution(process.argv[2], process.argv[3], undefined, {includeGlobalSkills:process.argv[4]==='include-global-skills'});`,
        );
        const output = join(home, 'output');
        chmodSync(join(runtime, 'packed/tarballs'), 0o555);
        run(process.execPath, [script, root, output], root, {
            ...process.env,
            HOME: home,
            PI_CODING_AGENT_DIR: join(root, 'agent'),
        });
        archive('extract', join(output, 'setup.tgz'), join(home, 'unpacked'));
        const manifest = validateBundle(join(home, 'unpacked'));
        expect(manifest.sourceCommit).toBe(mainCommit);
        expect(manifest.files['setup/bin/pi']?.split(':')[0]).toBe(
            String(0o755),
        );
        expect(manifest.files['setup/agent/package.json']?.split(':')[0]).toBe(
            String(0o644),
        );
        expect(
            readFileSync(
                join(home, 'unpacked/setup/agent/extensions/space é.ts'),
                'utf8',
            ),
        ).toBe('export const approved = true;');
        expect(readFileSync(join(home, 'unpacked/setup/bin/pi'), 'utf8')).toBe(
            '#!/bin/sh\n',
        );
        expect(Object.keys(manifest.files)).not.toContain(
            'setup/agent/extensions/work-in-progress.ts',
        );
        const altered = join(home, 'altered-runtime');
        cpSync(join(home, 'unpacked'), altered, { recursive: true });
        const provenance = JSON.parse(
            readFileSync(join(altered, 'zerobox/provenance.json'), 'utf8'),
        );
        writeJson(join(altered, 'zerobox/provenance.json'), {
            ...provenance,
            sourceCommit: 'f'.repeat(40),
        });
        const alteredFiles = inventory(altered);
        delete alteredFiles['manifest.json'];
        writeJson(join(altered, 'manifest.json'), {
            ...manifest,
            files: alteredFiles,
        });
        await expect(
            Promise.resolve().then(() =>
                distribution.validateReleaseSource(root, altered, mainCommit),
            ),
        ).rejects.toThrow('Zerobox engine');
        expect(manifest.packages).toEqual(['./extensions/tool-groups']);
        expect(Object.keys(manifest.files)).not.toContain(
            'setup/agent/auth.json',
        );
        expect(
            readFileSync(
                join(home, 'unpacked/setup/agent/settings.json'),
                'utf8',
            ),
        ).toContain('fixture-model');
        expect(
            existsSync(join(home, 'unpacked/setup/agent/portable-skills')),
        ).toBe(false);
        expect(
            JSON.parse(
                readFileSync(
                    join(home, 'unpacked/setup/agent/settings.json'),
                    'utf8',
                ),
            ).skills,
        ).toEqual(['!agent-browser']);
        expect(
            readFileSync(
                join(home, 'unpacked/setup/agent/skills/bundled/SKILL.md'),
                'utf8',
            ),
        ).toContain('Repository resource');
        const withSkills = join(home, 'with-skills');
        run(
            process.execPath,
            [script, root, withSkills, 'include-global-skills'],
            root,
            {
                ...process.env,
                HOME: home,
                PI_CODING_AGENT_DIR: join(root, 'agent'),
            },
        );
        archive(
            'extract',
            join(withSkills, 'setup.tgz'),
            join(home, 'with-skills-unpacked'),
        );
        expect(
            readFileSync(
                join(
                    home,
                    'with-skills-unpacked/setup/agent/portable-skills/example/SKILL.md',
                ),
                'utf8',
            ),
        ).toContain('deterministic');
        expect(
            JSON.parse(
                readFileSync(
                    join(
                        home,
                        'with-skills-unpacked/setup/agent/settings.json',
                    ),
                    'utf8',
                ),
            ).skills,
        ).toEqual(['!agent-browser', '~/.pi/agent/portable-skills']);
        // GitHub is the external boundary; archive admission and extraction stay real.
        const fakeTools = join(home, 'tools');
        mkdirSync(fakeTools);
        write(
            join(fakeTools, 'gh'),
            `#!/usr/bin/env bun
import { appendFileSync, copyFileSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.GH_FIXTURE_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'repo') console.log(process.env.GH_FIXTURE_PUBLIC ? 'false' : 'true');
else if (args[0] === 'api' && args[1].endsWith('/assets')) console.log(JSON.stringify(['setup.tgz','release.json'].map((name,index)=>({id: index+1+(process.env.GH_FIXTURE_REPLACED_ASSET ? 10 : 0),name,size:statSync(join(process.env.GH_FIXTURE_SOURCE,name)).size}))));
else if (args[0] === 'api') console.log('{"enabled":true}');
else if (args[0] === 'workflow') {}
else if (args[1] === 'view') console.log(JSON.stringify({databaseId:42,isDraft:!existsSync(process.env.GH_FIXTURE_STATE),tagName:args[2]}));
else if (args[1] === 'edit') writeFileSync(process.env.GH_FIXTURE_STATE,'published');
else if (args[1] === 'verify' && process.env.GH_FIXTURE_DELAY_ATTESTATION && readFileSync(process.env.GH_FIXTURE_LOG, 'utf8').trim().split('\\n').filter(line => JSON.parse(line)[1] === 'verify').length === 1) {
 console.error('no attestations for tag ' + args[2]); process.exit(1);
}
else if (args[1] === 'verify' && process.env.GH_FIXTURE_MISSING_ATTESTATION) {
 console.error('no attestations for tag ' + args[2]); process.exit(1);
}
else if (args[1] === 'verify' && process.env.GH_FIXTURE_INVALID_ATTESTATION) {
 console.error('failed to verify attestations: invalid signature'); process.exit(1);
}
else if (args[1] === 'verify-asset' && process.env.GH_FIXTURE_BAD_ASSET) process.exit(9);
else if (args[1] === 'download') {
 const destination = args[args.indexOf('--dir') + 1];
 for (const name of ['setup.tgz', 'release.json']) copyFileSync(join(process.env.GH_FIXTURE_SOURCE, name), join(destination, name));
}
else if (!['create', 'edit', 'verify', 'verify-asset'].includes(args[1])) process.exit(8);
`,
        );
        const originalEnv = { ...process.env };
        const sleep = spyOn(Bun, 'sleepSync').mockImplementation(() => {});
        try {
            process.env.PATH = `${fakeTools}:${process.env.PATH}`;
            process.env.GH_FIXTURE_LOG = join(home, 'github.jsonl');
            process.env.GH_FIXTURE_SOURCE = output;
            process.env.GH_FIXTURE_STATE = join(home, 'published');
            process.env.GITHUB_ACTIONS = 'true';
            process.env.GITHUB_REPOSITORY = 'abdwhb-png/my-pi-distribution';
            process.env.GITHUB_ACTOR = 'abdwhb-png';
            await publishDistribution(output, 'fixture-release', root);
            const requestedCalls = readFileSync(
                process.env.GH_FIXTURE_LOG,
                'utf8',
            )
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as string[]);
            expect(
                requestedCalls.some(
                    (args) => args[0] === 'workflow' && args[1] === 'run',
                ),
            ).toBe(true);
            expect(
                requestedCalls.some(
                    (args) => args[0] === 'release' && args[1] === 'edit',
                ),
            ).toBe(false);
            const candidateDirectory = join(home, 'candidate');
            const descriptor = JSON.parse(
                readFileSync(join(output, 'release.json'), 'utf8'),
            );
            const candidateBundle =
                await distribution.downloadDraftDistribution({
                    tag: 'fixture-release',
                    directory: candidateDirectory,
                    sourceRoot: root,
                    sourceCommit: mainCommit,
                    archiveSha256: descriptor.sha256,
                });
            expect(validateBundle(candidateBundle).sourceCommit).toBe(
                mainCommit,
            );
            expect(
                JSON.parse(
                    readFileSync(
                        join(candidateDirectory, 'candidate.json'),
                        'utf8',
                    ),
                ).archiveSha256,
            ).toBe(descriptor.sha256);
            expect(
                readFileSync(process.env.GH_FIXTURE_LOG, 'utf8')
                    .split('\n')
                    .filter(Boolean)
                    .map((line) => JSON.parse(line) as string[])
                    .some((args) => args[1] === 'verify'),
            ).toBe(false);
            const evidenceDirectory = join(home, 'evidence');
            const qualification = {
                status: 'passed',
                scope: 'full',
                sourceCommit: mainCommit,
                bundleSourceCommit: mainCommit,
                bundleSha256: descriptor.sha256,
            };
            const profile = {
                status: 'passed',
                sourceCommit: mainCommit,
                bundleSha256: descriptor.sha256,
            };
            writeJson(
                join(evidenceDirectory, 'qualification.json'),
                qualification,
            );
            writeJson(join(evidenceDirectory, 'profile.json'), {
                ...profile,
                status: 'failed',
            });
            const finalize = () =>
                distribution.finalizeDistribution({
                    sourceRoot: root,
                    directory: candidateDirectory,
                    evidenceDirectory,
                });
            await expect(finalize()).rejects.toThrow('profile');
            writeJson(join(evidenceDirectory, 'profile.json'), profile);
            writeJson(join(evidenceDirectory, 'qualification.json'), {
                ...qualification,
                scope: 'profile-installation',
            });
            await expect(finalize()).rejects.toThrow('full');
            writeJson(
                join(evidenceDirectory, 'qualification.json'),
                qualification,
            );
            writeJson(join(evidenceDirectory, 'profile.json'), {
                ...profile,
                bundleSha256: 'f'.repeat(64),
            });
            await expect(finalize()).rejects.toThrow('profile');
            writeJson(join(evidenceDirectory, 'profile.json'), profile);
            const originalArchive = readFileSync(
                join(candidateDirectory, 'setup.tgz'),
            );
            writeFileSync(join(candidateDirectory, 'setup.tgz'), 'altered');
            await expect(finalize()).rejects.toThrow('changed');
            writeFileSync(
                join(candidateDirectory, 'setup.tgz'),
                originalArchive,
            );
            process.env.GH_FIXTURE_REPLACED_ASSET = '1';
            await expect(finalize()).rejects.toThrow('changed');
            delete process.env.GH_FIXTURE_REPLACED_ASSET;
            expect(
                readFileSync(process.env.GH_FIXTURE_LOG, 'utf8')
                    .split('\n')
                    .filter(Boolean)
                    .map((line) => JSON.parse(line) as string[])
                    .some((args) => args[1] === 'edit'),
            ).toBe(false);
            process.env.GH_FIXTURE_DELAY_ATTESTATION = '1';
            await finalize();
            expect(sleep).toHaveBeenCalledTimes(1);
            delete process.env.GH_FIXTURE_DELAY_ATTESTATION;
            const downloaded = await downloadDistribution(
                'fixture-release',
                join(home, 'download'),
            );
            expect(validateBundle(downloaded)).toEqual(manifest);
            const calls = readFileSync(process.env.GH_FIXTURE_LOG, 'utf8')
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as string[]);
            const created = calls.findIndex((args) => args[1] === 'create');
            expect(calls[created]).toContain('--draft');
            expect(
                calls.filter((args) => args[1] === 'verify-asset'),
            ).toHaveLength(4);
            process.env.GH_FIXTURE_BAD_ASSET = '1';
            await expect(
                downloadDistribution(
                    'fixture-release',
                    join(home, 'bad-asset'),
                ),
            ).rejects.toThrow('Command failed');
            expect(() =>
                readFileSync(join(home, 'bad-asset/bundle/manifest.json')),
            ).toThrow();
            process.env.GH_FIXTURE_INVALID_ATTESTATION = '1';
            await expect(
                downloadDistribution(
                    'invalid-signature',
                    join(home, 'invalid-signature'),
                ),
            ).rejects.toThrow('invalid signature');
            expect(sleep).toHaveBeenCalledTimes(1);
            delete process.env.GH_FIXTURE_INVALID_ATTESTATION;
            process.env.GH_FIXTURE_MISSING_ATTESTATION = '1';
            await expect(
                downloadDistribution(
                    'missing-attestation',
                    join(home, 'missing-attestation'),
                ),
            ).rejects.toThrow('no attestations for tag');
            expect(sleep).toHaveBeenCalledTimes(1);
            delete process.env.GH_FIXTURE_MISSING_ATTESTATION;
            process.env.GH_FIXTURE_PUBLIC = '1';
            await expect(
                downloadDistribution(
                    'public-refused',
                    join(home, 'public-refused'),
                ),
            ).rejects.toThrow('must be private');
        } finally {
            process.env = originalEnv;
            sleep.mockRestore();
        }
    } finally {
        const frozen = join(
            root,
            'runtime/pi-core/releases/fixture/packed/tarballs',
        );
        if (existsSync(frozen)) chmodSync(frozen, 0o700);
        rmSync(home, { recursive: true, force: true });
    }
}, 20000);
test('pack refuses a missing main reference before collecting personal state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-setup-pack-'));
    try {
        run('git', ['init', '--quiet'], root);
        mkdirSync(join(root, 'bin'));
        writeFileSync(join(root, 'bin/pi'), 'original');
        run('git', ['add', 'bin/pi'], root);
        run(
            'git',
            [
                '-c',
                'user.name=Fixture',
                '-c',
                'user.email=fixture@example.invalid',
                'commit',
                '-qm',
                'fixture',
            ],
            root,
        );
        writeFileSync(join(root, 'bin/pi'), 'changed');
        await expect(packDistribution(root, join(root, 'out'))).rejects.toThrow(
            'main',
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('bundle admission rejects mutable and external package sources before installation', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-setup-sources-'));
    try {
        for (const source of [
            'npm:example@latest',
            'npm:example@^1.0.0',
            'git:github.com/example/repo@main',
            '/outside/package',
            'https://example.invalid/package.tgz',
        ]) {
            writeJson(join(root, 'manifest.json'), {
                schemaVersion: 1,
                platform: 'linux-x64',
                sourceCommit: 'a'.repeat(40),
                packages: [source],
                files: {},
            });
            expect(() => validateBundle(root)).toThrow(
                'Unsupported or unpinned package source',
            );
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('release source accepts historical main commits and refuses development-only or abbreviated revisions', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-main-source-'));
    try {
        run('git', ['init', '-q'], root);
        writeFileSync(join(root, 'file'), 'approved');
        run('git', ['add', 'file'], root);
        run(
            'git',
            [
                '-c',
                'user.name=Fixture',
                '-c',
                'user.email=fixture@example.invalid',
                'commit',
                '-qm',
                'Approved',
            ],
            root,
        );
        const main = run('git', ['rev-parse', 'HEAD'], root);
        run('git', ['update-ref', 'refs/remotes/origin/main', main], root);
        writeFileSync(join(root, 'file'), 'development');
        run('git', ['add', 'file'], root);
        run(
            'git',
            [
                '-c',
                'user.name=Fixture',
                '-c',
                'user.email=fixture@example.invalid',
                'commit',
                '-qm',
                'Development',
            ],
            root,
        );
        expect(resolveMainCommit(root)).toBe(main);
        expect(resolveMainCommit(root, main)).toBe(main);
        expect(() =>
            resolveMainCommit(root, run('git', ['rev-parse', 'HEAD'], root)),
        ).toThrow('origin/main');
        expect(() => resolveMainCommit(root, main.slice(0, 8))).toThrow(
            'full commit',
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
