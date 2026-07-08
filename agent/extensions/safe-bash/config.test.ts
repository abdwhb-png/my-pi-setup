import { describe, expect, it } from 'bun:test';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import {
    DEFAULT_SAFE_BASH_CONFIG,
    loadSafeBashConfig,
    normalizeSafeBashConfig,
    type SafeBashConfig,
} from './config';

const cwd = '/fake/cwd';

describe('normalizeSafeBashConfig', () => {
    it("accepts mode: 'replace'", () => {
        expect(normalizeSafeBashConfig({ mode: 'replace' })).toEqual({
            mode: 'replace',
        });
    });

    it("accepts mode: 'coexist'", () => {
        expect(normalizeSafeBashConfig({ mode: 'coexist' })).toEqual({
            mode: 'coexist',
        });
    });

    it('rejects unknown mode string', () => {
        expect(normalizeSafeBashConfig({ mode: 'delete-everything' })).toEqual(
            {},
        );
    });

    it('rejects non-string mode', () => {
        expect(normalizeSafeBashConfig({ mode: 42 })).toEqual({});
        expect(normalizeSafeBashConfig({ mode: true })).toEqual({});
    });

    it('rejects null / array / primitive', () => {
        expect(normalizeSafeBashConfig(null)).toEqual({});
        expect(normalizeSafeBashConfig([])).toEqual({});
        expect(normalizeSafeBashConfig('replace')).toEqual({});
    });

    it('ignores extra fields, keeps only mode', () => {
        expect(
            normalizeSafeBashConfig({ mode: 'replace', junk: 1, foo: 'x' }),
        ).toEqual({
            mode: 'replace',
        });
    });
});

describe('loadSafeBashConfig', () => {
    it("returns default 'coexist' when no settings", () => {
        const sm = SettingsManager.inMemory({} as any);
        const config = loadSafeBashConfig(cwd, undefined, sm);
        expect(config).toEqual(DEFAULT_SAFE_BASH_CONFIG);
        expect(config.mode).toBe('coexist');
    });

    it("reads mode: 'replace' from settings", () => {
        const sm = SettingsManager.inMemory({
            safeBash: { mode: 'replace' },
        } as any);
        const config = loadSafeBashConfig(cwd, undefined, sm);
        expect(config.mode).toBe('replace');
    });

    it("reads mode: 'coexist' from settings", () => {
        const sm = SettingsManager.inMemory({
            safeBash: { mode: 'coexist' },
        } as any);
        const config = loadSafeBashConfig(cwd, undefined, sm);
        expect(config.mode).toBe('coexist');
    });

    it('falls back to default when settings has invalid mode', () => {
        const sm = SettingsManager.inMemory({
            safeBash: { mode: 'nuke' },
        } as any);
        const config = loadSafeBashConfig(cwd, undefined, sm);
        expect(config.mode).toBe('coexist');
    });

    it('falls back to default when settings.safeBash is malformed', () => {
        const sm = SettingsManager.inMemory({
            safeBash: 'not-an-object',
        } as any);
        const config = loadSafeBashConfig(cwd, undefined, sm);
        expect(config.mode).toBe('coexist');
    });

    it('returns typed SafeBashConfig', () => {
        const sm = SettingsManager.inMemory({
            safeBash: { mode: 'replace' },
        } as any);
        const config: SafeBashConfig = loadSafeBashConfig(cwd, undefined, sm);
        expect(config.mode).toBe('replace');
    });
});
