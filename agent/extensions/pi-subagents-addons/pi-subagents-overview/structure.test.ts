import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import registerSubagentsAddons from '../index.ts';
import { resolvePiSubagentsPackageRoot } from './package-path';

const EXTENSIONS_DIR = path.resolve(import.meta.dir, '..', '..');
const ADDONS_DIR = path.resolve(import.meta.dir, '..');

describe('pi-subagents-addons discovery contract', () => {
    it('keeps the disabled overview behind the sole aggregate entrypoint', () => {
        const commands: string[] = [];
        const renderers: string[] = [];
        const pi = {
            events: { on: () => () => {}, emit: () => {} },
            on: () => {},
            registerCommand: (name: string) => commands.push(name),
            registerMessageRenderer: (name: string) => renderers.push(name),
        } as unknown as ExtensionAPI;

        registerSubagentsAddons(pi);

        expect(commands).toEqual([]);
        expect(renderers).toEqual([]);

        const manifest = JSON.parse(
            fs.readFileSync(path.join(ADDONS_DIR, 'package.json'), 'utf8'),
        ) as { pi?: { extensions?: string[] } };
        expect(manifest.pi?.extensions).toEqual(['./index.ts']);
        expect(
            fs.existsSync(path.join(EXTENSIONS_DIR, 'pi-subagents-overview')),
        ).toBe(false);
    });

    it('uses the Pi-managed upstream PR build exposing fleetStatus', () => {
        const agentDir = path.resolve(EXTENSIONS_DIR, '..');
        const packageRoot = resolvePiSubagentsPackageRoot();
        const settings = JSON.parse(
            fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'),
        ) as { packages?: string[] };
        const installed = JSON.parse(
            fs.readFileSync(
                path.join(packageRoot, 'package.json'),
                'utf8',
            ),
        ) as { version?: string };
        const extensionApi = fs.readFileSync(
            path.join(packageRoot, 'docs', 'extension-api.md'),
            'utf8',
        );

        const prSource = '../../projects/pi-integrations/pi-subagents-upstream-peer-fix/dist-pkg';
        expect(settings.packages?.filter((source) => source.includes('pi-subagents'))).toEqual([prSource]);
        expect(packageRoot).toBe(path.resolve(agentDir, prSource));
        expect(installed.version).toBe('0.71.0');
        expect(extensionApi).toContain('ping.capabilities.fleetStatus');
    });
});
