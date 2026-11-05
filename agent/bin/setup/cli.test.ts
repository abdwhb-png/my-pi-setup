import { test, expect } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { join } from 'node:path';

test('cleanup previews an empty installation without changing it', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-cleanup-cli-'));
    try {
        const result = spawnSync(
            process.execPath,
            [
                resolve(import.meta.dir, '../../../bin/pi-setup'),
                'cleanup',
                '--root',
                root,
                '--dry-run',
            ],
            { encoding: 'utf8' },
        );
        expect(result.status).toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report.dryRun).toBe(true);
        expect(report.entries).toEqual([]);
    } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(`${root}.runtime.lock`, { force: true });
    }
});

test('the public setup launcher documents all operations and rejects incomplete mutation commands', () => {
    const entry = resolve(import.meta.dir, '../../../bin/pi-setup');
    const help = spawnSync(process.execPath, [entry, '--help'], {
        encoding: 'utf8',
    });
    expect(help.status).toBe(0);
    for (const operation of [
        'pack',
        'publish',
        'install|update',
        'rollback',
        'recover',
        'memory export',
        'memory import',
    ])
        expect(help.stdout).toContain(operation);
    for (const args of [
        ['publish'],
        ['install'],
        ['pack'],
        ['memory', 'erase'],
        ['rollback', '--force'],
    ]) {
        const result = spawnSync(process.execPath, [entry, ...args], {
            encoding: 'utf8',
        });
        expect(result.status).toBe(2);
    }
});

