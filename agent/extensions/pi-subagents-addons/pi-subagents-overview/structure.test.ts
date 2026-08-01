import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import registerSubagentsAddons from '../index.ts';

const EXTENSIONS_DIR = path.resolve(import.meta.dir, '..', '..');
const ADDONS_DIR = path.resolve(import.meta.dir, '..');

describe('pi-subagents-addons discovery contract', () => {
    it('loads the overview once through the sole aggregate entrypoint', () => {
        const commands: string[] = [];
        const renderers: string[] = [];
        const pi = {
            events: { on: () => () => {}, emit: () => {} },
            on: () => {},
            registerCommand: (name: string) => commands.push(name),
            registerMessageRenderer: (name: string) => renderers.push(name),
        } as unknown as ExtensionAPI;

        registerSubagentsAddons(pi);

        expect(commands.filter((name) => name === 'subagents-overview')).toHaveLength(1);
        expect(commands.filter((name) => name === 'subagent-view')).toHaveLength(1);
        expect(renderers.filter((name) => name === 'pi-subagents-overview')).toHaveLength(1);

        const manifest = JSON.parse(
            fs.readFileSync(path.join(ADDONS_DIR, 'package.json'), 'utf8'),
        ) as { pi?: { extensions?: string[] } };
        expect(manifest.pi?.extensions).toEqual(['./index.ts']);
        expect(
            fs.existsSync(path.join(EXTENSIONS_DIR, 'pi-subagents-overview')),
        ).toBe(false);
    });

    it('uses the Pi-managed pi-subagents version exposing fleetStatus', () => {
        const npmDir = path.resolve(EXTENSIONS_DIR, '..', 'npm');
        const manifest = JSON.parse(
            fs.readFileSync(path.join(npmDir, 'package.json'), 'utf8'),
        ) as { dependencies?: Record<string, string> };
        const installed = JSON.parse(
            fs.readFileSync(
                path.join(npmDir, 'node_modules', 'pi-subagents', 'package.json'),
                'utf8',
            ),
        ) as { version?: string };
        const readme = fs.readFileSync(
            path.join(npmDir, 'node_modules', 'pi-subagents', 'README.md'),
            'utf8',
        );
        const requestedRange = manifest.dependencies?.['pi-subagents'];

        expect(requestedRange).toBeDefined();
        expect(installed.version).toBeDefined();
        expect(Bun.semver.satisfies(installed.version!, requestedRange!)).toBe(true);
        expect(readme).toContain('ping.capabilities.fleetStatus');
    });
});
