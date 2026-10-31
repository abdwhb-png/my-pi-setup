import { expect, test, spyOn } from 'bun:test';
import {
    mkdtempSync,
    rmSync,
    writeFileSync,
    chmodSync,
    readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toPortableHomePath } from '../../extensions/_shared/home-path.ts';
import { inventory, json, writeJson } from './files.ts';
import {
    prepareInstalledProfile,
    verifyPackages,
    restoreBundledExtensionDependencies,
} from './provision.ts';

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
            'import { marker } from "fixture-runtime-dependency"; export class SettingsManager { static create() { throw new Error(marker); } } export class DefaultPackageManager {}',
        );
        writeJson(
            join(
                root,
                'agent/node_modules/fixture-runtime-dependency/package.json',
            ),
            {
                name: 'fixture-runtime-dependency',
                type: 'module',
                main: './index.js',
            },
        );
        writeFileSync(
            join(
                root,
                'agent/node_modules/fixture-runtime-dependency/index.js',
            ),
            'export const marker = "Destination runtime loaded";',
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

test('bundled extension dependencies are restored through frozen firewall installs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-extension-restore-'));
    const originalPath = process.env.PATH;
    const registry = spyOn(globalThis, 'fetch').mockImplementation(
        Object.assign(
            async () =>
                Response.json({
                    name: 'fixture-dependency',
                    version: '1.2.3',
                    dist: { integrity: 'sha512-fixture' },
                }),
            { preconnect: globalThis.fetch.preconnect },
        ),
    );
    try {
        const extension = join(root, 'agent/extensions/fixture');
        writeJson(join(extension, 'package.json'), {
            dependencies: { 'fixture-dependency': '^1.2.0' },
        });
        writeJson(join(extension, 'bun.lock'), {
            packages: {
                'fixture-dependency': [
                    'fixture-dependency@1.2.3',
                    '',
                    {},
                    'sha512-fixture',
                ],
            },
        });
        writeJson(
            join(root, 'agent/extensions/no-dependencies/package.json'),
            {},
        );
        const files = Object.fromEntries(
            Object.entries(inventory(root)).map(([path, hash]) => [
                `setup/${path}`,
                hash,
            ]),
        );
        const firewall = join(root, 'sfw');
        writeFileSync(
            firewall,
            `#!${process.execPath}
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const args=process.argv.slice(2);
if(args[0]==='--version') process.exit(0);
if(JSON.stringify(args)!==JSON.stringify(['bun','install','--frozen-lockfile','--ignore-scripts'])) process.exit(5);
mkdirSync('node_modules/fixture-dependency',{recursive:true});
writeFileSync('node_modules/fixture-dependency/package.json',JSON.stringify({type:'module',main:'index.js'}));
writeFileSync('node_modules/fixture-dependency/index.js','export const restored = true;');
appendFileSync(${JSON.stringify(join(root, 'restored.log'))},process.cwd()+'\\n');
`,
        );
        chmodSync(firewall, 0o700);
        process.env.PATH = `${root}:${originalPath}`;
        await restoreBundledExtensionDependencies(root, files);
        expect(
            readFileSync(
                join(extension, 'node_modules/fixture-dependency/index.js'),
                'utf8',
            ),
        ).toContain('restored = true');
        expect(readFileSync(join(root, 'restored.log'), 'utf8').trim()).toBe(
            extension,
        );
        expect(registry).toHaveBeenCalledWith(
            'https://registry.npmjs.org/fixture-dependency/1.2.3',
            expect.any(Object),
        );
        delete files['setup/agent/extensions/fixture/bun.lock'];
        await expect(
            restoreBundledExtensionDependencies(root, files),
        ).rejects.toThrow('Missing bundled Bun lockfile');
    } finally {
        process.env.PATH = originalPath;
        registry.mockRestore();
        rmSync(root, { recursive: true, force: true });
    }
});
