import { describe, expect, it } from 'bun:test';
import {
    loadSaveTokensConfig,
    loadCompressorConfig,
    loadCavemanConfig,
    loadPonytailConfig,
    loadTelemetryConfig,
    normalizeConfig,
    normalizeTelemetry,
    resolveDefaultTelemetryDirectory,
} from './config';

describe('config loader', () => {
    it('returns fallback shape when SettingsManager unavailable', () => {
        // In test env, SettingsManager.create() throws, so we get fallback
        // from mergeConfig({}, {}).  The caveman config may have a defaultLevel
        // set in the user's real settings.json, so we only check compressor.
        const cfg = loadSaveTokensConfig();
        expect(cfg).toHaveProperty('compressor');
        expect(typeof cfg.compressor).toBe('object');
    });

    it('loadCompressorConfig returns non-null object', () => {
        const cfg = loadCompressorConfig();
        expect(typeof cfg).toBe('object');
        expect(cfg).not.toBeNull();
    });

    it('loadCavemanConfig returns non-null object', () => {
        const cfg = loadCavemanConfig();
        expect(typeof cfg).toBe('object');
        expect(cfg).not.toBeNull();
    });

    it('loadPonytailConfig returns non-null object', () => {
        const cfg = loadPonytailConfig();
        expect(typeof cfg).toBe('object');
        expect(cfg).not.toBeNull();
    });

    it('normalizes archive, cap, and summary granularity settings', () => {
        expect(
            normalizeConfig({
                compressor: {
                    archiveOriginal: true,
                    capFallbackBytes: 12000,
                    routingStrategy: 'benchmark',
                    summaryGranularity: 'agent',
                    ignored: 'nope',
                },
            }),
        ).toEqual({
            compressor: {
                archiveOriginal: true,
                capFallbackBytes: 12000,
                routingStrategy: 'benchmark',
                summaryGranularity: 'agent',
            },
        });
    });

    it('drops invalid compressor notification settings', () => {
        expect(
            normalizeConfig({
                compressor: {
                    archiveOriginal: 'yes',
                    capFallbackBytes: '12000',
                    routingStrategy: 'headroom',
                    summaryGranularity: 'session',
                },
            }),
        ).toEqual({});
    });

    it('normalizes ponytail enabled, defaultMode, and showStatus', () => {
        expect(
            normalizeConfig({
                ponytail: {
                    enabled: true,
                    defaultMode: 'ultra',
                    showStatus: false,
                    ignored: 'nope',
                },
            }),
        ).toEqual({
            ponytail: {
                enabled: true,
                defaultMode: 'ultra',
                showStatus: false,
            },
        });
    });

    it('drops invalid ponytail settings (non-boolean enabled, non-string mode)', () => {
        expect(
            normalizeConfig({
                ponytail: {
                    enabled: 'yes',
                    defaultMode: 42,
                    showStatus: 'true',
                },
            }),
        ).toEqual({});
    });

    it('drops invalid telemetry fields, falls back to defaults', () => {
        const cfg = normalizeConfig({
            telemetry: {
                enabled: 'yes',
                directory: 123,
                redactSecrets: 'no',
                retentionDays: '90',
                maxStringLength: -1,
                maxArrayItems: 0,
                maxDepth: Infinity,
            },
        });
        // Invalid fields are ignored; valid ones fall back to defaults
        expect(cfg.telemetry?.enabled).toBe(true);
        expect(cfg.telemetry?.directory).toBe(resolveDefaultTelemetryDirectory());
        expect(cfg.telemetry?.maxStringLength).toBe(10_000);
    });

    it('normalizes telemetry captureContent, redactSecrets, retentionDays, bounds', () => {
        expect(
            normalizeConfig({
                telemetry: {
                    enabled: true,
                    directory: '/tmp/telemetry',
                    captureContent: true,
                    redactSecrets: true,
                    retentionDays: 90,
                    maxStringLength: 5000,
                    maxArrayItems: 50,
                    maxDepth: 10,
                    ignored: 'nope',
                },
            }),
        ).toEqual({
            telemetry: {
                enabled: true,
                directory: '/tmp/telemetry',
                captureContent: true,
                redactSecrets: true,
                retentionDays: 90,
                maxStringLength: 5000,
                maxArrayItems: 50,
                maxDepth: 10,
            },
        });
    });
});

describe('telemetry config loader', () => {
    it('loadTelemetryConfig returns non-null object with defaults', () => {
        const cfg = loadTelemetryConfig();
        expect(cfg).toHaveProperty('enabled', true);
        expect(cfg).toHaveProperty('captureContent', true);
        expect(cfg).toHaveProperty('redactSecrets', true);
        expect(cfg).toHaveProperty('retentionDays', 90);
        expect(cfg).toHaveProperty('maxStringLength', 10_000);
        expect(cfg).toHaveProperty('maxArrayItems', 100);
        expect(cfg).toHaveProperty('maxDepth', 20);
        expect(cfg).toHaveProperty('directory', resolveDefaultTelemetryDirectory());
    });

    it('normalizeTelemetry produces defaults from empty input', () => {
        const cfg = normalizeTelemetry({});
        expect(cfg).toEqual({
            enabled: true,
            directory: resolveDefaultTelemetryDirectory(),
            captureContent: true,
            redactSecrets: true,
            retentionDays: 90,
            maxStringLength: 10_000,
            maxArrayItems: 100,
            maxDepth: 20,
        });
    });

    it('normalizeTelemetry rejects non-finite or non-positive numeric bounds', () => {
        // These should be ignored (fall back to defaults)
        const cfg = normalizeTelemetry({
            maxStringLength: -5,
            maxArrayItems: 0,
            maxDepth: Infinity,
        } as Record<string, unknown>);
        // Since invalid values are ignored, defaults apply
        expect(cfg).toEqual({
            enabled: true,
            directory: resolveDefaultTelemetryDirectory(),
            captureContent: true,
            redactSecrets: true,
            retentionDays: 90,
            maxStringLength: 10_000,
            maxArrayItems: 100,
            maxDepth: 20,
        });
    });

    it('rejects decimal values for maxStringLength', () => {
        const cfg = normalizeTelemetry({ maxStringLength: 1.5 });
        // isFinitePositive rejects non-integers
        expect(cfg.maxStringLength).toBe(10_000);
    });

    it('rejects float values for retentionDays', () => {
        const cfg = normalizeTelemetry({ retentionDays: 90.1 });
        // isFinitePositive rejects non-integers
        expect(cfg.retentionDays).toBe(90);
    });
});

describe('telemetry default directory', () => {
    it('resolveDefaultTelemetryDirectory returns path ending with save-tokens-telemetry', async () => {
        const mod = await import('./config');
        const dir = mod.resolveDefaultTelemetryDirectory();
        expect(dir.endsWith('.pi/agent/save-tokens-telemetry')).toBe(true);
        expect(dir).toContain('save-tokens-telemetry');
    });

    it('resolveDefaultTelemetryDirectory uses homedir portable resolution', async () => {
        const mod = await import('./config');
        const dir = mod.resolveDefaultTelemetryDirectory();
        // Must use os.homedir() or process.env.HOME, not hardcoded ~
        expect(dir).not.toContain('~');
        expect(dir).toContain('.pi/agent/save-tokens-telemetry');
    });
});
