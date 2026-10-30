import { test, expect } from 'bun:test';
import {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    readFileSync,
    rmSync,
    existsSync,
    symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventory, writeJson } from './files.ts';
import {
    installBundle,
    rollbackInstallation,
    recoverInstallation,
} from './installation.ts';

function bundle(root: string, version: string) {
    const dir = join(root, `bundle-${version}`);
    mkdirSync(dir);
    for (const [path, text] of Object.entries({
        'setup/bin/pi': version,
        'setup/bin/pi-setup': 'launcher',
        'setup/agent/settings.json': '{}',
        'pi/release-manifest.json': '{}',
        'zerobox/manifest.json': '{}',
        'zerobox/provenance.json': '{}',
    })) {
        const file = join(dir, path);
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, text);
    }
    writeJson(join(dir, 'manifest.json'), {
        schemaVersion: 1,
        platform: 'linux-x64',
        sourceCommit: 'a'.repeat(40),
        files: inventory(dir),
        packages: [],
    });
    return dir;
}

test('installs, updates and restores the old setup when provisioning fails', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pi-setup-install-'));
    const root = join(home, '.pi');
    try {
        const first = bundle(home, 'one'),
            second = bundle(home, 'two');
        const provision = async (target: string) => {
            mkdirSync(join(target, 'runtime'));
            writeFileSync(
                join(target, 'runtime/version'),
                readFileSync(join(target, 'bin/pi')),
            );
        };
        await installBundle({ root, bundle: first, release: 'one', provision });
        writeFileSync(join(root, 'agent/auth.json'), '{"fixture":"preserve"}');
        await expect(
            installBundle({
                root,
                bundle: second,
                release: 'two',
                update: true,
                provision: async () => {
                    throw new Error('installation failed');
                },
            }),
        ).rejects.toThrow('installation failed');
        expect(readFileSync(join(root, 'bin/pi'), 'utf8')).toBe('one');
        expect(readFileSync(join(root, 'agent/auth.json'), 'utf8')).toContain(
            'preserve',
        );
        await installBundle({
            root,
            bundle: second,
            release: 'two',
            update: true,
            provision,
        });
        expect(readFileSync(join(root, 'runtime/version'), 'utf8')).toBe('two');
        expect(existsSync(`${root}.setup-journal.json`)).toBe(false);
        writeFileSync(
            join(root, 'agent/auth.json'),
            '{"fixture":"new credentials"}',
        );
        await rollbackInstallation(root);
        expect(readFileSync(join(root, 'bin/pi'), 'utf8')).toBe('one');
        expect(readFileSync(join(root, 'agent/auth.json'), 'utf8')).toContain(
            'new credentials',
        );
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('updates preserve local changes by refusing conflicts, and dry runs never install', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pi-setup-conflict-'));
    const root = join(home, '.pi');
    try {
        const first = bundle(home, 'one'),
            second = bundle(home, 'two');
        await installBundle({
            root,
            bundle: first,
            release: 'one',
            dryRun: true,
        });
        expect(existsSync(root)).toBe(false);
        await installBundle({
            root,
            bundle: first,
            release: 'one',
            provision: async () => {},
        });
        expect(
            await installBundle({
                root,
                bundle: first,
                release: 'one',
                update: true,
                provision: async () => {
                    throw new Error('must not run');
                },
            }),
        ).toBe('Already installed');
        writeFileSync(join(root, 'bin/pi'), 'personal change');
        await expect(
            installBundle({
                root,
                bundle: second,
                release: 'two',
                update: true,
                provision: async () => {},
            }),
        ).rejects.toThrow('Local change');
        expect(readFileSync(join(root, 'bin/pi'), 'utf8')).toBe(
            'personal change',
        );
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('interrupted activation recovery restores the previous directory', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pi-setup-recover-'));
    const root = join(home, '.pi');
    try {
        const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        mkdirSync(`${root}.setup-${id}/previous`, { recursive: true });
        writeFileSync(`${root}.setup-${id}/previous/original`, 'preserved');
        mkdirSync(root);
        writeFileSync(join(root, 'partial'), 'incomplete');
        writeJson(`${root}.setup-journal.json`, {
            schemaVersion: 1,
            id,
            hadTarget: true,
            phase: 'activating',
        });
        recoverInstallation(root);
        expect(readFileSync(join(root, 'original'), 'utf8')).toBe('preserved');
        expect(existsSync(join(root, 'partial'))).toBe(false);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('failed first provisioning removes the partial install and unmanaged targets are refused', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pi-setup-new-failure-'));
    const root = join(home, '.pi');
    try {
        const input = bundle(home, 'one');
        await expect(
            installBundle({
                root,
                bundle: input,
                release: 'one',
                provision: async () => {
                    throw new Error('missing host tool');
                },
            }),
        ).rejects.toThrow('missing host tool');
        expect(existsSync(root)).toBe(false);
        expect(existsSync(`${root}.setup-journal.json`)).toBe(false);
        mkdirSync(root);
        writeFileSync(join(root, 'personal'), 'keep');
        await expect(
            installBundle({ root, bundle: input, release: 'one' }),
        ).rejects.toThrow('Unmanaged');
        expect(readFileSync(join(root, 'personal'), 'utf8')).toBe('keep');
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test('an unmanaged symbolic-link parent cannot redirect an update outside the installation', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pi-setup-link-collision-'));
    const root = join(home, '.pi');
    try {
        const first = bundle(home, 'one'),
            second = bundle(home, 'two');
        await installBundle({
            root,
            bundle: first,
            release: 'one',
            provision: async () => {},
        });
        const external = join(home, 'external');
        mkdirSync(external);
        symlinkSync(external, join(root, 'agent/skills'));
        mkdirSync(join(second, 'setup/agent/skills'));
        writeFileSync(join(second, 'setup/agent/skills/SKILL.md'), 'new skill');
        rmSync(join(second, 'manifest.json'));
        writeJson(join(second, 'manifest.json'), {
            schemaVersion: 1,
            platform: 'linux-x64',
            sourceCommit: 'a'.repeat(40),
            packages: [],
            files: inventory(second),
        });
        await expect(
            installBundle({
                root,
                bundle: second,
                release: 'two',
                update: true,
                provision: async () => {},
            }),
        ).rejects.toThrow('Non-directory');
        expect(existsSync(join(external, 'SKILL.md'))).toBe(false);
        expect(readFileSync(join(root, 'bin/pi'), 'utf8')).toBe('one');
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
