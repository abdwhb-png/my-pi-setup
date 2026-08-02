import { describe, expect, it } from 'bun:test';
import type { ModelsDevRef } from './catalog';
import {
    resolveCpaModelsDevRefs,
    resolveFactoryModelsDevRefs,
    resolveUsageModelsDevRefs,
} from './mapping';

const providerRef = (providerId: string, modelId: string): ModelsDevRef => ({
    scope: 'provider',
    providerId,
    modelId,
});

const baseRef = (modelId: string): ModelsDevRef => ({ scope: 'model', modelId });

describe('resolveCpaModelsDevRefs', () => {
    it('maps live OpenRouter ids for the OpenRouter owner with base ref fallback', () => {
        const cases: Array<[string, ModelsDevRef[]]> = [
            [
                'deepseek/deepseek-v4-flash',
                [
                    providerRef('openrouter', 'deepseek/deepseek-v4-flash'),
                    baseRef('deepseek/deepseek-v4-flash'),
                ],
            ],
            [
                'deepseek/deepseek-v4-flash:free',
                [
                    providerRef('openrouter', 'deepseek/deepseek-v4-flash:free'),
                    baseRef('deepseek/deepseek-v4-flash:free'),
                ],
            ],
            [
                'nvidia/nemotron-3-ultra-550b-a55b:free',
                [
                    providerRef('openrouter', 'nvidia/nemotron-3-ultra-550b-a55b:free'),
                    baseRef('nvidia/nemotron-3-ultra-550b-a55b:free'),
                ],
            ],
        ];
        for (const [modelId, expected] of cases) {
            expect(resolveCpaModelsDevRefs(modelId, 'openrouter'), modelId).toEqual(
                expected,
            );
        }
    });

    it('maps ocg/go-<id> to provider opencode-go when owned_by begins with ocode-go', () => {
        const cases: Array<[string, string, ModelsDevRef[]]> = [
            [
                'ocg/go-deepseek-v4-flash',
                'ocode-go (main)',
                [providerRef('opencode-go', 'deepseek-v4-flash')],
            ],
            [
                'ocg/go-glm-5.2',
                'ocode-go (2nd)',
                [providerRef('opencode-go', 'glm-5.2')],
            ],
            [
                'ocg/go-deepseek-v4-pro',
                'ocode-go',
                [providerRef('opencode-go', 'deepseek-v4-pro')],
            ],
        ];
        for (const [modelId, ownedBy, expected] of cases) {
            expect(
                resolveCpaModelsDevRefs(modelId, ownedBy),
                `${ownedBy}/${modelId}`,
            ).toEqual(expected);
        }
    });

    it('keeps bare go- duplicates unmapped', () => {
        expect(resolveCpaModelsDevRefs('go-deepseek-v4-flash', 'ocode-go (main)')).toEqual([]);
        expect(resolveCpaModelsDevRefs('go-glm-5.2', 'ocode-go')).toEqual([]);
        expect(resolveCpaModelsDevRefs('go-deepseek-v4-flash')).toEqual([]);
    });

    it('does not infer a provider when owned_by is unknown or missing', () => {
        expect(
            resolveCpaModelsDevRefs('deepseek/deepseek-v4-flash', 'mystery-provider'),
        ).toEqual([]);
        expect(resolveCpaModelsDevRefs('glm-unknown', 'mystery-provider')).toEqual([]);
        expect(resolveCpaModelsDevRefs('unknown-bare-id', 'mystery-provider')).toEqual([]);
        expect(resolveUsageModelsDevRefs('cpa', 'glm-unknown')).toEqual([]);
        expect(resolveUsageModelsDevRefs('cpa', 'unknown-bare-id')).toEqual([]);
    });

    it('maps ocg/go- ids by prefix even when owned_by is absent', () => {
        expect(resolveCpaModelsDevRefs('ocg/go-deepseek-v4-flash')).toEqual([
            providerRef('opencode-go', 'deepseek-v4-flash'),
        ]);
    });

    it('maps live OpenAI ids by owner and known historical ids with base ref fallback', () => {
        const cases: Array<[string, ModelsDevRef[]]> = [
            [
                'gpt-5.4',
                [providerRef('openai', 'gpt-5.4'), baseRef('openai/gpt-5.4')],
            ],
            [
                'gpt-5.4-mini',
                [providerRef('openai', 'gpt-5.4-mini'), baseRef('openai/gpt-5.4-mini')],
            ],
            [
                'gpt-5.5',
                [providerRef('openai', 'gpt-5.5'), baseRef('openai/gpt-5.5')],
            ],
            ['codex-auto-review', []],
        ];
        for (const [modelId, expected] of cases) {
            expect(resolveCpaModelsDevRefs(modelId, 'openai'), `live:${modelId}`).toEqual(
                expected,
            );
            expect(resolveUsageModelsDevRefs('cpa', modelId), `usage:${modelId}`).toEqual(
                expected,
            );
        }
    });

    it('maps Z.ai client ids by owner and exact historical conventions', () => {
        for (const modelId of ['glm-4.7', 'glm-5.2', 'glm-5-turbo']) {
            const expected = [providerRef('zai-coding-plan', modelId)];
            expect(
                resolveCpaModelsDevRefs(modelId, 'z.ai (coding)'),
                `live:${modelId}`,
            ).toEqual(expected);
            expect(resolveUsageModelsDevRefs('cpa', modelId), `usage:${modelId}`).toEqual(
                expected,
            );
            expect(
                resolveCpaModelsDevRefs(`zai-coding/${modelId}`, 'z.ai (coding)'),
                `prefixed:${modelId}`,
            ).toEqual(expected);
        }
    });

    it('maps ocz ids to provider opencode, stripping the exact prefix and retaining -free', () => {
        const cases: Array<[string, ModelsDevRef[]]> = [
            [
                'ocz/deepseek-v4-flash-free',
                [providerRef('opencode', 'deepseek-v4-flash-free')],
            ],
            [
                'ocz/nemotron-3-ultra-550b-a55b',
                [providerRef('opencode', 'nemotron-3-ultra-550b-a55b')],
            ],
        ];
        for (const [modelId, expected] of cases) {
            expect(resolveCpaModelsDevRefs(modelId, 'ocode-zen (free)'), modelId).toEqual(
                expected,
            );
            expect(resolveUsageModelsDevRefs('cpa', modelId), `usage:${modelId}`).toEqual(
                expected,
            );
        }
    });

    it('maps exactly the nine live Antigravity client ids', () => {
        const cases: Array<[string, string]> = [
            ['claude-opus-4-6-thinking', 'anthropic/claude-opus-4-6'],
            ['claude-sonnet-4-6', 'anthropic/claude-sonnet-4-6'],
            ['gemini-3.1-flash-image', 'google/gemini-3.1-flash-image'],
            ['gemini-3.1-flash-lite', 'google/gemini-3.1-flash-lite'],
            ['gemini-3.1-pro-preview', 'google/gemini-3.1-pro-preview'],
            ['gemini-3.5-flash', 'google/gemini-3.5-flash'],
            ['gemini-3.6-flash', 'google/gemini-3.6-flash'],
            ['gemini-3-flash-preview', 'google/gemini-3-flash-preview'],
            ['gpt-oss-120b-medium', 'openai/gpt-oss-120b'],
        ];
        for (const [modelId, base] of cases) {
            const expected = [baseRef(base)];
            expect(
                resolveCpaModelsDevRefs(modelId, 'antigravity'),
                `live:${modelId}`,
            ).toEqual(expected);
            expect(resolveUsageModelsDevRefs('cpa', modelId), `usage:${modelId}`).toEqual(
                expected,
            );
        }
    });

    it('does not map hidden or excluded Antigravity ids', () => {
        for (const modelId of [
            'gemini-3.6-flash-high',
            'gemini-3-flash-agent',
            'gemini-pro-agent',
            'gemini-3-flash',
            'gemini-3.1-pro-low',
            'gemini-3.5-flash-low',
            'gemini-3.5-flash-extra-low',
            'gemini-3.5-flash-lite',
        ]) {
            expect(resolveCpaModelsDevRefs(modelId, 'antigravity'), modelId).toEqual([]);
            expect(resolveUsageModelsDevRefs('cpa', modelId), `usage:${modelId}`).toEqual(
                [],
            );
        }
    });

    it('skips or/-prefixed pool aliases', () => {
        expect(resolveCpaModelsDevRefs('or/deepseek-v4-flash')).toEqual([]);
    });

    it('returns no candidates for empty or whitespace ids', () => {
        expect(resolveCpaModelsDevRefs('')).toEqual([]);
        expect(resolveCpaModelsDevRefs('   ')).toEqual([]);
        expect(resolveCpaModelsDevRefs('', 'ocode-go')).toEqual([]);
    });

    it('returns no candidates for malformed prefixed ids with empty suffixes', () => {
        expect(resolveCpaModelsDevRefs('ocg/go-')).toEqual([]);
        expect(resolveCpaModelsDevRefs('ocg/go-', 'ocode-go')).toEqual([]);
        expect(resolveCpaModelsDevRefs('zai-coding/')).toEqual([]);
        expect(resolveCpaModelsDevRefs('ocz/')).toEqual([]);
        expect(resolveCpaModelsDevRefs('ocg/go-   ')).toEqual([]);
    });
});