test('each command has contextual help and identifies invalid flags before running dependencies', () => {
    const entry = resolve(import.meta.dir, '../../../bin/pi-setup');
    for (const command of [
        'pack',
        'publish',
        'install',
        'update',
        'check',
        'cleanup',
        'rollback',
        'recover',
        'memory export',
        'memory import',
    ]) {
        const result = spawnSync(
            process.execPath,
            [entry, ...command.split(' '), '--help'],
            { encoding: 'utf8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(`pi-setup ${command}`);
        expect(result.stdout).toContain('Examples:');
        expect(result.stderr).toBe('');
    }
    for (const [args, diagnostic] of [
        [['install', '--wat'], 'Unknown option --wat'],
        [['install', '--release'], 'Missing value for --release'],
        [
            ['install', '--release', 'one', '--release', 'two'],
            'Duplicate option --release',
        ],
        [
            ['install', '--release', 'one', '--details'],
            '--details requires --dry-run',
        ],
    ] as const) {
        const result = spawnSync(process.execPath, [entry, ...args], {
            encoding: 'utf8',
        });
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(diagnostic);
    }
});

test('missing installations and absent recovery operations produce actionable outcomes', () => {
    const home = mkdtempSync(join(tmpdir(), 'pi-setup-missing-'));
    const root = join(home, 'missing');
    const entry = resolve(import.meta.dir, '../../../bin/pi-setup');
    try {
        const check = spawnSync(
            process.execPath,
            [entry, 'check', '--root', root],
            { encoding: 'utf8' },
        );
        expect(check.status).toBe(1);
        expect(check.stderr).toContain('No managed Pi installation');
        expect(check.stderr).not.toContain('ENOENT');
        const recovery = spawnSync(
            process.execPath,
            [entry, 'recover', '--root', root],
            { encoding: 'utf8' },
        );
        expect(recovery.status).toBe(0);
        expect(recovery.stdout).toContain('No interrupted setup operation');
        expect(existsSync(root)).toBe(false);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('install reports verification while a subprocess is blocked and keeps progress out of stdout', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pi-setup-progress-'));
    const tools = join(home, 'tools');
    const marker = join(home, 'started');
    const gate = join(home, 'continue');
    const fixtureRuntime = join(home, 'runtime with spaces');
    const ghScript = join(tools, 'gh.ts');
    mkdirSync(tools);
    symlinkSync(process.execPath, fixtureRuntime);
    for (const command of ['git', 'python3', 'bun', 'node', 'sfw'])
        writeFileSync(
            join(tools, command),
            '#!/bin/sh\necho "Fixture version"\n',
            { mode: 0o700 },
        );
    writeFileSync(
        join(tools, 'gh'),
        '#!/bin/sh\nexec "$PI_SETUP_FIXTURE_BUN" "$PI_SETUP_FIXTURE_GH" "$@"\n',
        { mode: 0o700 },
    );
    writeFileSync(
        ghScript,
        `import { writeFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('Fixture gh');
else if (args[0] === 'repo') console.log('true');
else {
  writeFileSync(process.env.FIXTURE_STARTED, 'started');
  const deadline = Date.now() + 5000;
  while (!existsSync(process.env.FIXTURE_GATE) && Date.now() < deadline) await Bun.sleep(10);
  console.error('Intentional fixture failure: Bearer fixture-secret-value');
  process.exit(7);
}
`,
        { mode: 0o600 },
    );
    const child = spawn(
        process.execPath,
        [
            resolve(import.meta.dir, '../../../bin/pi-setup'),
            'install',
            '--release',
            'fixture',
            '--root',
            join(home, 'target'),
        ],
        {
            env: {
                ...process.env,
                PATH: tools,
                FIXTURE_STARTED: marker,
                FIXTURE_GATE: gate,
                PI_SETUP_FIXTURE_BUN: fixtureRuntime,
                PI_SETUP_FIXTURE_GH: ghScript,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );
    let stdout = '',
        stderr = '';
    child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
    });
    const exited = new Promise<number | null>((done) =>
        child.on('close', done),
    );
    try {
        const deadline = Date.now() + 3000;
        while (!existsSync(marker) && Date.now() < deadline)
            await Bun.sleep(10);
        expect(existsSync(marker), stderr).toBe(true);
        expect(child.exitCode).toBeNull();
        expect(stderr).toMatch(/Verifying .*release/i);
        expect(stdout).toBe('');
        writeFileSync(gate, 'continue');
        expect(await exited).toBe(1);
        expect(stderr).toContain('Intentional fixture failure');
        expect(stderr).not.toContain('fixture-secret-value');
        expect(stdout).not.toContain('Installed');
        expect(existsSync(join(home, 'target'))).toBe(false);
    } finally {
        writeFileSync(gate, 'continue');
        await exited;
        rmSync(home, { recursive: true, force: true });
    }
}, 10_000);

test('bootstrap help loads without installed Pi packages or node_modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-bootstrap-'));
    try {
        mkdirSync(join(root, 'bin'));
        mkdirSync(join(root, 'agent/extensions/_shared'), { recursive: true });
        cpSync(
            resolve(import.meta.dir, '../../../bin/pi-setup'),
            join(root, 'bin/pi-setup'),
        );
        cpSync(resolve(import.meta.dir, '..'), join(root, 'agent/bin'), {
            recursive: true,
        });
        cpSync(
            resolve(
                import.meta.dir,
                '../../extensions/_shared/config-owners.mts',
            ),
            join(root, 'agent/extensions/_shared/config-owners.mts'),
        );
        cpSync(
            resolve(
                import.meta.dir,
                '../../extensions/_shared/secret-redaction.ts',
            ),
            join(root, 'agent/extensions/_shared/secret-redaction.ts'),
        );
        cpSync(
            resolve(
                import.meta.dir,
                '../../extensions/_shared/runtime-storage.ts',
            ),
            join(root, 'agent/extensions/_shared/runtime-storage.ts'),
        );
        cpSync(
            resolve(import.meta.dir, '../../extensions/_shared/json-object.ts'),
            join(root, 'agent/extensions/_shared/json-object.ts'),
        );
        cpSync(
            resolve(import.meta.dir, '../../extensions/_shared/home-path.ts'),
            join(root, 'agent/extensions/_shared/home-path.ts'),
        );
        for (const path of [
            'ai-providers/schema.ts',
            'ai-providers/rules/model-rules.ts',
        ]) {
            const destination = join(root, 'agent/extensions', path);
            mkdirSync(join(destination, '..'), { recursive: true });
            cpSync(
                resolve(import.meta.dir, '../../extensions', path),
                destination,
            );
        }
        const result = spawnSync(
            process.execPath,
            [join(root, 'bin/pi-setup'), '--help'],
            {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    HOME: root,
                    PI_CODING_AGENT_DIR: join(root, 'agent'),
                },
            },
        );
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('memory import');
        cpSync(
            resolve(import.meta.dir, '../../../bin/pi-fork'),
            join(root, 'bin/pi-fork'),
        );
        writeFileSync(
            `${root}.setup-journal.json`,
            JSON.stringify({ id: 'fixture', phase: 'preparing' }),
        );
        try {
            const fork = spawnSync(
                process.execPath,
                [join(root, 'bin/pi-fork'), 'status'],
                {
                    encoding: 'utf8',
                    env: { ...process.env, PI_SETUP_TRANSACTION_ID: undefined },
                },
            );
            expect(fork.status).toBe(1);
            expect(fork.stderr).toContain('setup transaction');
        } finally {
            rmSync(`${root}.setup-journal.json`, { force: true });
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
