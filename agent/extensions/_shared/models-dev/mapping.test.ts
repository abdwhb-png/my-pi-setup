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

    it('maps ocg/ ids to provider opencode-go, with or without the go- route marker', () => {
        // Live CPA exposes both shapes under the ocg/ prefix: `ocg/go-<id>` for
        // aliased routes and `ocg/<id>` for routes whose alias carries no
        // `go-` marker. Both denote the same opencode-go provider scope.
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
            [
                'ocg/space-bunny',
                'ocode-go-3',
                [providerRef('opencode-go', 'space-bunny')],
            ],
        ];
        for (const [modelId, ownedBy, expected] of cases) {
            expect(
                resolveCpaModelsDevRefs(modelId, ownedBy),
                `${ownedBy}/${modelId}`,
            ).toEqual(expected);
        }
    });

    it('strips the go- route marker from ocz/ ids before scoping them to opencode', () => {
        // The ocode-zen group aliases shared routes as `go-<id>` and then adds
        // its own `ocz/` prefix, so a client id can carry two markers while
        // models.dev only knows the bare route id.
        const cases: Array<[string, string, ModelsDevRef[]]> = [
            [
                'ocz/go-deepseek-v4-flash',
                'ocode-zen',
                [providerRef('opencode', 'deepseek-v4-flash')],
            ],
            [
                'ocz/go-glm-5.3-flash',
                'ocode-zen',
                [providerRef('opencode', 'glm-5.3-flash')],
            ],
            [
                'ocz/go-big-pickle',
                'ocode-zen',
                [providerRef('opencode', 'big-pickle')],
            ],
            [
                'ocz/mimo-v2.5-free',
                'ocode-zen (free)',
                [providerRef('opencode', 'mimo-v2.5-free')],
            ],
        ];
        for (const [modelId, ownedBy, expected] of cases) {
            expect(
                resolveCpaModelsDevRefs(modelId, ownedBy),
                `${ownedBy}/${modelId}`,
            ).toEqual(expected);
        }
    });

    it('maps bare go- aliases of the ocode-zen group to provider opencode', () => {
        // `go-big-pickle` is the unprefixed alias of the same ocode-zen route.
        // Only the ocode-go bare duplicates must stay unmapped.
        expect(resolveCpaModelsDevRefs('go-big-pickle', 'ocode-zen')).toEqual([
            providerRef('opencode', 'big-pickle'),
        ]);
    });

    it('resolves a bare go- alias from its owner, and leaves it unmapped without one', () => {
        // A bare `go-` id is the unprefixed alias of the same route, so the
        // owner identifies the group it belongs to. Without an owner the
        // group is unknowable and the id stays unmapped, because `go-` alone
        // does not distinguish ocode-go from ocode-zen.
        expect(
            resolveCpaModelsDevRefs('go-deepseek-v4-flash', 'ocode-go (main)'),
        ).toEqual([providerRef('opencode-go', 'deepseek-v4-flash')]);
        expect(resolveCpaModelsDevRefs('go-glm-5.2', 'ocode-go')).toEqual([
            providerRef('opencode-go', 'glm-5.2'),
        ]);
        expect(resolveCpaModelsDevRefs('go-deepseek-v4-flash')).toEqual([]);
    });

    it('falls back to shared derivation for an unrecognized owned_by', () => {
        // A new CPA client group must be enriched without a code edit. The
        // derived refs stay exact, so an id with no models.dev counterpart
        // still resolves to nothing.
        expect(
            resolveCpaModelsDevRefs('deepseek/deepseek-v4-flash', 'mystery-provider'),
        ).toEqual([
            providerRef('openrouter', 'deepseek/deepseek-v4-flash'),
            baseRef('deepseek/deepseek-v4-flash'),
        ]);
        expect(resolveCpaModelsDevRefs('gemini-9-unreleased', 'mystery-provider')).toEqual(
            [
                providerRef('google', 'gemini-9-unreleased'),
                baseRef('google/gemini-9-unreleased'),
            ],
        );
    });

    it('does not infer a vendor for an id outside every known family', () => {
        for (const modelId of ['glm-unknown', 'unknown-bare-id', 'jev-1.13']) {
            expect(
                resolveCpaModelsDevRefs(modelId, 'mystery-provider'),
                `live:${modelId}`,
            ).toEqual([]);
            expect(resolveUsageModelsDevRefs('cpa', modelId), `usage:${modelId}`).toEqual(
                [],
            );
        }
    });

    it('maps the anthropic client group by owner with base ref fallback', () => {
        // owned_by "anthropic" is a live CPA group the adapter never handled;
        // its ids are already exact models.dev anthropic ids.
        for (const modelId of [
            'claude-opus-5-5',
            'claude-sonnet-5-5',
            'claude-opus-4-8',
            'claude-fable-5-1',
            'claude-haiku-4-5-20251001',
        ]) {
            const expected = [
                providerRef('anthropic', modelId),
                baseRef(`anthropic/${modelId}`),
            ];
            expect(
                resolveCpaModelsDevRefs(modelId, 'anthropic'),
                `live:${modelId}`,
            ).toEqual(expected);
        }
    });

    it('maps ocg/ ids by prefix even when owned_by is absent', () => {
        // The group prefix carries the group, so no owner is needed.
        expect(resolveCpaModelsDevRefs('ocg/go-deepseek-v4-flash')).toEqual([
            providerRef('opencode-go', 'deepseek-v4-flash'),
        ]);
        expect(resolveCpaModelsDevRefs('ocg/space-bunny')).toEqual([
            providerRef('opencode-go', 'space-bunny'),
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

    it('strips the zcoding- alias marker from Z.ai client ids', () => {
        // Live CPA exposes the Z.ai coding routes as `zcoding-<id>`, optionally
        // behind the `zai-coding/` group prefix. models.dev only knows the
        // bare GLM id under provider zai-coding-plan.
        for (const modelId of ['glm-4.7', 'glm-5.2', 'glm-5-turbo']) {
            const expected = [providerRef('zai-coding-plan', modelId)];
            expect(
                resolveCpaModelsDevRefs(`zcoding-${modelId}`, 'z.ai (coding)'),
                `live:zcoding-${modelId}`,
            ).toEqual(expected);
            expect(
                resolveCpaModelsDevRefs(`zai-coding/zcoding-${modelId}`, 'z.ai (coding)'),
                `live:zai-coding/zcoding-${modelId}`,
            ).toEqual(expected);
            expect(
                resolveUsageModelsDevRefs('cpa', `zcoding-${modelId}`),
                `usage:zcoding-${modelId}`,
            ).toEqual(expected);
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

    it('derives Antigravity client ids to vendor base refs', () => {
        // The Antigravity client ids are vendor model ids, so the vendor is
        // derived from the family prefix instead of an id table. Gemini keeps
        // models.dev's dotted google ids verbatim.
        const cases: Array<[string, string]> = [
            ['gemini-4-argon', 'gemini-4-argon'],
            ['gemini-3.8-flash', 'gemini-3.8-flash'],
            ['gemini-3.1-flash-image', 'gemini-3.1-flash-image'],
            ['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite'],
            ['gemini-3.5-flash-lite', 'gemini-3.5-flash-lite'],
            ['gemini-3-flash-preview', 'gemini-3-flash-preview'],
        ];
        for (const [modelId, vendorId] of cases) {
            const expected = [
                providerRef('google', vendorId),
                baseRef(`google/${vendorId}`),
            ];
            expect(
                resolveCpaModelsDevRefs(modelId, 'antigravity'),
                `live:${modelId}`,
            ).toEqual(expected);
            expect(resolveUsageModelsDevRefs('cpa', modelId), `usage:${modelId}`).toEqual(
                expected,
            );
        }
    });

    it('strips the -agy vendor marker and normalizes anthropic version separators', () => {
        // `-agy` is a CPA-local marker with no models.dev counterpart, and
        // models.dev's anthropic ids are dash-separated while the CPA aliases
        // are dot-separated.
        const cases: Array<[string, string]> = [
            ['claude-opus-4.6-agy', 'claude-opus-4-6'],
            ['claude-sonnet-4.6-agy', 'claude-sonnet-4-6'],
            ['claude-opus-5.5-agy', 'claude-opus-5-5'],
            ['claude-sonnet-5.5-agy', 'claude-sonnet-5-5'],
        ];
        for (const [modelId, vendorId] of cases) {
            const expected = [
                providerRef('anthropic', vendorId),
                baseRef(`anthropic/${vendorId}`),
            ];
            expect(
                resolveCpaModelsDevRefs(modelId, 'antigravity'),
                `live:${modelId}`,
            ).toEqual(expected);
            expect(resolveUsageModelsDevRefs('cpa', modelId), `usage:${modelId}`).toEqual(
                expected,
            );
        }
    });

    it('strips a trailing reasoning-budget segment when the full id is unknown', () => {
        // models.dev records the base route, not the per-budget variant, so
        // the exact id is tried first and the stripped id is the fallback.
        const expected = [
            providerRef('openai', 'gpt-oss-120b-medium'),
            baseRef('openai/gpt-oss-120b-medium'),
            providerRef('openai', 'gpt-oss-120b'),
            baseRef('openai/gpt-oss-120b'),
        ];
        expect(
            resolveCpaModelsDevRefs('gpt-oss-120b-medium', 'antigravity'),
            'live:gpt-oss-120b-medium',
        ).toEqual(expected);
        expect(
            resolveUsageModelsDevRefs('cpa', 'gpt-oss-120b-medium'),
            'usage:gpt-oss-120b-medium',
        ).toEqual(expected);
    });

    it('does not invent a vendor for an Antigravity id outside every known family', () => {
        for (const modelId of ['mystery-model-1', 'internal-preview']) {
            expect(resolveCpaModelsDevRefs(modelId, 'antigravity'), modelId).toEqual([]);
            expect(resolveUsageModelsDevRefs('cpa', modelId), `usage:${modelId}`).toEqual(
                [],
            );
        }
    });

    it('strips the or/ group prefix to the pool id, live and without owned_by', () => {
        // `or/` belongs to exactly one group, so unlike a bare `go-` id it
        // needs no owner to identify the group behind it.
        const expected = [
            providerRef('openrouter', 'deepseek/deepseek-v4-pro'),
            baseRef('deepseek/deepseek-v4-pro'),
        ];
        expect(
            resolveCpaModelsDevRefs('or/deepseek/deepseek-v4-pro', 'openrouter'),
            'live:or/deepseek/deepseek-v4-pro',
        ).toEqual(expected);
        expect(
            resolveUsageModelsDevRefs('cpa', 'or/deepseek/deepseek-v4-pro'),
            'usage:or/deepseek/deepseek-v4-pro',
        ).toEqual(expected);
        expect(resolveCpaModelsDevRefs('or/')).toEqual([]);
        expect(resolveCpaModelsDevRefs('or/noslash')).toEqual([]);
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
            ['zcoding-glm-5.2', [providerRef('zai-coding-plan', 'glm-5.2')]],
            // A bare `glm-5.2` is genuinely ambiguous: models.dev publishes it
            // under zai-coding-plan, zhipuai, and opencode at different
            // prices. Persisted rows that predate the `zcoding-` alias stay
            // unmapped rather than borrowing one vendor's price by convention;
            // a modelRule is the way to pin one.
            ['glm-5.2', []],
            ['ocz/deepseek-v4-flash-free', [providerRef('opencode', 'deepseek-v4-flash-free')]],
            [
                'claude-sonnet-4-6',
                [
                    providerRef('anthropic', 'claude-sonnet-4-6'),
                    baseRef('anthropic/claude-sonnet-4-6'),
                ],
            ],
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
