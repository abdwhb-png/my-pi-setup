import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadExtensionConfig } from './config-loader.ts';
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent';
const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0))
        rmSync(root, { recursive: true, force: true });
});
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'config-loader-'));
    roots.push(root);
    const agentDir = join(root, 'agent'),
        cwd = join(root, 'project');
    mkdirSync(join(agentDir, 'config'), { recursive: true });
    mkdirSync(join(cwd, '.pi/config'), { recursive: true });
    return { agentDir, cwd };
}
const normalize = (raw: unknown) => (raw ?? {}) as Record<string, number>;
test.each([
    { args: ['--no-approve'], allowed: false },
    { args: ['-na'], allowed: false },
    { args: ['--approve', '--no-approve'], allowed: false },
    { args: ['--no-approve', '-a'], allowed: true },
    { args: ['--', '--no-approve'], allowed: true },
])('honors core startup trust arguments before a runtime context exists (%j)', ({ args, allowed }) => {
    const original = process.argv;
    const { agentDir, cwd } = fixture();
    new ProjectTrustStore(agentDir).set(cwd, true);
    writeFileSync(join(cwd, '.pi/config/slow-mode.json'), '{"a":2}');
    try {
        process.argv = [...original.slice(0, 2), ...args];
        expect(loadExtensionConfig(cwd, { owner: 'slowMode', agentDir, defaults: { a: 1 }, normalize })).toEqual({ a: allowed ? 2 : 1 });
    } finally { process.argv = original; }
});
test.each([null, false, true])('requires saved trust (%s) even if runtime auto-admits a config-only project', (decision) => {
    const { agentDir, cwd } = fixture();
    new ProjectTrustStore(agentDir).set(cwd, decision);
    writeFileSync(join(cwd, '.pi/config/slow-mode.json'), '{"a":2}');
    expect(loadExtensionConfig(cwd, { owner: 'slowMode', agentDir, defaults: { a: 1 }, normalize, projectTrusted: true })).toEqual({ a: decision === true ? 2 : 1 });
    expect(loadExtensionConfig(cwd, { owner: 'slowMode', agentDir, defaults: { a: 1 }, normalize, projectTrusted: false })).toEqual({ a: 1 });
});
test('only reads the selected cwd, never ancestor configuration', () => {
    const { agentDir, cwd } = fixture();
    writeFileSync(join(cwd, '.pi/config/slow-mode.json'), '{"a":1}');
    const nested = join(cwd, 'nested');
    mkdirSync(nested);
    expect(
        loadExtensionConfig(nested, {
            owner: 'slowMode',
            agentDir,
            defaults: {},
            normalize,
            projectTrusted: true,
        }),
    ).toEqual({});
});
test('rejects a legacy settings section even beside canonical config', () => {
    const { agentDir, cwd } = fixture();
    writeFileSync(join(agentDir, 'settings.json'), '{"slowMode":{"a":1}}');
    writeFileSync(join(agentDir, 'config/slow-mode.json'), '{"a":2}');
    expect(() =>
        loadExtensionConfig(cwd, {
            owner: 'slowMode',
            agentDir,
            defaults: {},
            normalize,
        }),
    ).toThrow('needs migration');
});
test('ignores untrusted legacy project config but reports malformed trusted config', () => {
    const { agentDir, cwd } = fixture();
    writeFileSync(join(cwd, '.pi/settings.json'), '{"slowMode":{}}');
    expect(
        loadExtensionConfig(cwd, {
            owner: 'slowMode',
            agentDir,
            defaults: { a: 1 },
            normalize,
            projectTrusted: false,
        }),
    ).toEqual({ a: 1 });
    new ProjectTrustStore(agentDir).set(cwd, true);
    expect(() =>
        loadExtensionConfig(cwd, {
            owner: 'slowMode',
            agentDir,
            defaults: {},
            normalize,
            projectTrusted: true,
        }),
    ).toThrow('needs migration');
    rmSync(join(cwd, '.pi/settings.json'));
    writeFileSync(join(cwd, '.pi/config/slow-mode.json'), 'bad json');
    expect(() =>
        loadExtensionConfig(cwd, {
            owner: 'slowMode',
            agentDir,
            defaults: {},
            normalize,
            projectTrusted: true,
        }),
    ).toThrow('Invalid configuration');
});
test('each bash configuration section loads from one owner file', () => {
    const { agentDir, cwd } = fixture();
    writeFileSync(
        join(agentDir, 'config/bash-execution.json'),
        '{"safeBash":{"a":1},"bashRewrites":{"b":2}}',
    );
    expect(
        loadExtensionConfig(cwd, {
            owner: 'safeBash',
            agentDir,
            defaults: {},
            normalize,
        }),
    ).toEqual({ a: 1 });
    expect(
        loadExtensionConfig(cwd, {
            owner: 'bashRewrites',
            agentDir,
            defaults: {},
            normalize,
        }),
    ).toEqual({ b: 2 });
});
