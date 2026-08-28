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

    // --- guardPolicy ---

    it('accepts ask, deny, and allow policies for known danger groups', () => {
        expect(
            normalizeSafeBashConfig({
                guardPolicy: { sudo: 'allow', rm: 'ask', mkfs: 'deny' },
            }),
        ).toEqual({
            guardPolicy: { sudo: 'allow', rm: 'ask', mkfs: 'deny' },
        });
    });

    it('drops invalid policies and unknown danger groups', () => {
        expect(
            normalizeSafeBashConfig({
                guardPolicy: {
                    sudo: 'allow',
                    rm: true,
                    mkfs: 'prompt',
                    unknown: 'deny',
                },
            }),
        ).toEqual({ guardPolicy: { sudo: 'allow' } });
    });

    it('rejects malformed guardPolicy values', () => {
        expect(normalizeSafeBashConfig({ guardPolicy: ['sudo'] })).toEqual({});
        expect(normalizeSafeBashConfig({ guardPolicy: 'allow' })).toEqual({});
        expect(normalizeSafeBashConfig({ guardPolicy: null })).toEqual({});
    });

    it('ignores removed allowDangerous configuration', () => {
        expect(
            normalizeSafeBashConfig({ allowDangerous: { sudo: true } }),
        ).toEqual({});
    });

    it('preserves mode, allowedShellCommands, and guardPolicy together', () => {
        expect(
            normalizeSafeBashConfig({
                mode: 'replace',
                allowedShellCommands: ['grep'],
                guardPolicy: { sudo: 'allow' },
            }),
        ).toEqual({
            mode: 'replace',
            allowedShellCommands: ['grep'],
            guardPolicy: { sudo: 'allow' },
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

    it('defaults guardPolicy to empty object (deny by default)', () => {
        const sm = SettingsManager.inMemory({} as any);
        const config = loadSafeBashConfig(cwd, undefined, sm);
        expect(config.guardPolicy).toEqual({});
    });

    it('defaults telemetry to a bounded local archive', () => {
        const sm = SettingsManager.inMemory({} as any);
        const config = loadSafeBashConfig(cwd, undefined, sm);
        expect(config.telemetry).toEqual({
            enabled: true,
            directory: '~/.pi/agent/safe-bash-telemetry',
            retentionDays: 30,
            captureCommand: true,
            maxCommandLength: 10_000,
            auditDays: 30,
            auditLimit: 100,
        });
    });

    it('merges partial telemetry settings over telemetry defaults', () => {
        const sm = SettingsManager.inMemory({
            safeBash: { telemetry: { auditDays: 7 } },
        } as any);
        const config = loadSafeBashConfig(cwd, undefined, sm);

        expect(config.telemetry).toEqual({
            ...DEFAULT_SAFE_BASH_CONFIG.telemetry,
            auditDays: 7,
        });
    });

    it('normalizes valid telemetry overrides and rejects invalid bounds', () => {
        expect(
            normalizeSafeBashConfig({
                telemetry: {
                    enabled: false,
                    directory: '/tmp/safe-bash-audit',
                    retentionDays: 14,
                    captureCommand: false,
                    maxCommandLength: 2_000,
                    auditDays: 7,
                    auditLimit: 25,
                },
            }),
        ).toEqual({
            telemetry: {
                enabled: false,
                directory: '/tmp/safe-bash-audit',
                retentionDays: 14,
                captureCommand: false,
                maxCommandLength: 2_000,
                auditDays: 7,
                auditLimit: 25,
            },
        });

        expect(
            normalizeSafeBashConfig({
                telemetry: {
                    retentionDays: 0,
                    maxCommandLength: -1,
                    auditDays: 366,
                    auditLimit: 501,
                },
            }),
        ).toEqual({});
    });

    it('reads guardPolicy from settings', () => {
        const sm = SettingsManager.inMemory({
            safeBash: { guardPolicy: { sudo: 'allow', rm: 'ask' } },
        } as any);
        const config = loadSafeBashConfig(cwd, undefined, sm);
        expect(config.guardPolicy).toEqual({ sudo: 'allow', rm: 'ask' });
    });
});