describe('resolveFactoryModelsDevRefs', () => {
    it('maps anthropic, openai, and google to provider+base refs', () => {
        const cases: Array<[string, string, ModelsDevRef[]]> = [
            [
                'anthropic', 'claude-sonnet-4-6',
                [providerRef('anthropic', 'claude-sonnet-4-6'), baseRef('anthropic/claude-sonnet-4-6')],
            ],
            [
                'anthropic', 'claude-fable-5',
                [providerRef('anthropic', 'claude-fable-5'), baseRef('anthropic/claude-fable-5')],
            ],
            [
                'openai', 'gpt-5.4',
                [providerRef('openai', 'gpt-5.4'), baseRef('openai/gpt-5.4')],
            ],
            [
                'openai', 'o3-mini',
                [providerRef('openai', 'o3-mini'), baseRef('openai/o3-mini')],
            ],
            [
                'google', 'gemini-3-flash-preview',
                [providerRef('google', 'gemini-3-flash-preview'), baseRef('google/gemini-3-flash-preview')],
            ],
            [
                'google', 'gemini-2.5-flash',
                [providerRef('google', 'gemini-2.5-flash'), baseRef('google/gemini-2.5-flash')],
            ],
        ];
        for (const [modelProvider, modelId, expected] of cases) {
            expect(
                resolveFactoryModelsDevRefs(modelProvider, modelId),
                `${modelProvider}/${modelId}`,
            ).toEqual(expected);
        }
    });

    it('maps factory-owned ids to their exact base refs', () => {
        const cases: Array<[string, string]> = [
            ['glm-5.2', 'zhipuai/glm-5.2'],
            ['glm-5.1', 'zhipuai/glm-5.1'],
            ['kimi-k2.7-code', 'moonshotai/kimi-k2.7-code'],
            ['kimi-k2.6', 'moonshotai/kimi-k2.6'],
            ['kimi-k2.5', 'moonshotai/kimi-k2.5'],
            ['deepseek-v4-pro', 'deepseek/deepseek-v4-pro'],
        ];
        for (const [modelId, base] of cases) {
            expect(resolveFactoryModelsDevRefs('factory', modelId), modelId).toEqual([
                baseRef(base),
            ]);
        }
    });

    it('leaves factory family ids without a base unmapped', () => {
        for (const modelId of [
            'nemotron-3-ultra',
            'minimax-m3',
            'minimax-m2.7',
            'minimax-m2.5',
            'glm-4.7',
            'unknown-model',
        ]) {
            expect(resolveFactoryModelsDevRefs('factory', modelId), modelId).toEqual([]);
        }
    });

    it('leaves unknown, empty, or non-listed model providers unmapped', () => {
        const cases: Array<[string, string]> = [
            ['', 'glm-5.2'],
            ['xai', 'grok-4'],
            ['voyage', 'voyage-3'],
            ['generic-chat-completion-api', 'glm-5.2'],
            ['unknown-provider', 'gpt-5.4'],
            ['factory', ''],
        ];
        for (const [modelProvider, modelId] of cases) {
            expect(
                resolveFactoryModelsDevRefs(modelProvider, modelId),
                `${modelProvider}/${modelId}`,
            ).toEqual([]);
        }
    });
});

