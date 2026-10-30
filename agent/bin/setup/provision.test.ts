import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toPortableHomePath } from '../../extensions/_shared/home-path.ts';
import { inventory, json, writeJson } from './files.ts';
import { prepareInstalledProfile } from './provision.ts';

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
