import { test, expect } from 'bun:test';
import {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    rmSync,
    symlinkSync,
    readFileSync,
    chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
    allowedCodePath,
    releaseTag,
    packDistribution,
    validateBundle,
    publishDistribution,
    downloadDistribution,
} from './distribution.ts';
import { run, writeJson, digest, archive } from './files.ts';
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

test('pack, publish and download preserve a private profile and verify release assets', () => {
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
        run('git', ['init', '--quiet'], root);
        run('git', ['add', 'bin'], root);
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
            packages: [],
            defaultProvider: 'fixture',
            defaultModel: 'fixture-model',
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
        const script = join(home, 'pack.ts');
        write(
            script,
            `const {packDistribution}=await import(${JSON.stringify(resolve(import.meta.dir, 'distribution.ts'))}); await packDistribution(process.argv[2], process.argv[3]);`,
        );
        const output = join(home, 'output');
        run(process.execPath, [script, root, output], root, {
            ...process.env,
            HOME: home,
            PI_CODING_AGENT_DIR: join(root, 'agent'),
        });
        archive('extract', join(output, 'setup.tgz'), join(home, 'unpacked'));
        const manifest = validateBundle(join(home, 'unpacked'));
        expect(manifest.packages).toEqual([]);
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
            readFileSync(
                join(
                    home,
                    'unpacked/setup/agent/portable-skills/example/SKILL.md',
                ),
                'utf8',
            ),
        ).toContain('deterministic');
        // GitHub is the external boundary; archive admission and extraction stay real.
        const fakeTools = join(home, 'tools');
        mkdirSync(fakeTools);
        write(
            join(fakeTools, 'gh'),
            `#!${process.execPath}
import { appendFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.GH_FIXTURE_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'repo') console.log(process.env.GH_FIXTURE_PUBLIC ? 'false' : 'true');
else if (args[0] === 'api') console.log('{"enabled":true}');
else if (args[1] === 'verify-asset' && process.env.GH_FIXTURE_BAD_ASSET) process.exit(9);
else if (args[1] === 'download') {
 const destination = args[args.indexOf('--dir') + 1];
 for (const name of ['setup.tgz', 'release.json']) copyFileSync(join(process.env.GH_FIXTURE_SOURCE, name), join(destination, name));
}
else if (!['create', 'edit', 'verify', 'verify-asset'].includes(args[1])) process.exit(8);
`,
        );
        const originalEnv = { ...process.env };
        try {
            process.env.PATH = `${fakeTools}:${process.env.PATH}`;
            process.env.GH_FIXTURE_LOG = join(home, 'github.jsonl');
            process.env.GH_FIXTURE_SOURCE = output;
            publishDistribution(output, 'fixture-release');
            const downloaded = downloadDistribution(
                'fixture-release',
                join(home, 'download'),
            );
            expect(validateBundle(downloaded)).toEqual(manifest);
            const calls = readFileSync(process.env.GH_FIXTURE_LOG, 'utf8')
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as string[]);
            const created = calls.findIndex((args) => args[1] === 'create');
            const published = calls.findIndex((args) => args[1] === 'edit');
            expect(calls[created]).toContain('--draft');
            expect(published).toBeGreaterThan(created);
            expect(
                calls.filter((args) => args[1] === 'verify-asset'),
            ).toHaveLength(2);
            process.env.GH_FIXTURE_BAD_ASSET = '1';
            expect(() =>
                downloadDistribution(
                    'fixture-release',
                    join(home, 'bad-asset'),
                ),
            ).toThrow('Command failed');
            expect(() =>
                readFileSync(join(home, 'bad-asset/bundle/manifest.json')),
            ).toThrow();
            process.env.GH_FIXTURE_PUBLIC = '1';
            expect(() => publishDistribution(output, 'public-refused')).toThrow(
                'must be private',
            );
        } finally {
            process.env = originalEnv;
        }
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
}, 20000);
test('pack refuses uncommitted setup code before collecting personal state', async () => {
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
            'Uncommitted setup code',
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
