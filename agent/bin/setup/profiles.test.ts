import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJson } from './files.ts';
import { reconcileProfiles } from './profiles.ts';
const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0))
        rmSync(root, { recursive: true, force: true });
});
function merge(
    base: object,
    local: object,
    incoming: object,
    path = 'agent/fancy-footer.json',
) {
    const root = mkdtempSync(join(tmpdir(), 'pi-profile-merge-'));
    roots.push(root);
    writeJson(join(root, path), local);
    return reconcileProfiles(
        root,
        { [path]: base as Record<string, unknown> },
        { [path]: incoming as Record<string, unknown> },
    );
}
test('local arrays are atomic and unmodified nested values follow incoming defaults', () => {
    const result = merge(
        { items: ['old'], nested: { a: 1, b: 2 } },
        { items: ['machine'], nested: { a: 9, b: 2 } },
        { items: ['new', 'added'], nested: { a: 3, b: 4 } },
    );
    expect(result.profiles['agent/fancy-footer.json']).toEqual({
        items: ['machine'],
        nested: { a: 9, b: 4 },
    });
});
test('local deletions remain deleted while new defaults are added', () => {
    expect(
        merge({ a: 1, b: 2 }, { b: 2 }, { a: 3, b: 4, c: 5 }).profiles[
            'agent/fancy-footer.json'
        ],
    ).toEqual({ b: 4, c: 5 });
});
test.each([
    [{ a: 1 }, { a: 2 }, {}],
    [{ a: 1 }, { a: 2 }, { a: { enabled: true } }],
    [{ a: { b: 1 } }, { a: { b: 2 } }, { a: null }],
])(
    'refuses incompatible customizations without exposing values (%#)',
    (base, local, incoming) => {
        expect(() => merge(base, local, incoming)).toThrow(
            'Incompatible local preference: agent/fancy-footer.json#/a',
        );
    },
);
test('setup-owned package changes require explicit reconciliation', () => {
    expect(() =>
        merge(
            { packages: ['old'] },
            { packages: ['machine'] },
            { packages: ['new'] },
            'agent/settings.json',
        ),
    ).toThrow('#/packages');
});
test('generated changelog versions follow the runtime', () => {
    expect(
        merge(
            { lastChangelogVersion: 'old' },
            { lastChangelogVersion: 'interactive' },
            { lastChangelogVersion: 'new' },
            'agent/settings.json',
        ).profiles['agent/settings.json'],
    ).toEqual({ lastChangelogVersion: 'new' });
});
test('rejects an invalid provider configuration before activation', () => {
    expect(() =>
        merge(
            { providers: { cpa: {} } },
            { providers: { cpa: { enabled: 'wrong' } } },
            { providers: { cpa: {} } },
            'agent/config/ai-providers.json',
        ),
    ).toThrow('providers.cpa.enabled');
});
test('refuses a modified removed profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-profile-removed-'));
    roots.push(root);
    writeJson(join(root, 'agent/fancy-footer.json'), { a: 2 });
    expect(() =>
        reconcileProfiles(root, { 'agent/fancy-footer.json': { a: 1 } }, {}),
    ).toThrow('Incompatible local preference');
});
test('refuses symlinked preferences', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-profile-symlink-'));
    roots.push(root);
    writeJson(join(root, 'target.json'), {});
    symlinkSync(join(root, 'target.json'), join(root, 'linked.json'));
    expect(() =>
        reconcileProfiles(root, { 'linked.json': {} }, { 'linked.json': {} }),
    ).toThrow('regular JSON object');
});
