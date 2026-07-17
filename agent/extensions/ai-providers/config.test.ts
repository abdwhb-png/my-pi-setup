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
});
