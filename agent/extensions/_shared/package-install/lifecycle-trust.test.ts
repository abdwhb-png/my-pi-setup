import { describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    getLifecycleScripts,
    readTrustedDependencies,
    repairConfiguredPackageTrust,
} from './lifecycle-trust.ts';

function makeTempDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

describe('getLifecycleScripts', () => {
    it('returns lifecycle scripts that are declared on the package', () => {
        const scripts = getLifecycleScripts({
            name: 'pkg',
            scripts: { postinstall: 'node post.js', build: 'tsc' },
        });
        expect(scripts).toEqual(['postinstall']);
    });

    it('returns all four lifecycle phases when present', () => {
        const scripts = getLifecycleScripts({
            scripts: {
                preinstall: 'echo pre',
                install: 'echo install',
                postinstall: 'echo post',
                prepare: 'echo prepare',
            },
        });
        expect(scripts.sort()).toEqual(
            ['install', 'postinstall', 'prepare', 'preinstall'].sort(),
        );
    });

    it('returns empty when no lifecycle scripts declared', () => {
        expect(getLifecycleScripts({ scripts: { build: 'tsc' } })).toEqual([]);
        expect(getLifecycleScripts({})).toEqual([]);
    });
});

describe('readTrustedDependencies', () => {
    it('reads the trustedDependencies array from bun.lock', () => {
        const dir = makeTempDir('pi-trust-');
        writeFileSync(
            join(dir, 'bun.lock'),
            JSON.stringify({
                trustedDependencies: ['pkg-a', '@scope/pkg-b'],
                packages: {},
            }),
        );
        const trusted = readTrustedDependencies(dir);
        expect(trusted.has('pkg-a')).toBe(true);
        expect(trusted.has('@scope/pkg-b')).toBe(true);
        expect(trusted.has('missing')).toBe(false);
    });

    it('returns empty set when bun.lock is missing', () => {
        const dir = makeTempDir('pi-trust-');
        const trusted = readTrustedDependencies(dir);
        expect(trusted.size).toBe(0);
    });

    it('returns empty set when bun.lock has no trustedDependencies field', () => {
        const dir = makeTempDir('pi-trust-');
        writeFileSync(join(dir, 'bun.lock'), JSON.stringify({ packages: {} }));
        const trusted = readTrustedDependencies(dir);
        expect(trusted.size).toBe(0);
    });

    it('returns empty set when bun.lock is malformed JSON', () => {
        const dir = makeTempDir('pi-trust-');
        writeFileSync(join(dir, 'bun.lock'), '{ not json');
        const trusted = readTrustedDependencies(dir);
        expect(trusted.size).toBe(0);
    });
});

