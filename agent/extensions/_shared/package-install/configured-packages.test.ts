import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    isLocalPathSource,
    parseGitSource,
    parseNpmPackageName,
    parsePackageSource,
} from './configured-packages.ts';

it('excludes project packages before opening their metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ignored-package-metadata-'));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const agentDir = join(root, 'agent'), cwd = join(root, 'project'), pkg = join(root, 'package');
        mkdirSync(agentDir); mkdirSync(join(cwd, '.pi'), { recursive: true }); mkdirSync(pkg);
        writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify({ packages: [pkg] }));
        const fifo = Bun.spawn(['mkfifo', join(pkg, 'package.json')]);
        expect(await fifo.exited).toBe(0);
        const script = `import { forEachConfiguredPackage } from ${JSON.stringify(fileURLToPath(new URL('./configured-packages.ts', import.meta.url)))};
          await forEachConfiguredPackage({ cwd: ${JSON.stringify(cwd)}, agentDir: ${JSON.stringify(agentDir)}, includeProject: false }, () => { throw new Error('ignored scope was visited'); });`;
        child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
        timer = setTimeout(() => child?.kill(), 1000);
        expect(await child.exited).toBe(0);
    } finally {
        clearTimeout(timer); child?.kill();
        rmSync(root, { recursive: true, force: true });
    }
});

describe('configured package source parsing', () => {
    it('parses versioned scoped npm package names', () => {
        expect(parseNpmPackageName('npm:@scope/tool@1.2.3')).toBe(
            '@scope/tool',
        );
        expect(parsePackageSource('npm:@scope/tool@1.2.3')).toEqual({
            type: 'npm',
            name: '@scope/tool',
        });
    });

    it('distinguishes local and git package sources', () => {
        expect(isLocalPathSource('../pi-roles')).toBe(true);
        expect(parsePackageSource('../pi-roles')).toEqual({
            type: 'local',
            path: '../pi-roles',
        });
        expect(parseGitSource('git:github.com/owner/repo.git@main')).toEqual({
            type: 'git',
            host: 'github.com',
            path: 'owner/repo',
        });
    });
});