describe('resolveUsageModelsDevRefs', () => {
    it('maps ordinary openrouter, openai, anthropic, and google providers with base ref fallback', () => {
        const cases: Array<[string, string, ModelsDevRef[]]> = [
            [
                'openrouter',
                'deepseek/deepseek-v4-flash',
                [
                    providerRef('openrouter', 'deepseek/deepseek-v4-flash'),
                    baseRef('deepseek/deepseek-v4-flash'),
                ],
            ],
            [
                'openrouter',
                'deepseek/deepseek-v4-flash:free',
                [
                    providerRef('openrouter', 'deepseek/deepseek-v4-flash:free'),
                    baseRef('deepseek/deepseek-v4-flash:free'),
                ],
            ],
            [
                'openai', 'gpt-5.4',
                [providerRef('openai', 'gpt-5.4'), baseRef('openai/gpt-5.4')],
            ],
            [
                'anthropic', 'claude-sonnet-4-6',
                [providerRef('anthropic', 'claude-sonnet-4-6'), baseRef('anthropic/claude-sonnet-4-6')],
            ],
            [
                'google', 'gemini-3-flash-preview',
                [providerRef('google', 'gemini-3-flash-preview'), baseRef('google/gemini-3-flash-preview')],
            ],
        ];
        for (const [providerId, modelId, expected] of cases) {
            expect(
                resolveUsageModelsDevRefs(providerId, modelId),
                `${providerId}/${modelId}`,
            ).toEqual(expected);
        }
    });

    it('delegates cpa to the exact prefix and alias rules without owned_by', () => {
        const cases: Array<[string, ModelsDevRef[]]> = [
            ['ocg/go-deepseek-v4-flash', [providerRef('opencode-go', 'deepseek-v4-flash')]],
            ['go-deepseek-v4-flash', []],
            [
                'deepseek/deepseek-v4-flash',
                [
                    providerRef('openrouter', 'deepseek/deepseek-v4-flash'),
                    baseRef('deepseek/deepseek-v4-flash'),
                ],
            ],
            [
                'deepseek/deepseek-v4-flash:free',
                [
                    providerRef('openrouter', 'deepseek/deepseek-v4-flash:free'),
                    baseRef('deepseek/deepseek-v4-flash:free'),
                ],
            ],
            ['zai-coding/glm-5.2', [providerRef('zai-coding-plan', 'glm-5.2')]],
            ['glm-5.2', [providerRef('zai-coding-plan', 'glm-5.2')]],
            ['ocz/deepseek-v4-flash-free', [providerRef('opencode', 'deepseek-v4-flash-free')]],
            ['claude-sonnet-4-6', [baseRef('anthropic/claude-sonnet-4-6')]],
            ['codex-auto-review', []],
            ['ocg/go-', []],
            ['zai-coding/', []],
            ['ocz/', []],
        ];
        for (const [modelId, expected] of cases) {
            expect(resolveUsageModelsDevRefs('cpa', modelId), modelId).toEqual(expected);
        }
    });

    it('maps factory-ai only through the explicit factory-owned base map', () => {
        const cases: Array<[string, ModelsDevRef[]]> = [
            ['glm-5.2', [baseRef('zhipuai/glm-5.2')]],
            ['glm-5.1', [baseRef('zhipuai/glm-5.1')]],
            ['kimi-k2.7-code', [baseRef('moonshotai/kimi-k2.7-code')]],
            ['kimi-k2.6', [baseRef('moonshotai/kimi-k2.6')]],
            ['kimi-k2.5', [baseRef('moonshotai/kimi-k2.5')]],
            ['deepseek-v4-pro', [baseRef('deepseek/deepseek-v4-pro')]],
            ['nemotron-3-ultra', []],
            ['minimax-m3', []],
            ['minimax-m2.7', []],
            ['minimax-m2.5', []],
            ['claude-sonnet-4-6', []],
            ['gpt-5.4', []],
        ];
        for (const [modelId, expected] of cases) {
            expect(resolveUsageModelsDevRefs('factory-ai', modelId), modelId).toEqual(expected);
        }
    });

    it('maps observed historical factory-ai route identities exactly', () => {
        const cases: Array<[string, ModelsDevRef[]]> = [
            ['deepseek/deepseek-v4-pro', [baseRef('deepseek/deepseek-v4-pro')]],
            ['deepseek/deepseek-v4-flash', [baseRef('deepseek/deepseek-v4-flash')]],
            ['gpt-5.5', [providerRef('openai', 'gpt-5.5')]],
            ['gemini-3-flash-preview', [providerRef('google', 'gemini-3-flash-preview')]],
            [
                'google/gemma-4-31b-it:free',
                [providerRef('openrouter', 'google/gemma-4-31b-it:free')],
            ],
            [
                'qwen/qwen3.6-plus-preview:free',
                [providerRef('openrouter', 'qwen/qwen3.6-plus-preview:free')],
            ],
        ];
        for (const [modelId, expected] of cases) {
            expect(resolveUsageModelsDevRefs('factory-ai', modelId), modelId).toEqual(expected);
        }
    });

    it('maps openai-codex to openai provider with exact model id', () => {
        const cases: Array<[string, ModelsDevRef[]]> = [
            ['gpt-5.6-sol', [providerRef('openai', 'gpt-5.6-sol')]],
            ['gpt-5.6-luna', [providerRef('openai', 'gpt-5.6-luna')]],
            ['gpt-5.6-terra', [providerRef('openai', 'gpt-5.6-terra')]],
            ['gpt-5.4', [providerRef('openai', 'gpt-5.4')]],
            ['gpt-5.5', [providerRef('openai', 'gpt-5.5')]],
        ];
        for (const [modelId, expected] of cases) {
            expect(resolveUsageModelsDevRefs('openai-codex', modelId), modelId).toEqual(expected);
        }
    });

    it('maps opencode-go pass-through with exact model id', () => {
        const cases: Array<[string, ModelsDevRef[]]> = [
            ['deepseek-v4-pro', [providerRef('opencode-go', 'deepseek-v4-pro')]],
            ['glm-5.2', [providerRef('opencode-go', 'glm-5.2')]],
            ['qwen3.7-plus', [providerRef('opencode-go', 'qwen3.7-plus')]],
            ['kimi-k2.6', [providerRef('opencode-go', 'kimi-k2.6')]],
            ['mimo-v2.5', [providerRef('opencode-go', 'mimo-v2.5')]],
            ['deepseek-v4-flash', [providerRef('opencode-go', 'deepseek-v4-flash')]],
        ];
        for (const [modelId, expected] of cases) {
            expect(resolveUsageModelsDevRefs('opencode-go', modelId), modelId).toEqual(expected);
        }
    });

    it('maps zai pass-through with exact model id', () => {
        const cases: Array<[string, ModelsDevRef[]]> = [
            ['glm-5.2', [providerRef('zai', 'glm-5.2')]],
            ['glm-5v-turbo', [providerRef('zai', 'glm-5v-turbo')]],
        ];
        for (const [modelId, expected] of cases) {
            expect(resolveUsageModelsDevRefs('zai', modelId), modelId).toEqual(expected);
        }
    });

    it('maps or prefix to openrouter with verbatim model id, including :free', () => {
        const cases: Array<[string, ModelsDevRef[]]> = [
            ['deepseek-v4-pro', [providerRef('openrouter', 'deepseek-v4-pro')]],
            ['deepseek-v4-flash', [providerRef('openrouter', 'deepseek-v4-flash')]],
            ['google/gemma-4-26b-a4b-it:free', [providerRef('openrouter', 'google/gemma-4-26b-a4b-it:free')]],
            ['poolside/laguna-m.1:free', [providerRef('openrouter', 'poolside/laguna-m.1:free')]],
            ['nvidia/nemotron-3-super-120b-a12b:free', [providerRef('openrouter', 'nvidia/nemotron-3-super-120b-a12b:free')]],
            ['moonshotai/kimi-k2.6:free', [providerRef('openrouter', 'moonshotai/kimi-k2.6:free')]],
            ['qwen/qwen3.6-plus-preview:free', [providerRef('openrouter', 'qwen/qwen3.6-plus-preview:free')]],
            ['google/gemma-4-26b-a4b-it', [providerRef('openrouter', 'google/gemma-4-26b-a4b-it')]],
            ['google/gemma-4-31b-it:free', [providerRef('openrouter', 'google/gemma-4-31b-it:free')]],
        ];
        for (const [modelId, expected] of cases) {
            expect(resolveUsageModelsDevRefs('or', modelId), modelId).toEqual(expected);
        }
    });

    it('returns no candidates for empty, malformed, or unknown keys', () => {
        const cases: Array<[string, string]> = [
            ['', 'gpt-5.4'],
            ['openai', ''],
            ['openai', '   '],
            ['cpa', ''],
            ['cpa', '   '],
            ['factory-ai', ''],
            ['openrouter', ''],
            ['custom-unknown', 'gpt-5.4'],
        ];
        for (const [providerId, modelId] of cases) {
            expect(
                resolveUsageModelsDevRefs(providerId, modelId),
                `${providerId}/${modelId}`,
            ).toEqual([]);
        }
    });
});
