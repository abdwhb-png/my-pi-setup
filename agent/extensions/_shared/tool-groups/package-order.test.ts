import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import {
    isToolGroupsPackageLast,
    pinToolGroupsPackageLast,
    TOOL_GROUPS_PACKAGE_SOURCE,
} from './package-order.ts';

const AGENT_DIR = '/tmp/test-agent';

describe('package-order', () => {
    describe('isToolGroupsPackageLast', () => {
        it('returns false for empty array', () => {
            expect(isToolGroupsPackageLast([], AGENT_DIR)).toBe(false);
        });

        it('returns true when only tool-groups present', () => {
            expect(
                isToolGroupsPackageLast(
                    [TOOL_GROUPS_PACKAGE_SOURCE],
                    AGENT_DIR,
                ),
            ).toBe(true);
        });

        it('returns true when tool-groups is last in multi-entry array', () => {
            expect(
                isToolGroupsPackageLast(
                    ['./extensions/a', TOOL_GROUPS_PACKAGE_SOURCE],
                    AGENT_DIR,
                ),
            ).toBe(true);
        });

        it('returns false when tool-groups is not last', () => {
            expect(
                isToolGroupsPackageLast(
                    [TOOL_GROUPS_PACKAGE_SOURCE, './extensions/b'],
                    AGENT_DIR,
                ),
            ).toBe(false);
        });

        it('returns false when tool-groups absent', () => {
            expect(
                isToolGroupsPackageLast(
                    ['./extensions/a', './extensions/b'],
                    AGENT_DIR,
                ),
            ).toBe(false);
        });

        it('recognises object-form source', () => {
            expect(
                isToolGroupsPackageLast(
                    [
                        {
                            source: TOOL_GROUPS_PACKAGE_SOURCE,
                            extensions: ['index.js'],
                        },
                    ],
                    AGENT_DIR,
                ),
            ).toBe(true);
        });

        it('recognises equivalent path without ./ prefix', () => {
            expect(
                isToolGroupsPackageLast(['extensions/tool-groups'], AGENT_DIR),
            ).toBe(true);
        });

        it('recognises equivalent absolute path', () => {
            const absolutePath = join(AGENT_DIR, 'extensions/tool-groups');
            expect(isToolGroupsPackageLast([absolutePath], AGENT_DIR)).toBe(
                true,
            );
        });
    });

    describe('pinToolGroupsPackageLast', () => {
        it('absent → {changed:false, found:false}', async () => {
            const sm = SettingsManager.inMemory({
                packages: ['./extensions/other'],
            });
            const r = await pinToolGroupsPackageLast('.', AGENT_DIR, sm);
            expect(r).toEqual({ changed: false, found: false });
        });

        it('already last → {changed:false, found:true}', async () => {
            const sm = SettingsManager.inMemory({
                packages: ['./extensions/a', TOOL_GROUPS_PACKAGE_SOURCE],
            });
            const r = await pinToolGroupsPackageLast('.', AGENT_DIR, sm);
            expect(r).toEqual({ changed: false, found: true });
            expect(sm.getPackages()).toEqual([
                './extensions/a',
                TOOL_GROUPS_PACKAGE_SOURCE,
            ]);
        });

        it('reorders when tool-groups not last', async () => {
            const sm = SettingsManager.inMemory({
                packages: [TOOL_GROUPS_PACKAGE_SOURCE, './extensions/b'],
            });
            const r = await pinToolGroupsPackageLast('.', AGENT_DIR, sm);
            expect(r).toEqual({ changed: true, found: true });
            expect(sm.getPackages()).toEqual([
                './extensions/b',
                TOOL_GROUPS_PACKAGE_SOURCE,
            ]);
        });

        it('preserves exact object entry shape', async () => {
            const objEntry = {
                source: TOOL_GROUPS_PACKAGE_SOURCE,
                extensions: ['tool-groups.js'],
                skills: ['tool-groups'],
            };
            const sm = SettingsManager.inMemory({
                packages: [objEntry, './extensions/other'],
            });
            const r = await pinToolGroupsPackageLast('.', AGENT_DIR, sm);
            expect(r).toEqual({ changed: true, found: true });
            const pkgs = sm.getPackages();
            expect(pkgs).toHaveLength(2);
            expect(pkgs[1]).toEqual(objEntry);
        });

        it('recognises equivalent path (no ./ prefix)', async () => {
            const sm = SettingsManager.inMemory({
                packages: ['extensions/tool-groups', './extensions/other'],
            });
            const r = await pinToolGroupsPackageLast('.', AGENT_DIR, sm);
            expect(r).toEqual({ changed: true, found: true });
            expect(sm.getPackages()).toEqual([
                './extensions/other',
                'extensions/tool-groups',
            ]);
        });

        it('recognises equivalent absolute path', async () => {
            const absolutePath = join(AGENT_DIR, 'extensions/tool-groups');
            const sm = SettingsManager.inMemory({
                packages: [absolutePath, './extensions/other'],
            });
            const r = await pinToolGroupsPackageLast('.', AGENT_DIR, sm);
            expect(r).toEqual({ changed: true, found: true });
            expect(sm.getPackages()).toEqual([
                './extensions/other',
                absolutePath,
            ]);
        });

        it('idempotent: second call returns unchanged', async () => {
            const sm = SettingsManager.inMemory({
                packages: [TOOL_GROUPS_PACKAGE_SOURCE, './extensions/b'],
            });

            const r1 = await pinToolGroupsPackageLast('.', AGENT_DIR, sm);
            expect(r1).toEqual({ changed: true, found: true });

            const r2 = await pinToolGroupsPackageLast('.', AGENT_DIR, sm);
            expect(r2).toEqual({ changed: false, found: true });
        });

        it('works with file-backed settings (real temp dir)', async () => {
            const agentDir = mkdtempSync(join(tmpdir(), 'pkg-order-agent-'));
            const cwd = mkdtempSync(join(tmpdir(), 'pkg-order-cwd-'));

            mkdirSync(join(agentDir, 'extensions', 'tool-groups'), {
                recursive: true,
            });
            mkdirSync(join(agentDir, 'extensions', 'other'), {
                recursive: true,
            });

            writeFileSync(
                join(agentDir, 'settings.json'),
                JSON.stringify({
                    packages: [
                        TOOL_GROUPS_PACKAGE_SOURCE,
                        './extensions/other',
                    ],
                }),
            );

            const r = await pinToolGroupsPackageLast(cwd, agentDir);
            expect(r).toEqual({ changed: true, found: true });

            const sm = SettingsManager.create(cwd, agentDir);
            expect(sm.getPackages()).toEqual([
                './extensions/other',
                TOOL_GROUPS_PACKAGE_SOURCE,
            ]);
        });
    });
});
