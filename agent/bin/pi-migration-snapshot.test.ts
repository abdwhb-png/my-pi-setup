import { expect, test } from 'bun:test';
import {
    mkdtempSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
    symlinkSync,
    readlinkSync,
    existsSync,
    rmSync,
    statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigration, rollbackMigration } from './pi-migration-snapshot.ts';

test('rejects overlapping paths whose child name starts with two dots before applying', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-migration-dot-path-'));
    const path = join(root, 'state');
    mkdirSync(path);
    writeFileSync(join(path, '..private'), 'preserve');
    let applied = false;
    try {
        await expect(runMigration({
            paths: [path, join(path, '..private')],
            snapshotDir: join(root, 'backup'),
            apply: async () => { applied = true; },
            verify: async () => {},
        })).rejects.toThrow('Overlapping migration paths');
        expect(applied).toBe(false);
        expect(existsSync(join(root, 'backup'))).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('rolls back core, installed packages and project configuration together, preserving unrelated sessions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-migration-'));
    try {
        const agent = join(root, 'agent'),
            runtime = join(root, 'runtime'),
            project = join(root, 'project');
        mkdirSync(join(agent, 'npm'), { recursive: true });
        mkdirSync(runtime);
        mkdirSync(project);
        writeFileSync(join(agent, 'npm', 'installed'), 'old package');
        writeFileSync(join(agent, 'settings.json'), 'old settings');
        writeFileSync(join(agent, 'session'), 'preserve');
        symlinkSync('old', join(runtime, 'active'));
        const paths = [
            join(agent, 'npm'),
            join(agent, 'settings.json'),
            join(runtime, 'active'),
            join(project, 'mcp.json'),
        ];
        const journal = await runMigration({
            paths,
            snapshotDir: join(root, 'backup'),
            apply: async () => {
                writeFileSync(join(agent, 'npm', 'installed'), 'new package');
                writeFileSync(join(agent, 'settings.json'), 'new settings');
                rmSync(join(runtime, 'active'));
                symlinkSync('new', join(runtime, 'active'));
                writeFileSync(join(project, 'mcp.json'), 'native');
            },
            verify: async () => {
                expect(readlinkSync(join(runtime, 'active'))).toBe('new');
            },
        });
        expect(statSync(join(root, 'backup')).mode & 0o777).toBe(0o700);
        writeFileSync(join(agent, 'session'), 'new session preserved');
        rollbackMigration(journal);
        expect(readFileSync(join(agent, 'npm', 'installed'), 'utf8')).toBe(
            'old package',
        );
        expect(readFileSync(join(agent, 'settings.json'), 'utf8')).toBe(
            'old settings',
        );
        expect(readlinkSync(join(runtime, 'active'))).toBe('old');
        expect(existsSync(join(project, 'mcp.json'))).toBe(false);
        expect(readFileSync(join(agent, 'session'), 'utf8')).toBe(
            'new session preserved',
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('verification failure restores the installed graph and retains its recovery journal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-migration-failed-'));
    const path = join(root, 'package');
    writeFileSync(path, 'old');
    try {
        await expect(
            runMigration({
                paths: [path],
                snapshotDir: join(root, 'backup'),
                apply: async () => {
                    writeFileSync(path, 'new');
                },
                verify: async () => {
                    throw new Error('bad candidate');
                },
            }),
        ).rejects.toThrow('bad candidate');
        expect(readFileSync(path, 'utf8')).toBe('old');
        expect(existsSync(join(root, 'backup', 'journal.json'))).toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('rollback refuses concurrent personal edits before changing any path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-migration-edited-'));
    const path = join(root, 'settings');
    writeFileSync(path, 'old');
    try {
        const journal = await runMigration({
            paths: [path],
            snapshotDir: join(root, 'backup'),
            apply: async () => {
                writeFileSync(path, 'new');
            },
            verify: async () => {},
        });
        writeFileSync(path, 'personal edit');
        expect(() => rollbackMigration(journal)).toThrow(
            'changed after migration',
        );
        expect(readFileSync(path, 'utf8')).toBe('personal edit');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('rejects overlapping paths and changed backups before restoring', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-migration-boundary-')),
        path = join(root, 'settings');
    writeFileSync(path, 'old');
    try {
        await expect(
            runMigration({
                paths: [root, path],
                snapshotDir: join(root, 'backup'),
                apply: async () => {},
                verify: async () => {},
            }),
        ).rejects.toThrow('Unsafe');
        const journal = await runMigration({
            paths: [path],
            snapshotDir: join(root, 'backup'),
            apply: async () => {
                writeFileSync(path, 'new');
            },
            verify: async () => {},
        });
        writeFileSync(join(root, 'backup', 'before', '0'), 'tampered');
        expect(() => rollbackMigration(journal)).toThrow('backup changed');
        expect(readFileSync(path, 'utf8')).toBe('new');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('rejects malformed journals before touching migration paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-migration-journal-')),
        path = join(root, 'settings');
    writeFileSync(path, 'old');
    try {
        const journal = await runMigration({
            paths: [path],
            snapshotDir: join(root, 'backup'),
            apply: async () => {
                writeFileSync(path, 'new');
            },
            verify: async () => {},
        });
        const valid = JSON.parse(readFileSync(journal, 'utf8'));
        for (const mutation of [
            { ...valid, entries: [] },
            { ...valid, entries: [{ ...valid.entries[0], path: '/' }] },
            {
                ...valid,
                entries: [
                    { ...valid.entries[0], backup: join(root, 'outside') },
                ],
            },
            { ...valid, entries: [{ ...valid.entries[0], after: undefined }] },
            { ...valid, entries: [valid.entries[0], valid.entries[0]] },
        ]) {
            writeFileSync(journal, JSON.stringify(mutation));
            expect(() => rollbackMigration(journal)).toThrow(
                'Invalid migration journal',
            );
            expect(readFileSync(path, 'utf8')).toBe('new');
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
