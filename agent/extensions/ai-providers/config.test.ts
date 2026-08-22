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
            {
                providers: {},
                widgets: {},
                cpa: { refreshTtlMs: 30_000, metadataRules: [] },
            },
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
                cpa: {
                    refreshTtlMs: 30_000,
                    silentCatalogDiff: true,
                    metadataRules: [],
                },
            },
            normalizeAiProvidersConfig({ providers: { cpa: true } }),
        );
        expect(merged.cpa.silentCatalogDiff).toBe(true);
    });

    test('accepts exact and glob CPA metadata rules', () => {
        expect(
            normalizeAiProvidersConfig({
                cpa: {
                    metadataRules: [
                        {
                            match: { id: 'gpt-5.6-*', ownedBy: 'openai' },
                            metadata: { reasoning: true },
                        },
                        {
                            match: { id: 'gpt-5.6-terra' },
                            metadata: {
                                contextWindow: 372_000,
                                maxTokens: 128_000,
                                input: ['text', 'image'],
                            },
                        },
                    ],
                },
            }),
        ).toEqual({
            providers: {},
            widgets: {},
            cpa: {
                metadataRules: [
                    {
                        match: { id: 'gpt-5.6-*', ownedBy: 'openai' },
                        metadata: { reasoning: true },
                    },
                    {
                        match: { id: 'gpt-5.6-terra' },
                        metadata: {
                            contextWindow: 372_000,
                            maxTokens: 128_000,
                            input: ['text', 'image'],
                        },
                    },
                ],
            },
        });
    });

    test('appends project metadata rules after global rules', () => {
        const global = mergeAiProvidersConfig(
            {
                providers: {},
                widgets: {},
                cpa: { refreshTtlMs: 30_000, metadataRules: [] },
            },
            normalizeAiProvidersConfig({
                cpa: {
                    metadataRules: [
                        {
                            match: { id: 'gpt-5.6-*' },
                            metadata: { reasoning: true },
                        },
                    ],
                },
            }),
        );
        const merged = mergeAiProvidersConfig(
            global,
            normalizeAiProvidersConfig({
                cpa: {
                    metadataRules: [
                        {
                            match: { id: 'gpt-5.6-terra' },
                            metadata: { contextWindow: 372_000 },
                        },
                    ],
                },
            }),
        );

        expect(merged.cpa.metadataRules).toEqual([
            {
                match: { id: 'gpt-5.6-*' },
                metadata: { reasoning: true },
            },
            {
                match: { id: 'gpt-5.6-terra' },
                metadata: { contextWindow: 372_000 },
            },
        ]);
    });

    test('drops malformed CPA metadata rules', () => {
        const normalized = normalizeAiProvidersConfig({
            cpa: {
                metadataRules: [
                    { match: { id: '' }, metadata: { contextWindow: 1 } },
                    { match: { id: 'valid' }, metadata: { maxTokens: 0 } },
                    {
                        match: { id: 'valid-owner', ownedBy: 42 },
                        metadata: { reasoning: true },
                    },
                    {
                        match: { id: 'valid-input' },
                        metadata: { input: ['image'] },
                    },
                    {
                        match: { id: 'valid-cost' },
                        metadata: { cost: { input: -1 } },
                    },
                ],
            },
        });

        expect(normalized.cpa?.metadataRules).toBeUndefined();
    });
});
