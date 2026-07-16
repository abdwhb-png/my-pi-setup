import { describe, expect, it, mock } from 'bun:test';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as packageFinalizer from './finalizer.ts';

function makeTempDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

describe('package-install-finalizer', () => {
    it('replaces a broken symlink with the correct one', () => {
        const agentDir = makeTempDir('pi-agent-');
        const cwd = makeTempDir('pi-cwd-');
        const packageRoot = makeTempDir('pi-package-');

        mkdirSync(join(packageRoot, 'dist'), { recursive: true });
        writeFileSync(
            join(packageRoot, 'package.json'),
            JSON.stringify({
                name: 'pi-roles',
                pi: { extensions: ['./dist/index.js'] },
                exports: {
                    '.': './dist/index.js',
                    './protocol': './dist/protocol.js',
                },
            }),
        );
        writeFileSync(
            join(packageRoot, 'dist', 'index.js'),
            'export default {}\n',
        );
        writeFileSync(
            join(packageRoot, 'dist', 'protocol.js'),
            'export const ok = true\n',
        );

        // Create a broken symlink at the target path (target doesn't exist)
        const linkPath = join(agentDir, 'node_modules', 'pi-roles');
        mkdirSync(dirname(linkPath), { recursive: true });
        try {
            symlinkSync('/nonexistent/target', linkPath, 'dir');
        } catch {}

        const changed = packageFinalizer.ensurePackageLinks(
            packageRoot,
            'pi-roles',
            'user',
            cwd,
            agentDir,
        );

        expect(changed).toContain(linkPath);
        expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
        expect(realpathSync(linkPath)).toBe(realpathSync(packageRoot));
    });

    it('replaces a stale shim with a real symlink', () => {
        const agentDir = makeTempDir('pi-agent-');
        const cwd = makeTempDir('pi-cwd-');
        const packageRoot = makeTempDir('pi-package-');

        mkdirSync(join(packageRoot, 'dist'), { recursive: true });
        writeFileSync(
            join(packageRoot, 'package.json'),
            JSON.stringify({
                name: 'pi-roles',
                pi: { extensions: ['./dist/index.js'] },
                exports: {
                    '.': './dist/index.js',
                    './protocol': './dist/protocol.js',
                },
            }),
        );
        writeFileSync(
            join(packageRoot, 'dist', 'index.js'),
            'export default {}\n',
        );
        writeFileSync(
            join(packageRoot, 'dist', 'protocol.js'),
            'export const ok = true\n',
        );

        const shimDir = join(agentDir, 'node_modules', 'pi-roles');
        mkdirSync(shimDir, { recursive: true });
        writeFileSync(
            join(shimDir, 'package.json'),
            JSON.stringify({ name: 'pi-roles', type: 'module' }),
        );
        writeFileSync(
            join(shimDir, 'index.js'),
            'export * from "/old/path/index.js";\n',
        );
        writeFileSync(
            join(shimDir, 'protocol.js'),
            'export * from "/old/path/protocol.js";\n',
        );

        const changed = packageFinalizer.ensurePackageLinks(
            packageRoot,
            'pi-roles',
            'user',
            cwd,
            agentDir,
        );

        expect(changed).toContain(join(agentDir, 'node_modules', 'pi-roles'));
        expect(
            lstatSync(
                join(agentDir, 'node_modules', 'pi-roles'),
            ).isSymbolicLink(),
        ).toBe(true);
        expect(realpathSync(join(agentDir, 'node_modules', 'pi-roles'))).toBe(
            realpathSync(packageRoot),
        );
    });

    it('uses cached state to skip unchanged packages on subsequent runs', async () => {
        const agentDir = makeTempDir('pi-agent-');
        const cwd = makeTempDir('pi-cwd-');
        const packageRoot = makeTempDir('pi-package-');

        writeFileSync(
            join(agentDir, 'settings.json'),
            JSON.stringify({ packages: [packageRoot] }),
        );

        mkdirSync(join(packageRoot, 'dist'), { recursive: true });
        writeFileSync(
            join(packageRoot, 'package.json'),
            JSON.stringify({
                name: 'pi-roles',
                pi: { extensions: ['./dist/index.js'] },
                exports: {
                    '.': './dist/index.js',
                    './protocol': './dist/protocol.js',
                },
            }),
        );
        writeFileSync(
            join(packageRoot, 'dist', 'index.js'),
            'export default {}\n',
        );
        writeFileSync(
            join(packageRoot, 'dist', 'protocol.js'),
            'export const ok = true\n',
        );

        const first = await packageFinalizer.repairConfiguredPiPackages({
            cwd,
            agentDir,
            logger: { info() {}, warn() {} },
        });
        const second = await packageFinalizer.repairConfiguredPiPackages({
            cwd,
            agentDir,
            logger: { info() {}, warn() {} },
        });

        expect(first.inspected).toBe(1);
        expect(second.inspected).toBe(1);
        expect(second.skipped).toBe(1);
        expect(existsSync(packageFinalizer.getStateFilePath(agentDir))).toBe(
            true,
        );
    });

    it('replaces an owned non-symlink package directory with the current managed symlink', async () => {
        const agentDir = makeTempDir('pi-agent-');
        const cwd = makeTempDir('pi-cwd-');
        const packageRoot = makeTempDir('pi-package-');

        mkdirSync(join(packageRoot, 'dist'), { recursive: true });
        writeFileSync(
            join(packageRoot, 'package.json'),
            JSON.stringify({
                name: 'pi-roles',
                pi: { extensions: ['./dist/index.js'] },
                exports: {
                    '.': './dist/index.js',
                    './protocol': './dist/protocol.js',
                },
            }),
        );
        writeFileSync(
            join(packageRoot, 'dist', 'index.js'),
            'export default {}\n',
        );
        writeFileSync(
            join(packageRoot, 'dist', 'protocol.js'),
            'export const ok = true\n',
        );
        writeFileSync(
            join(agentDir, 'settings.json'),
            JSON.stringify({ packages: [packageRoot] }),
        );

        const ownedDir = join(agentDir, 'node_modules', 'pi-roles');
        mkdirSync(ownedDir, { recursive: true });
        writeFileSync(
            join(ownedDir, 'package.json'),
            JSON.stringify({ name: 'pi-roles' }),
        );
        writeFileSync(join(ownedDir, 'index.js'), 'export default {}\n');

        writeFileSync(
            packageFinalizer.getStateFilePath(agentDir),
            JSON.stringify({
                version: 1,
                packages: {
                    [`user:${packageRoot}`]: {
                        source: packageRoot,
                        scope: 'user',
                        packageRoot,
                        packageJsonMtimeMs: 0,
                        packageJsonSize: 0,
                        globalSettingsMtimeMs: 0,
                        projectSettingsMtimeMs: 0,
                        managedLinkPaths: [ownedDir],
                    },
                },
            }),
        );

        const result = await packageFinalizer.repairConfiguredPiPackages({
            cwd,
            agentDir,
            logger: { info() {}, warn() {} },
            force: true,
        });

        expect(result.linked).toContain(ownedDir);
        expect(lstatSync(ownedDir).isSymbolicLink()).toBe(true);
        expect(realpathSync(ownedDir)).toBe(realpathSync(packageRoot));
    });

    it('creates scoped package links by ensuring parent directories exist', () => {
        const agentDir = makeTempDir('pi-agent-');
        const cwd = makeTempDir('pi-cwd-');
        const packageRoot = makeTempDir('pi-package-');

        writeFileSync(
            join(packageRoot, 'package.json'),
            JSON.stringify({ name: '@juicesharp/rpiv-ask-user-question' }),
        );

        const changed = packageFinalizer.ensurePackageLinks(
            packageRoot,
            '@juicesharp/rpiv-ask-user-question',
            'user',
            cwd,
            agentDir,
        );

        expect(changed).toContain(
            join(
                agentDir,
                'node_modules',
                '@juicesharp',
                'rpiv-ask-user-question',
            ),
        );
        expect(
            lstatSync(
                join(
                    agentDir,
                    'node_modules',
                    '@juicesharp',
                    'rpiv-ask-user-question',
                ),
            ).isSymbolicLink(),
        ).toBe(true);
    });

    it('runs prepare/build when expected artifacts are missing', async () => {
        const agentDir = makeTempDir('pi-agent-');
        const cwd = makeTempDir('pi-cwd-');
        const packageRoot = makeTempDir('pi-package-');

        writeFileSync(
            join(agentDir, 'settings.json'),
            JSON.stringify({ packages: [packageRoot] }),
        );

        writeFileSync(
            join(packageRoot, 'package.json'),
            JSON.stringify({
                name: 'pi-roles',
                scripts: { build: 'echo build' },
                pi: { extensions: ['./dist/index.js'] },
                exports: { '.': './dist/index.js' },
            }),
        );

        const spawnCalls: string[] = [];
        mock.module('node:child_process', () => ({
            spawnSync: mock((command: string, args: string[]) => {
                spawnCalls.push([command, ...args].join(' '));
                mkdirSync(join(packageRoot, 'dist'), { recursive: true });
                writeFileSync(
                    join(packageRoot, 'dist', 'index.js'),
                    'export default {}\n',
                );
                return { status: 0, stderr: '', stdout: '' };
            }),
        }));

        const fresh = await import(
            `./finalizer.ts?missing-artifacts=${Date.now()}`
        );
        const result = await fresh.repairConfiguredPiPackages({
            cwd,
            agentDir,
            logger: { info() {}, warn() {} },
            force: true,
        });

        expect(result.built).toContain(packageRoot);
        expect(spawnCalls.some((call) => call.includes('run build'))).toBe(
            true,
        );
        expect(existsSync(join(packageRoot, 'dist', 'index.js'))).toBe(true);
    });
});
