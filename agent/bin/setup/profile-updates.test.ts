import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventory, writeJson } from './files.ts';
import { installBundle, rollbackInstallation } from './installation.ts';

function makeBundle(parent: string, name: string, profile: object): string {
    const root = join(parent, name);
    mkdirSync(root);
    for (const [path, value] of Object.entries({
        'setup/bin/pi': name,
        'setup/bin/pi-setup': name,
        'setup/agent/settings.json': profile,
        'pi/release-manifest.json': {},
        'zerobox/manifest.json': {},
        'zerobox/provenance.json': {},
    }))
        writeJson(join(root, path), value);
    writeJson(join(root, 'manifest.json'), {
        schemaVersion: 1,
        platform: 'linux-x64',
        sourceCommit: 'a'.repeat(40),
        files: inventory(root),
        packages: [],
    });
    return root;
}
async function scenario(
    oldDefaults: object,
    local: object,
    newDefaults: object,
    expected: object,
) {
    const directory = mkdtempSync(join(tmpdir(), 'pi-preferences-rollback-'));
    const root = join(directory, 'installation');
    const provision = async () => {};
    try {
        const first = makeBundle(directory, 'old', oldDefaults);
        const second = makeBundle(directory, 'new', newDefaults);
        await installBundle({ root, bundle: first, release: 'old', provision });
        writeJson(join(root, 'agent/settings.json'), local);
        await installBundle({
            root,
            bundle: second,
            release: 'new',
            update: true,
            provision,
        });
        await rollbackInstallation(root);
        expect(
            JSON.parse(readFileSync(join(root, 'agent/settings.json'), 'utf8')),
        ).toEqual(expected);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}
test('rollback retains an existing machine preference when the new default happens to equal it', async () => {
    await scenario(
        { defaultModel: 'old-default' },
        { defaultModel: 'machine' },
        { defaultModel: 'machine' },
        { defaultModel: 'machine' },
    );
});
test('rollback retains a machine-only preference when it becomes a matching new default', async () => {
    await scenario(
        {},
        { hideThinkingBlock: true },
        { hideThinkingBlock: true },
        { hideThinkingBlock: true },
    );
});
test('rollback retains a machine deletion when the incoming release removes the default too', async () => {
    await scenario(
        { hideThinkingBlock: false, theme: 'dark' },
        { theme: 'dark' },
        { theme: 'dark' },
        { theme: 'dark' },
    );
});
test('a second forward update retains a machine preference that matched the middle release default', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-preferences-update-'));
    const root = join(directory, 'installation');
    const provision = async () => {};
    try {
        const a = makeBundle(directory, 'a', { defaultModel: 'default-a' });
        const b = makeBundle(directory, 'b', { defaultModel: 'machine' });
        const c = makeBundle(directory, 'c', { defaultModel: 'default-c' });
        await installBundle({ root, bundle: a, release: 'a', provision });
        writeJson(join(root, 'agent/settings.json'), {
            defaultModel: 'machine',
        });
        await installBundle({
            root,
            bundle: b,
            release: 'b',
            update: true,
            provision,
        });
        await installBundle({
            root,
            bundle: c,
            release: 'c',
            update: true,
            provision,
        });
        expect(
            JSON.parse(readFileSync(join(root, 'agent/settings.json'), 'utf8')),
        ).toEqual({ defaultModel: 'machine' });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test.each([
    {
        name: 'empty object additions',
        a: {},
        local: { panel: {} },
        b: { panel: {} },
        c: {},
        expected: { panel: {} },
    },
    {
        name: 'new defaults inside locally added objects',
        a: {},
        local: { panel: {} },
        b: { panel: {} },
        c: { panel: { added: true } },
        expected: { panel: { added: true } },
    },
    {
        name: 'nested properties',
        a: { panel: { local: 1, shared: 1 } },
        local: { panel: { local: 9, shared: 1 } },
        b: { panel: { local: 9, shared: 2 } },
        c: { panel: { local: 10, shared: 3 } },
        expected: { panel: { local: 9, shared: 3 } },
    },
    {
        name: 'object replacements',
        a: { panel: [] },
        local: { panel: { density: 'compact' } },
        b: { panel: { density: 'compact' } },
        c: { panel: { density: 'roomy' } },
        expected: { panel: { density: 'compact' } },
    },
    {
        name: 'atomic arrays',
        a: { models: ['a'] },
        local: { models: ['local'] },
        b: { models: ['local'] },
        c: { models: ['c'] },
        expected: { models: ['local'] },
    },
    {
        name: 'deletions after a default disappears and returns',
        a: { local: 1 },
        local: {},
        b: {},
        c: { local: 2 },
        expected: {},
    },
    {
        name: 'manual reset to a different delivered default',
        a: { theme: 'a' },
        local: { theme: 'local' },
        b: { theme: 'b' },
        edit: { theme: 'b' },
        c: { theme: 'c' },
        expected: { theme: 'c' },
    },
    {
        name: 'manual edits after convergence',
        a: { theme: 'a' },
        local: { theme: 'local' },
        b: { theme: 'local' },
        edit: { theme: 'another' },
        c: { theme: 'c' },
        expected: { theme: 'another' },
    },
])(
    'successive updates retain $name',
    async ({ a, local, b, c, edit, expected }) => {
        const directory = mkdtempSync(
            join(tmpdir(), 'pi-preference-transitions-'),
        );
        const root = join(directory, 'installation');
        const provision = async () => {};
        try {
            await installBundle({
                root,
                bundle: makeBundle(directory, 'a', a),
                release: 'a',
                provision,
            });
            writeJson(join(root, 'agent/settings.json'), local);
            await installBundle({
                root,
                bundle: makeBundle(directory, 'b', b),
                release: 'b',
                update: true,
                provision,
            });
            if (edit) writeJson(join(root, 'agent/settings.json'), edit);
            await installBundle({
                root,
                bundle: makeBundle(directory, 'c', c),
                release: 'c',
                update: true,
                provision,
            });
            expect(
                JSON.parse(
                    readFileSync(join(root, 'agent/settings.json'), 'utf8'),
                ),
            ).toEqual(expected);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    },
);

test('malformed customization provenance refuses an update without modifying profiles', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-preference-invalid-'));
    const root = join(directory, 'installation');
    const provision = async () => {};
    try {
        await installBundle({
            root,
            bundle: makeBundle(directory, 'a', {}),
            release: 'a',
            provision,
        });
        const statePath = join(root, '.pi-setup-state.json');
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        state.profilePreferences = {
            'agent/settings.json': [{ location: [], value: 'invalid' }],
        };
        writeJson(statePath, state);
        const before = inventory(root);
        await expect(
            installBundle({
                root,
                bundle: makeBundle(directory, 'b', { theme: 'b' }),
                release: 'b',
                update: true,
                provision,
            }),
        ).rejects.toThrow('Invalid profile preference');
        expect(inventory(root)).toEqual(before);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