describe('repairConfiguredPackageTrust', () => {
    function setupAgentDir() {
        const agentDir = makeTempDir('pi-agent-');
        const cwd = makeTempDir('pi-cwd-');
        const npmRoot = join(agentDir, 'npm', 'node_modules');
        mkdirSync(join(npmRoot, '@scope'), { recursive: true });

        const pkgRoot = join(npmRoot, '@scope', 'needs-trust');
        mkdirSync(pkgRoot, { recursive: true });
        writeFileSync(
            join(pkgRoot, 'package.json'),
            JSON.stringify({
                name: '@scope/needs-trust',
                scripts: { postinstall: 'node post.js' },
            }),
        );

        const trustedPkgRoot = join(npmRoot, 'already-trusted');
        mkdirSync(trustedPkgRoot, { recursive: true });
        writeFileSync(
            join(trustedPkgRoot, 'package.json'),
            JSON.stringify({
                name: 'already-trusted',
                scripts: { postinstall: 'node post.js' },
            }),
        );

        const noScriptRoot = join(npmRoot, 'no-script');
        mkdirSync(noScriptRoot, { recursive: true });
        writeFileSync(
            join(noScriptRoot, 'package.json'),
            JSON.stringify({ name: 'no-script' }),
        );

        writeFileSync(
            join(agentDir, 'settings.json'),
            JSON.stringify({
                packages: [
                    'npm:@scope/needs-trust',
                    'npm:already-trusted',
                    'npm:no-script',
                ],
            }),
        );
        writeFileSync(
            join(agentDir, 'npm', 'bun.lock'),
            JSON.stringify({ trustedDependencies: ['already-trusted'] }),
        );
        return { agentDir, cwd };
    }

    it('trusts packages with lifecycle scripts that are not yet trusted (confirm:false)', async () => {
        const { agentDir, cwd } = setupAgentDir();
        const spawnCalls: string[][] = [];
        mock.module('node:child_process', () => ({
            spawnSync: mock((command: string, args: string[]) => {
                spawnCalls.push([command, ...args]);
                return { status: 0, stderr: '', stdout: '' };
            }),
        }));
        const fresh = await import(`./lifecycle-trust.ts?run=${Date.now()}`);

        const result = await fresh.repairConfiguredPackageTrust({
            cwd,
            agentDir,
            logger: { info() {}, warn() {} },
        });

        expect(result.trusted).toEqual(['@scope/needs-trust']);
        expect(spawnCalls.length).toBe(1);
        expect(spawnCalls[0]).toContain('trust');
        expect(spawnCalls[0]).toContain('@scope/needs-trust');
        expect(result.inspected).toBe(2);
        expect(result.skipped).toBe(2);
    });

    it('skips trust when confirmation is refused', async () => {
        const { agentDir, cwd } = setupAgentDir();
        const spawnCalls: string[][] = [];
        mock.module('node:child_process', () => ({
            spawnSync: mock((command: string, args: string[]) => {
                spawnCalls.push([command, ...args]);
                return { status: 0, stderr: '', stdout: '' };
            }),
        }));
        const fresh = await import(
            `./lifecycle-trust.ts?refused=${Date.now()}`
        );

        const result = await fresh.repairConfiguredPackageTrust({
            cwd,
            agentDir,
            confirm: true,
            onConfirm: () => false,
            logger: { info() {}, warn() {} },
        });

        expect(result.trusted).toEqual([]);
        expect(spawnCalls.length).toBe(0);
        expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('records a warning when bun pm trust exits non-zero', async () => {
        const { agentDir, cwd } = setupAgentDir();
        mock.module('node:child_process', () => ({
            spawnSync: mock(() => ({
                status: 1,
                stderr: 'trust failed',
                stdout: '',
            })),
        }));
        const fresh = await import(`./lifecycle-trust.ts?fail=${Date.now()}`);

        const result = await fresh.repairConfiguredPackageTrust({
            cwd,
            agentDir,
            logger: { info() {}, warn() {} },
        });

        expect(result.trusted).toEqual([]);
        expect(
            result.warnings.some(
                (w: string) =>
                    w.includes('trust failed') ||
                    w.includes('@scope/needs-trust'),
            ),
        ).toBe(true);
    });

    it('treats bun pm trust "already trusted" stderr as success', async () => {
        const { agentDir, cwd } = setupAgentDir();
        mock.module('node:child_process', () => ({
            spawnSync: mock(() => ({
                status: 1,
                stderr: 'These packages are already trusted',
                stdout: '',
            })),
        }));
        const fresh = await import(
            `./lifecycle-trust.ts?already=${Date.now()}`
        );

        const result = await fresh.repairConfiguredPackageTrust({
            cwd,
            agentDir,
            logger: { info() {}, warn() {} },
        });

        expect(result.trusted).toEqual(['@scope/needs-trust']);
        expect(result.warnings.length).toBe(0);
    });

    it('treats missing install root (package not on disk) as skipped, not warning', async () => {
        const agentDir = makeTempDir('pi-agent-');
        const cwd = makeTempDir('pi-cwd-');
        writeFileSync(
            join(agentDir, 'settings.json'),
            JSON.stringify({ packages: ['npm:does-not-exist'] }),
        );
        const result = await repairConfiguredPackageTrust({
            cwd,
            agentDir,
            logger: { info() {}, warn() {} },
        });
        expect(result.inspected).toBe(0);
        expect(
            existsSync(join(agentDir, 'npm', 'node_modules', 'does-not-exist')),
        ).toBe(false);
    });
});
