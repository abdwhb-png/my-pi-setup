import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toPortableHomePath } from '../../extensions/_shared/home-path.ts';
import { inventory, json, writeJson } from './files.ts';
import { prepareInstalledProfile, verifyPackages } from './provision.ts';

test('package verification loads the destination runtime installed after the operator module', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-late-runtime-'));
    try {
        expect(() =>
            import.meta.resolve(
                '@earendil-works/pi-coding-agent',
                pathToFileURL(join(root, 'agent/package.json')).href,
            ),
        ).toThrow();
        const moduleRoot = join(
            root,
            'agent/node_modules/@earendil-works/pi-coding-agent',
        );
        writeJson(join(moduleRoot, 'package.json'), {
            name: '@earendil-works/pi-coding-agent',
            type: 'module',
            main: './index.js',
            exports: { '.': { import: './index.js' } },
        });
        writeFileSync(
            join(moduleRoot, 'index.js'),
            'export class SettingsManager { static create() { throw new Error("Destination runtime loaded"); } } export class DefaultPackageManager {}',
        );
        await expect(verifyPackages(root, [])).rejects.toThrow(
            'Destination runtime loaded',
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('installation relocates every bundled profile and seeds the runtime changelog marker', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-profile-'));
    try {
        writeJson(join(root, 'agent/settings.json'), {
            packages: [],
            skills: ['~/.pi/agent/skills'],
            defaultModel: 'fixture',
        });
        writeJson(join(root, 'agent/hermes-memory-config.json'), {
            memoryDir: '~/.pi/agent/pi-hermes-memory',
        });
        writeJson(join(root, 'agent/config/tool-summary.json'), {
            fixturePath: '~/.pi/agent/assets',
        });
        const files = Object.fromEntries(
            Object.entries(inventory(root)).map(([path, hash]) => [
                `setup/${path}`,
                hash,
            ]),
        );
        writeJson(join(root, 'agent/config/sandbox.json'), {
            identity: 'local',
        });
        const settings = prepareInstalledProfile(root, files, '1.2.3');
        expect(settings.defaultModel).toBe('fixture');
        expect(settings.lastChangelogVersion).toBe('1.2.3');
        expect(settings.skills).toEqual([
            toPortableHomePath(join(root, 'agent/skills')),
        ]);
        expect(
            json(join(root, 'agent/hermes-memory-config.json')).memoryDir,
        ).toBe(toPortableHomePath(join(root, 'agent/pi-hermes-memory')));
        expect(
            json(join(root, 'agent/config/tool-summary.json')).fixturePath,
        ).toBe(toPortableHomePath(join(root, 'agent/assets')));
        expect(json(join(root, 'agent/config/sandbox.json'))).toEqual({
            identity: 'local',
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
