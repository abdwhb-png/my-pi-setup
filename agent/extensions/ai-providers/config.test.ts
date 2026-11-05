import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
    mergeAiProvidersConfig,
    normalizeAiProvidersConfig,
} from './config.ts';

describe('normalizeAiProvidersConfig', () => {
    test('the complete published example is accepted without silently dropping fields', () => {
        const example = JSON.parse(
            readFileSync(
                new URL(
                    '../../config/ai-providers.example.json',
                    import.meta.url,
                ),
                'utf8',
            ),
        );
        expect(normalizeAiProvidersConfig(example)).toEqual(example);
    });
    test('reads CPA settings from its provider entry', () => {
        const normalized = normalizeAiProvidersConfig({
            providers: {
                cpa: {
                    enabled: false,
                    baseUrl: ' https://proxy.example.test/v1 ',
                    refreshTtlMs: 45000,
                },
            },
        });
        expect(normalized.providers?.cpa).toEqual({
            enabled: false,
            baseUrl: 'https://proxy.example.test/v1',
            refreshTtlMs: 45000,
        });
    });

    test.each([
        { cpa: { refreshTtlMs: 30000 } },
        { providers: { cpa: true } },
        { providers: { cpa: { enabled: 'yes' } } },
        { providers: { cpa: { refreshTtlMs: 0 } } },
        {
            providers: {
                cpa: { baseUrl: 'https://user:password@example.test/v1' },
            },
        },
        { maxVisibleRows: 0 },
        { widgets: {} },
    ])(
        'rejects unsupported or invalid configuration without printing values (%#)',
        (raw) => {
            expect(() => normalizeAiProvidersConfig(raw)).toThrow(
                'ai-providers',
            );
        },
    );
    test('merges provider fields without losing endpoint or activation', () => {
        const global = mergeAiProvidersConfig(
            { providers: {} },
            normalizeAiProvidersConfig({
                providers: {
                    cpa: {
                        enabled: false,
                        baseUrl: 'https://proxy.example.test/v1',
                        refreshTtlMs: 45000,
                        silentCatalogDiff: true,
                    },
                },
            }),
        );
        const project = mergeAiProvidersConfig(
            global,
            normalizeAiProvidersConfig({
                providers: { cpa: { refreshTtlMs: 50000 } },
            }),
        );
        expect(project.providers.cpa).toEqual({
            enabled: false,
            baseUrl: 'https://proxy.example.test/v1',
            refreshTtlMs: 50000,
            silentCatalogDiff: true,
        });
    });

    test('accepts top-level modelRules with provider filter and Pi metadata', () => {
        const normalized = normalizeAiProvidersConfig({
            modelRules: [
                {
                    match: { id: 'ocg/*', provider: 'cpa', ownedBy: 'openai' },
                    metadata: {
                        thinkingLevelMap: { minimal: null, high: 'high' },
                        compat: { supportsDeveloperRole: false },
                        samplingParams: { temperature: 0.5 },
                        contextWindow: 1_000_000,
                    },
                },
                {
                    match: { id: '*deepseek*' },
                    metadata: { reasoning: true },
                },
            ],
        });

        expect(normalized.modelRules).toEqual([
            {
                match: { id: 'ocg/*', provider: 'cpa', ownedBy: 'openai' },
                metadata: {
                    thinkingLevelMap: { minimal: null, high: 'high' },
                    compat: { supportsDeveloperRole: false },
                    samplingParams: { temperature: 0.5 },
                    contextWindow: 1_000_000,
                },
            },
            {
                match: { id: '*deepseek*' },
                metadata: { reasoning: true },
            },
        ]);
    });

    test.each([
        {
            match: { id: 'fixture' },
            metadata: { contextWindow: 128000, maxTokens: 0 },
        },
        { match: { id: '' }, metadata: { contextWindow: 1 } },
        { match: { id: 'fixture' }, metadata: { maxTokens: 0 } },
        {
            match: { id: 'fixture', ownedBy: 42 },
            metadata: { reasoning: true },
        },
        { match: { id: 'fixture' }, metadata: { input: ['image'] } },
        { match: { id: 'fixture' }, metadata: { cost: { input: -1 } } },
    ])('rejects malformed modelRules (%#)', (rule) => {
        expect(() =>
            normalizeAiProvidersConfig({ modelRules: [rule] }),
        ).toThrow('modelRules[0]');
    });

    test('merges top-level modelRules from global and project config', () => {
        const global = mergeAiProvidersConfig(
            {
                providers: {},
                modelRules: [
                    {
                        match: { id: 'gpt-5.6-*' },
                        metadata: { reasoning: true },
                    },
                ],
            },
            {},
        );
        const merged = mergeAiProvidersConfig(
            global,
            normalizeAiProvidersConfig({
                modelRules: [
                    {
                        match: { id: 'gpt-5.6-terra' },
                        metadata: { contextWindow: 372_000 },
                    },
                ],
            }),
        );

        expect(merged.modelRules).toEqual([
            { match: { id: 'gpt-5.6-*' }, metadata: { reasoning: true } },
            {
                match: { id: 'gpt-5.6-terra' },
                metadata: { contextWindow: 372_000 },
            },
        ]);
    });
});
