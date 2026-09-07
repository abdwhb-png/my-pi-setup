import { describe, expect, it } from 'bun:test';
import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent';
import {
    applyModelRules,
    isExactRule,
    matchesGlob,
    matchesModelRule,
    mergeModelMetadata,
    normalizeModelRule,
    type ModelRule,
} from './model-rules.ts';

describe('matchesGlob', () => {
    it('matches exact strings', () => {
        expect(matchesGlob('gpt-5.6-terra', 'gpt-5.6-terra')).toBe(true);
        expect(matchesGlob('gpt-5.6-terra', 'gpt-5.6-sol')).toBe(false);
    });

    it('matches wildcard prefix, suffix, and infix', () => {
        expect(matchesGlob('gpt-5.6-*', 'gpt-5.6-terra')).toBe(true);
        expect(matchesGlob('*/go-glm-5.2', 'ocg/go-glm-5.2')).toBe(true);
        expect(matchesGlob('*deepseek*flash*', 'cpa/deepseek/deepseek-v4-flash-free')).toBe(true);
        expect(matchesGlob('gpt-5.6-*', 'gpt-5.5')).toBe(false);
    });

    it('matches question mark single character', () => {
        expect(matchesGlob('glm-5.?', 'glm-5.2')).toBe(true);
        expect(matchesGlob('glm-5.?', 'glm-5.22')).toBe(false);
    });
});

describe('isExactRule', () => {
    it('returns true when rule id contains no wildcards', () => {
        expect(isExactRule({ match: { id: 'gpt-5.6-terra' }, metadata: {} })).toBe(true);
    });

    it('returns false when rule id contains * or ?', () => {
        expect(isExactRule({ match: { id: 'gpt-5.6-*' }, metadata: {} })).toBe(false);
        expect(isExactRule({ match: { id: 'glm-5.?' }, metadata: {} })).toBe(false);
    });
});

describe('matchesModelRule', () => {
    it('matches when id matches and no provider is specified in rule', () => {
        const rule: ModelRule = { match: { id: 'gpt-5.6-*' }, metadata: {} };
        expect(matchesModelRule(rule, { id: 'gpt-5.6-terra', provider: 'cpa' })).toBe(true);
        expect(matchesModelRule(rule, { id: 'gpt-5.6-terra', provider: 'openrouter' })).toBe(true);
    });

    it('matches only when provider matches if rule specifies provider', () => {
        const rule: ModelRule = { match: { id: 'gpt-5.6-*', provider: 'cpa' }, metadata: {} };
        expect(matchesModelRule(rule, { id: 'gpt-5.6-terra', provider: 'cpa' })).toBe(true);
        expect(matchesModelRule(rule, { id: 'gpt-5.6-terra', provider: 'openrouter' })).toBe(false);
        expect(matchesModelRule(rule, { id: 'gpt-5.6-terra' })).toBe(false);
    });

    it('matches custom context fields like ownedBy', () => {
        const rule: ModelRule = { match: { id: 'gpt-5.6-*', ownedBy: 'openai' }, metadata: {} };
        expect(matchesModelRule(rule, { id: 'gpt-5.6-terra', ownedBy: 'openai' })).toBe(true);
        expect(matchesModelRule(rule, { id: 'gpt-5.6-terra', ownedBy: 'azure' })).toBe(false);
        expect(matchesModelRule(rule, { id: 'gpt-5.6-terra' })).toBe(false);
    });
});

describe('normalizeModelRule', () => {
    it('normalizes full Pi model metadata with passthrough', () => {
        const raw = {
            match: { id: 'ocg/*', provider: 'cpa', ownedBy: 'openai' },
            metadata: {
                thinkingLevelMap: {
                    off: null,
                    minimal: null,
                    low: 'low',
                    high: 'high',
                },
                compat: {
                    supportsDeveloperRole: false,
                    supportsStore: true,
                },
                samplingParams: {
                    temperature: 0.6,
                },
                headers: {
                    'x-custom-test': 'value',
                },
                contextWindow: 128_000,
                maxTokens: 32_768,
                reasoning: true,
                input: ['text', 'image'],
                cost: {
                    input: 1.5,
                    output: 5.0,
                    tiers: [
                        { inputTokensAbove: 200_000, input: 3.0, output: 10.0 },
                    ],
                },
                customFutureProperty: 'allowed',
            },
        };

        const rule = normalizeModelRule(raw);
        expect(rule).toBeDefined();
        expect(rule?.match.id).toBe('ocg/*');
        expect(rule?.match.provider).toBe('cpa');
        expect(rule?.match.ownedBy).toBe('openai');
        expect(rule?.metadata.thinkingLevelMap).toEqual({
            off: null,
            minimal: null,
            low: 'low',
            high: 'high',
        });
        expect(rule?.metadata.compat).toEqual({
            supportsDeveloperRole: false,
            supportsStore: true,
        });
        expect(rule?.metadata.samplingParams).toEqual({ temperature: 0.6 });
        expect(rule?.metadata.headers).toEqual({ 'x-custom-test': 'value' });
        expect(rule?.metadata.cost?.tiers).toEqual([
            { inputTokensAbove: 200_000, input: 3.0, output: 10.0, cacheRead: 0, cacheWrite: 0 },
        ]);
        expect(rule?.metadata.customFutureProperty).toBe('allowed');
    });

    it('returns undefined when match is missing id or metadata is empty', () => {
        expect(normalizeModelRule({ match: {}, metadata: { reasoning: true } })).toBeUndefined();
        expect(normalizeModelRule({ match: { id: 'test' }, metadata: {} })).toBeUndefined();
        expect(normalizeModelRule(null)).toBeUndefined();
    });
});

