import { describe, expect, test } from 'bun:test';
import {
    mergeAiProvidersConfig,
    normalizeAiProvidersConfig,
} from './config.ts';

describe('normalizeAiProvidersConfig', () => {
    test('accepts a positive CPA refresh TTL', () => {
        expect(
            normalizeAiProvidersConfig({ cpa: { refreshTtlMs: 45_000 } }),
        ).toEqual({
            providers: {},
            widgets: {},
            cpa: { refreshTtlMs: 45_000 },
        });
    });

    test('preserves the global CPA TTL when project config omits CPA settings', () => {
        const global = mergeAiProvidersConfig(
            { providers: {}, widgets: {}, cpa: { refreshTtlMs: 30_000 } },
            normalizeAiProvidersConfig({ cpa: { refreshTtlMs: 45_000 } }),
        );
        const merged = mergeAiProvidersConfig(
            global,
            normalizeAiProvidersConfig({ providers: { cpa: true } }),
        );

        expect(merged.cpa.refreshTtlMs).toBe(45_000);
    });

    test('accepts a boolean cpa.silentCatalogDiff and defaults to false', () => {
        const normalized = normalizeAiProvidersConfig({
            cpa: { silentCatalogDiff: true },
        });
        expect(normalized.cpa?.silentCatalogDiff).toBe(true);
        expect(normalized.providers).toEqual({});
        expect(normalized.widgets).toEqual({});
    });
    test('ignores non-boolean cpa.silentCatalogDiff', () => {
        expect(
            normalizeAiProvidersConfig({
                cpa: { silentCatalogDiff: 'yes' },
            }).cpa?.silentCatalogDiff,
        ).toBeUndefined();
    });

    test('propagates silentCatalogDiff through mergeAiProvidersConfig', () => {
        const merged = mergeAiProvidersConfig(
            {
                providers: {},
                widgets: {},
                cpa: { refreshTtlMs: 30_000, silentCatalogDiff: true },
            },
            normalizeAiProvidersConfig({ providers: { cpa: true } }),
        );
        expect(merged.cpa.silentCatalogDiff).toBe(true);
    });

    // ── cpa.overridePrefixes (prefix → table-name map) ──

    test('accepts a prefix→table map for cpa.overridePrefixes', () => {
        const normalized = normalizeAiProvidersConfig({
            cpa: { overridePrefixes: { ocg: 'go', ogo: 'go', foo: 'foo' } },
        });
        expect(normalized.cpa?.overridePrefixes).toEqual({
            ocg: 'go',
            ogo: 'go',
            foo: 'foo',
        });
    });

    test('drops entries whose value is not a non-empty string', () => {
        const normalized = normalizeAiProvidersConfig({
            cpa: {
                overridePrefixes: {
                    ocg: 'go',
                    bad: '',
                    num: 42,
                    nul: null,
                    ok: 'foo',
                },
            },
        });
        expect(normalized.cpa?.overridePrefixes).toEqual({
            ocg: 'go',
            ok: 'foo',
        });
    });

    test('ignores non-object cpa.overridePrefixes', () => {
        expect(
            normalizeAiProvidersConfig({
                cpa: { overridePrefixes: 'ocg' },
            }).cpa?.overridePrefixes,
        ).toBeUndefined();
    });

    test('project overridePrefixes replaces (not merges) the global map', () => {
        const global = mergeAiProvidersConfig(
            {
                providers: {},
                widgets: {},
                cpa: {
                    refreshTtlMs: 30_000,
                    overridePrefixes: { ocg: 'go' },
                },
            },
            normalizeAiProvidersConfig({
                cpa: { overridePrefixes: { ogo: 'go' } },
            }),
        );
        expect(global.cpa.overridePrefixes).toEqual({ ogo: 'go' });
    });

    test('default config ships overridePrefixes { ocg: "go" }', () => {
        const merged = mergeAiProvidersConfig(
            {
                providers: {},
                widgets: {},
                cpa: {
                    refreshTtlMs: 30_000,
                    overridePrefixes: { ocg: 'go' },
                },
            },
            normalizeAiProvidersConfig({}),
        );
        expect(merged.cpa.overridePrefixes).toEqual({ ocg: 'go' });
    });
});
