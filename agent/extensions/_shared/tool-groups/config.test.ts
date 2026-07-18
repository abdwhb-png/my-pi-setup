import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { loadToolGroupsConfig } from './config.ts';
import type { ToolGroupsConfig } from './types.ts';

function tmpDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

function writeJson(path: string, data: unknown): void {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(data));
}

const EMPTY: ToolGroupsConfig = { groups: {} };

describe('loadToolGroupsConfig', () => {
    let agentDir: string;
    let cwd: string;

    beforeEach(() => {
        agentDir = tmpDir('tg-agent-');
        cwd = tmpDir('tg-cwd-');
    });

    afterEach(() => {
        try {
            rmSync(agentDir, { recursive: true });
        } catch {
            /* ignore */
        }
        try {
            rmSync(cwd, { recursive: true });
        } catch {
            /* ignore */
        }
    });

    // ── defaults ──────────────────────────────────────────

    it('returns empty groups when no config exists', () => {
        const cfg = loadToolGroupsConfig(cwd, { agentDir });
        expect(cfg).toEqual(EMPTY);
    });

    it('returns empty groups when sources array is empty', () => {
        const cfg = loadToolGroupsConfig(cwd, {
            agentDir,
            _settingsManager: SettingsManager.inMemory({} as any),
        });
        expect(cfg).toEqual(EMPTY);
    });

    // ── legacy file ───────────────────────────────────────

    it('loads global legacy tool-groups.json', () => {
        writeJson(join(agentDir, 'tool-groups.json'), {
            groups: { read: ['write', 'edit'] },
        });
        const cfg = loadToolGroupsConfig(cwd, { agentDir });
        expect(cfg.groups).toEqual({ read: ['write', 'edit'] });
    });

    it('merges project-local legacy over global legacy (deep merge)', () => {
        writeJson(join(agentDir, 'tool-groups.json'), {
            groups: { read: ['write'], base: ['grep'] },
        });
        writeJson(join(cwd, '.pi', 'tool-groups.json'), {
            groups: { read: ['edit', 'find'], extra: ['read'] },
        });
        const cfg = loadToolGroupsConfig(cwd, { agentDir });
        expect(cfg.groups).toEqual({
            read: ['edit', 'find'], // later replaces same key
            base: ['grep'],
            extra: ['read'],
        });
    });

    // ── settings.json ─────────────────────────────────────

    it('loads from settings.json key toolGroups', () => {
        const sm = SettingsManager.inMemory({
            toolGroups: { groups: { api: ['read', 'grep'] } },
        } as any);
        const cfg = loadToolGroupsConfig(cwd, { _settingsManager: sm });
        expect(cfg.groups).toEqual({ api: ['read', 'grep'] });
    });

    it('settings wins over legacy (cascade)', () => {
        writeJson(join(agentDir, 'tool-groups.json'), {
            groups: { from_legacy: ['write'] },
        });
        const sm = SettingsManager.inMemory({
            toolGroups: { groups: { from_settings: ['read'] } },
        } as any);
        const cfg = loadToolGroupsConfig(cwd, {
            agentDir,
            _settingsManager: sm,
        });
        // settings has data → legacy skipped entirely
        expect(cfg.groups).toEqual({ from_settings: ['read'] });
    });

    it('falls back to legacy when settings key is absent', () => {
        const sm = SettingsManager.inMemory({} as any);
        writeJson(join(agentDir, 'tool-groups.json'), {
            groups: { fallback: ['write'] },
        });
        const cfg = loadToolGroupsConfig(cwd, {
            agentDir,
            _settingsManager: sm,
        });
        expect(cfg.groups).toEqual({ fallback: ['write'] });
    });

    // ── normalization ─────────────────────────────────────

    it('drops groups with invalid names (not matching /^[a-z][a-z0-9_-]*$/)', () => {
        writeJson(join(agentDir, 'tool-groups.json'), {
            groups: {
                valid_group: ['write'],
                InvalidName: ['read'],
                '123abc': ['grep'],
                '': ['find'],
                'has spaces': ['edit'],
            },
        });
        const cfg = loadToolGroupsConfig(cwd, { agentDir });
        expect(cfg.groups).toEqual({ valid_group: ['write'] });
    });

    it('drops invalid members (non-string, empty, whitespace-only)', () => {
        writeJson(join(agentDir, 'tool-groups.json'), {
            groups: {
                tools: ['write', '', '  ', null, 42, 'read'],
            },
        });
        const cfg = loadToolGroupsConfig(cwd, { agentDir });
        expect(cfg.groups).toEqual({ tools: ['write', 'read'] });
    });

    it('trims whitespace from member names', () => {
        writeJson(join(agentDir, 'tool-groups.json'), {
            groups: {
                tools: ['  write  ', 'read'],
            },
        });
        const cfg = loadToolGroupsConfig(cwd, { agentDir });
        expect(cfg.groups).toEqual({ tools: ['write', 'read'] });
    });

    it('ignores non-object groups', () => {
        writeJson(join(agentDir, 'tool-groups.json'), {
            groups: {
                ok: ['write'],
                bad: 'string',
                alsoBad: 42,
                nullVal: null,
            },
        });
        const cfg = loadToolGroupsConfig(cwd, { agentDir });
        expect(cfg.groups).toEqual({ ok: ['write'] });
    });

    it('deep merge: later group array fully replaces same-key group', () => {
        // verified in the project-local test, but explicit:
        writeJson(join(agentDir, 'tool-groups.json'), {
            groups: { same: ['write', 'edit'] },
        });
        writeJson(join(cwd, '.pi', 'tool-groups.json'), {
            groups: { same: ['grep'] },
        });
        const cfg = loadToolGroupsConfig(cwd, { agentDir });
        expect(cfg.groups).toEqual({ same: ['grep'] }); // replaced, not merged
    });
});
