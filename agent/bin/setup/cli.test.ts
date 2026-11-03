import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { join } from 'node:path';

test('cleanup previews an empty installation without changing it', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-cleanup-cli-'));
    try {
        const result = spawnSync(process.execPath, [
            resolve(import.meta.dir, '../../../bin/pi-setup'),
            'cleanup', '--root', root, '--dry-run',
        ], { encoding: 'utf8' });
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
        expect(result.status).toBe(1);
    }
});

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
        cpSync(resolve(import.meta.dir, '../../extensions/_shared/runtime-storage.ts'),
            join(root, 'agent/extensions/_shared/runtime-storage.ts'));
        cpSync(resolve(import.meta.dir, '../../extensions/_shared/json-object.ts'),
            join(root, 'agent/extensions/_shared/json-object.ts'));
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
