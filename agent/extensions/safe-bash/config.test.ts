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

    // --- allowedShellCommands ---

    it('accepts allowedShellCommands as string array', () => {
        expect(
            normalizeSafeBashConfig({
                allowedShellCommands: ['grep', 'find'],
            }),
        ).toEqual({
            allowedShellCommands: ['grep', 'find'],
        });
    });

    it('filters non-string entries from allowedShellCommands', () => {
        expect(
            normalizeSafeBashConfig({
                allowedShellCommands: ['grep', 42, null, 'find', true],
            } as any),
        ).toEqual({
            allowedShellCommands: ['grep', 'find'],
        });
    });

    it('rejects allowedShellCommands that is not an array', () => {
        expect(
            normalizeSafeBashConfig({ allowedShellCommands: 'grep' } as any),
        ).toEqual({});
        expect(
            normalizeSafeBashConfig({ allowedShellCommands: null } as any),
        ).toEqual({});
        expect(
            normalizeSafeBashConfig({ allowedShellCommands: {} } as any),
        ).toEqual({});
    });

    it('drops allowedShellCommands when array is empty', () => {
        expect(normalizeSafeBashConfig({ allowedShellCommands: [] })).toEqual(
            {},
        );
    });

    it('preserves both mode and allowedShellCommands', () => {
        expect(
            normalizeSafeBashConfig({
                mode: 'replace',
                allowedShellCommands: ['grep'],
            }),
        ).toEqual({
            mode: 'replace',
            allowedShellCommands: ['grep'],
        });
    });

    // --- allowDangerous ---

    it('accepts allowDangerous as a boolean map of true values', () => {
        expect(
            normalizeSafeBashConfig({
                allowDangerous: { sudo: true, rm: true },
            }),
        ).toEqual({
            allowDangerous: { sudo: true, rm: true },
        });
    });

    it('drops allowDangerous entries whose value is not exactly true', () => {
        expect(
            normalizeSafeBashConfig({
                allowDangerous: {
                    sudo: true,
                    rm: false,
                    mkfs: 'yes',
                    dd: 1,
                    sudo2: null,
                } as any,
            }),
        ).toEqual({
            allowDangerous: { sudo: true },
        });
    });

    it('rejects allowDangerous that is not an object', () => {
        expect(
            normalizeSafeBashConfig({ allowDangerous: ['sudo'] } as any),
        ).toEqual({});
        expect(
            normalizeSafeBashConfig({ allowDangerous: 'sudo' } as any),
        ).toEqual({});
        expect(
            normalizeSafeBashConfig({ allowDangerous: null } as any),
        ).toEqual({});
    });

    it('drops allowDangerous when object has no true entries', () => {
        expect(
            normalizeSafeBashConfig({ allowDangerous: {} }),
        ).toEqual({});
        expect(
            normalizeSafeBashConfig({ allowDangerous: { sudo: false } }),
        ).toEqual({});
    });

    it('preserves mode, allowedShellCommands, and allowDangerous together', () => {
        expect(
            normalizeSafeBashConfig({
                mode: 'replace',
                allowedShellCommands: ['grep'],
                allowDangerous: { sudo: true },
            }),
        ).toEqual({
            mode: 'replace',
            allowedShellCommands: ['grep'],
            allowDangerous: { sudo: true },
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

    it('defaults allowedShellCommands to empty array', () => {
        const sm = SettingsManager.inMemory({} as any);
        const config = loadSafeBashConfig(cwd, undefined, sm);
        expect(config.allowedShellCommands).toEqual([]);
    });

    it('reads allowedShellCommands from settings', () => {
        const sm = SettingsManager.inMemory({
            safeBash: { allowedShellCommands: ['grep', 'rg'] },
        } as any);
        const config = loadSafeBashConfig(cwd, undefined, sm);
        expect(config.allowedShellCommands).toEqual(['grep', 'rg']);
    });

    it('defaults allowDangerous to empty object', () => {
        const sm = SettingsManager.inMemory({} as any);
        const config = loadSafeBashConfig(cwd, undefined, sm);
        expect(config.allowDangerous).toEqual({});
    });

    it('reads allowDangerous from settings', () => {
        const sm = SettingsManager.inMemory({
            safeBash: { allowDangerous: { sudo: true, rm: true } },
        } as any);
        const config = loadSafeBashConfig(cwd, undefined, sm);
        expect(config.allowDangerous).toEqual({ sudo: true, rm: true });
    });
});