describe('mergeModelMetadata', () => {
    const baseModel: ProviderModelConfig = {
        id: 'ocg/go-glm-5.2',
        name: 'GLM 5.2 (Go)',
        api: 'openai-completions',
        baseUrl: 'http://localhost:8080/v1',
        reasoning: false,
        input: ['text'],
        contextWindow: 128_000,
        maxTokens: 32_768,
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
        compat: { supportsDeveloperRole: false },
        thinkingLevelMap: { low: 'low', high: 'medium' },
    };

    it('deep-merges thinkingLevelMap', () => {
        const merged = mergeModelMetadata(baseModel, {
            thinkingLevelMap: { minimal: null, high: 'high' },
        });
        expect(merged.thinkingLevelMap).toEqual({
            low: 'low',
            high: 'high',
            minimal: null,
        });
    });

    it('deep-merges compat and samplingParams', () => {
        // SAFETY: samplingParams is part of pi-ai Model<Api> and supported at runtime by Pi provider composer even if omitted from ProviderModelConfig.
        const merged = mergeModelMetadata(baseModel, {
            compat: { supportsDeveloperRole: true, supportsStore: false },
            samplingParams: { temperature: 0.7 },
        }) as ProviderModelConfig & { samplingParams?: Record<string, unknown> };
        expect(merged.compat).toEqual({
            supportsDeveloperRole: true,
            supportsStore: false,
        });
        expect(merged.samplingParams).toEqual({ temperature: 0.7 });
    });

    it('merges cost rates and tiers', () => {
        const merged = mergeModelMetadata(baseModel, {
            cost: {
                input: 2.5,
                tiers: [{ inputTokensAbove: 100_000, input: 5, output: 10, cacheRead: 0, cacheWrite: 0 }],
            },
        });
        expect(merged.cost.input).toBe(2.5);
        expect(merged.cost.output).toBe(2);
        expect(merged.cost.tiers).toEqual([{ inputTokensAbove: 100_000, input: 5, output: 10, cacheRead: 0, cacheWrite: 0 }]);
    });

    it('preserves extra passthrough metadata', () => {
        const merged = mergeModelMetadata(baseModel, {
            arbitraryField: 'passed-through',
        }) as ProviderModelConfig & { arbitraryField?: string };
        expect(merged.arbitraryField).toBe('passed-through');
    });
});

describe('applyModelRules', () => {
    const baseModel: ProviderModelConfig = {
        id: 'gpt-5.6-terra',
        name: 'GPT 5.6 Terra',
        api: 'openai-completions',
        baseUrl: 'http://localhost:8080/v1',
        reasoning: true,
        input: ['text'],
        contextWindow: 128_000,
        maxTokens: 32_768,
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    };

    it('applies non-exact rules first, then exact rules', () => {
        const rules: ModelRule[] = [
            {
                match: { id: 'gpt-5.6-terra' }, // exact
                metadata: { maxTokens: 99_000 },
            },
            {
                match: { id: 'gpt-5.6-*' }, // glob
                metadata: { maxTokens: 50_000, contextWindow: 200_000 },
            },
        ];

        // Even though exact rule was listed first, glob is non-exact so exact should win for maxTokens
        const result = applyModelRules(baseModel, rules, { provider: 'cpa' });
        expect(result.contextWindow).toBe(200_000);
        expect(result.maxTokens).toBe(99_000);
    });

    it('skips rules that do not match provider or context', () => {
        const rules: ModelRule[] = [
            {
                match: { id: 'gpt-5.6-*', provider: 'openrouter' },
                metadata: { maxTokens: 10_000 },
            },
            {
                match: { id: 'gpt-5.6-*', ownedBy: 'other-org' },
                metadata: { maxTokens: 20_000 },
            },
        ];

        const result = applyModelRules(baseModel, rules, { provider: 'cpa', ownedBy: 'openai' });
        expect(result.maxTokens).toBe(32_768);
    });
});
