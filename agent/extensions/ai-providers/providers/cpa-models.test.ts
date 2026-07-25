/**
 * Tests for CPA model enrichment engine.
 *
 * Tests familyDefaults prefix matching, enrichModel filtering and enrichment
 * pipeline, static fallback completeness, and buildCpaModels orchestration.
 */

import { afterEach, describe, expect, it, mock, beforeEach } from 'bun:test';
import { OVERRIDE_TABLES } from '../constants/cpa-overrides';
import { STATIC_FALLBACK_MODELS } from '../constants/cpa-static-models';
import {
    enrichModel,
    familyDefaults,
    fetchCpaModelIds,
    fetchOpenRouterMetadata,
    resetOrMetadataCache,
    buildCpaModels,
    STATIC_IMAGE_MODELS,
} from './cpa-models.ts';
import type { CpaModelEntry } from './cpa-models.ts';

// Ensure cache isolation between tests
beforeEach(() => {
    resetOrMetadataCache();
});

// ── familyDefaults ──

describe('familyDefaults', () => {
    it('returns Claude defaults for claude- prefix', () => {
        const result = familyDefaults('claude-sonnet-4-6');
        expect(result.contextWindow).toBe(1_000_000);
        expect(result.maxTokens).toBe(64_000);
        expect(result.reasoning).toBe(true);
    });

    it('returns 128K maxTokens for Claude opus/thinking variants', () => {
        const result = familyDefaults('claude-opus-4-6-thinking');
        expect(result.maxTokens).toBe(128_000);
        expect(result.reasoning).toBe(true);
    });

    it('returns Gemini defaults for gemini- prefix', () => {
        const result = familyDefaults('gemini-3-flash');
        expect(result.contextWindow).toBe(1_048_576);
        expect(result.maxTokens).toBe(65_536);
        expect(result.reasoning).toBe(true);
    });

    it('returns smaller context for gemini-3.5-flash variant', () => {
        const result = familyDefaults('gemini-3.5-flash-low');
        expect(result.contextWindow).toBe(1_000_000);
    });

    it('returns reasoning=false for flash-image variants', () => {
        const result = familyDefaults('gemini-3.1-flash-image');
        expect(result.reasoning).toBe(false);
    });

    it('returns smaller maxTokens for flash-lite/extra-low', () => {
        expect(familyDefaults('gemini-3.1-flash-lite').maxTokens).toBe(32_768);
        expect(familyDefaults('gemini-3.5-flash-extra-low').maxTokens).toBe(
            32_768,
        );
    });

    it('returns GPT-5.5 defaults', () => {
        const result = familyDefaults('gpt-5.5');
        // Codex subscription caps gpt-5.5 at 272K input (400K total).
        // See https://github.com/openai/codex/issues/19464
        expect(result.contextWindow).toBe(272_000);
        expect(result.maxTokens).toBe(128_000);
    });

    it('returns GPT-5.4 defaults (before mini check)', () => {
        const result = familyDefaults('gpt-5.4');
        // GPT-5.4 in Codex supports up to 1M context.
        expect(result.contextWindow).toBe(1_000_000);
        expect(result.maxTokens).toBe(128_000);
    });

    it('returns GPT-5.4-mini defaults', () => {
        const result = familyDefaults('gpt-5.4-mini');
        expect(result.contextWindow).toBe(400_000);
        expect(result.maxTokens).toBe(128_000);
    });

    it('returns gpt-5.3-codex defaults', () => {
        const result = familyDefaults('gpt-5.3-codex-spark');
        expect(result.contextWindow).toBe(400_000);
        expect(result.maxTokens).toBe(128_000);
    });

    it('returns GPT-OSS defaults', () => {
        const result = familyDefaults('gpt-oss-120b-medium');
        expect(result.contextWindow).toBe(128_000);
        expect(result.maxTokens).toBe(32_768);
    });

    it('returns Grok defaults', () => {
        const result = familyDefaults('grok-3');
        expect(result.contextWindow).toBe(256_000);
        expect(result.maxTokens).toBe(32_768);
    });

    it('returns DeepSeek defaults', () => {
        const result = familyDefaults('deepseek-v4-flash');
        expect(result.contextWindow).toBe(1_000_000);
        expect(result.maxTokens).toBe(384_000);
        expect(result.reasoning).toBe(true);
    });

    it('returns DeepSeek defaults with slash prefix', () => {
        const result = familyDefaults('deepseek/deepseek-v4-flash');
        expect(result.contextWindow).toBe(1_000_000);
    });

    it('returns DeepSeek defaults for ocg/go- prefixed model', () => {
        const result = familyDefaults('ocg/go-deepseek-v4-pro');
        expect(result.contextWindow).toBe(1_000_000);
        expect(result.maxTokens).toBe(384_000);
        expect(result.reasoning).toBe(true);
    });

    it('returns Kimi defaults', () => {
        const result = familyDefaults('kimi-k2.6');
        expect(result.contextWindow).toBe(262_144);
        expect(result.maxTokens).toBe(32_768);
    });

    it('returns Kimi defaults for moonshotai/ prefix', () => {
        const result = familyDefaults('moonshotai/kimi-k2.6:free');
        expect(result.contextWindow).toBe(262_144);
        expect(result.maxTokens).toBe(262_144); // moonshotai override
    });

    it('returns GLM defaults', () => {
        const result = familyDefaults('glm-5.2');
        expect(result.contextWindow).toBe(1_000_000);
        expect(result.maxTokens).toBe(131_072);
    });

    it('returns MiMo defaults', () => {
        expect(familyDefaults('mimo-v2.5').contextWindow).toBe(1_000_000);
        expect(familyDefaults('mimo-v2.5').maxTokens).toBe(128_000);
    });

    it('returns Qwen defaults', () => {
        expect(familyDefaults('qwen3.6-plus-preview').contextWindow).toBe(
            1_000_000,
        );
        expect(familyDefaults('qwen3.6-plus-preview').maxTokens).toBe(64_000);
    });

    it('returns Qwen defaults for qwen/ prefix', () => {
        const result = familyDefaults('qwen/qwen3.6-plus-preview:free');
        expect(result.contextWindow).toBe(1_000_000);
    });

    it('returns Gemma defaults', () => {
        expect(familyDefaults('gemma-4-26b-a4b-it').contextWindow).toBe(
            262_144,
        );
        expect(familyDefaults('gemma-4-26b-a4b-it').maxTokens).toBe(32_768);
    });

    it('returns Nemotron defaults', () => {
        expect(familyDefaults('nemotron-3-super').contextWindow).toBe(
            1_000_000,
        );
        expect(familyDefaults('nemotron-3-super').maxTokens).toBe(65_536);
    });

    it('returns MiniMax defaults', () => {
        expect(familyDefaults('minimax-m3').contextWindow).toBe(1_000_000);
        expect(familyDefaults('minimax-m3').maxTokens).toBe(131_072);
    });

    it('returns Laguna defaults', () => {
        expect(familyDefaults('laguna-m.1').contextWindow).toBe(262_144);
        expect(familyDefaults('laguna-m.1').maxTokens).toBe(32_768);
    });

    it('returns Google defaults for google/ prefix', () => {
        expect(familyDefaults('google/gemma-4-26b-a4b-it').contextWindow).toBe(
            262_144,
        );
    });

    it('returns Nvidia defaults for nvidia/ prefix', () => {
        expect(familyDefaults('nvidia/nemotron-3-super').contextWindow).toBe(
            1_000_000,
        );
    });

    it('returns Poolside defaults for poolside/ prefix', () => {
        expect(familyDefaults('poolside/laguna-m.1:free').contextWindow).toBe(
            262_144,
        );
    });

    it('returns empty object for unknown family', () => {
        const result = familyDefaults('totally-unknown-model-v99');
        expect(result).toEqual({});
    });
});

// ── enrichModel filtering ──

describe('enrichModel filtering', () => {
    const emptyOrMeta = new Map();

    it('returns null for or/ prefixed variants', () => {
        const entry: CpaModelEntry = {
            id: 'or/deepseek/deepseek-v4-flash',
            owned_by: 'openrouter',
        };
        expect(enrichModel(entry, emptyOrMeta)).toBeNull();
    });

    it('returns null for bare go- prefix without ocg/', () => {
        const entry: CpaModelEntry = {
            id: 'go-glm-5.2',
            owned_by: 'ocode-go (main)',
        };
        expect(enrichModel(entry, emptyOrMeta)).toBeNull();
    });

    it('returns config for ocg/ prefixed Go models', () => {
        const entry: CpaModelEntry = {
            id: 'ocg/go-glm-5.2',
            owned_by: 'ocode-go (main)',
        };
        const result = enrichModel(entry, emptyOrMeta);
        expect(result).not.toBeNull();
        expect(result!.id).toBe('ocg/go-glm-5.2');
    });

    it('returns config for unprefixed OpenRouter models', () => {
        const entry: CpaModelEntry = {
            id: 'deepseek/deepseek-v4-flash',
            owned_by: 'openrouter',
        };
        const result = enrichModel(entry, emptyOrMeta);
        expect(result).not.toBeNull();
        expect(result!.id).toBe('deepseek/deepseek-v4-flash');
    });

    it('returns config for Antigravity models', () => {
        const entry: CpaModelEntry = {
            id: 'claude-sonnet-4-6',
            owned_by: 'antigravity',
        };
        const result = enrichModel(entry, emptyOrMeta);
        expect(result).not.toBeNull();
    });

    it('returns config for Codex/OpenAI models', () => {
        const entry: CpaModelEntry = { id: 'gpt-5.4', owned_by: 'openai' };
        const result = enrichModel(entry, emptyOrMeta);
        expect(result).not.toBeNull();
    });

    it('returns config for unknown owned_by — never skipped', () => {
        const entry: CpaModelEntry = {
            id: 'claude-code-super',
            owned_by: 'claude-code',
        };
        const result = enrichModel(entry, emptyOrMeta);
        expect(result).not.toBeNull();
        expect(result!.id).toBe('claude-code-super');
    });
});

// ── enrichModel enrichment ──

describe('enrichModel enrichment pipeline', () => {
    const emptyOrMeta = new Map();

    it('applies generic fallback for unknown model', () => {
        const entry: CpaModelEntry = {
            id: 'unknown-model-42',
            owned_by: 'mystery-provider',
        };
        const result = enrichModel(entry, emptyOrMeta)!;
        expect(result.contextWindow).toBe(128_000);
        expect(result.maxTokens).toBe(32_768);
        expect(result.cost.input).toBe(0);
        expect(result.reasoning).toBe(true);
    });

    it('applies family defaults for known family', () => {
        const entry: CpaModelEntry = {
            id: 'deepseek-v4-flash',
            owned_by: 'some-provider',
        };
        const result = enrichModel(entry, emptyOrMeta)!;
        expect(result.contextWindow).toBe(1_000_000);
        expect(result.maxTokens).toBe(384_000);
    });

    it('applies OpenRouter metadata when available', () => {
        const orMeta = new Map([
            [
                'deepseek/deepseek-v4-flash',
                {
                    id: 'deepseek/deepseek-v4-flash',
                    name: 'DeepSeek V4 Flash',
                    context_length: 1_048_576,
                    pricing: { prompt: '0.00000012', completion: '0.00000018' },
                    top_provider: { max_completion_tokens: 8192 },
                    supported_parameters: ['reasoning'],
                },
            ],
        ]);
        const entry: CpaModelEntry = {
            id: 'deepseek/deepseek-v4-flash',
            owned_by: 'openrouter',
        };
        const result = enrichModel(entry, orMeta)!;
        expect(result.contextWindow).toBe(1_048_576);
        expect(result.maxTokens).toBe(8192);
        expect(result.cost.input).toBe(0.12);
        expect(result.cost.output).toBe(0.18);
        expect(result.reasoning).toBe(true);
    });

    it('applies OpenRouter metadata for non-ocg models by direct ID match', () => {
        // Direct match on the model ID (no ocg/ prefix)
        const orMeta = new Map([
            [
                'deepseek/deepseek-v4-flash',
                {
                    id: 'deepseek/deepseek-v4-flash',
                    name: 'DeepSeek V4 Flash',
                    context_length: 1_048_576,
                    pricing: { prompt: '0.00000015', completion: '0.00000020' },
                    top_provider: { max_completion_tokens: 16_384 },
                    supported_parameters: ['reasoning'],
                },
            ],
        ]);
        const entry: CpaModelEntry = {
            id: 'deepseek/deepseek-v4-flash',
            owned_by: 'openrouter',
        };
        const result = enrichModel(entry, orMeta)!;
        // OR metadata overrides family defaults
        expect(result.contextWindow).toBe(1_048_576);
        expect(result.maxTokens).toBe(16_384);
    });

    it('applies OpenRouter metadata for ocg/ models via ocgAlias lookup', () => {
        // ocg/ prefix is stripped, then the alias is looked up in OR metadata
        const orMeta = new Map([
            [
                'deepseek/deepseek-v4-flash',
                {
                    id: 'deepseek/deepseek-v4-flash',
                    name: 'DeepSeek V4 Flash',
                    context_length: 1_048_576,
                    pricing: { prompt: '0.00000015', completion: '0.00000020' },
                    top_provider: { max_completion_tokens: 8_192 },
                    supported_parameters: ['reasoning'],
                },
            ],
        ]);
        // Use an ocg/ prefixed entry, but the OR map has the unprefixed alias
        const entry: CpaModelEntry = {
            id: 'ocg/deepseek/deepseek-v4-flash',
            owned_by: 'openrouter',
        };
        const result = enrichModel(entry, orMeta)!;
        // OR metadata should be found via alias (ocgAlias strips the prefix)
        expect(result.contextWindow).toBe(1_048_576);
        expect(result.maxTokens).toBe(8_192);
    });

    it('applies provider-specific overrides for OpenCode Go', () => {
        const entry: CpaModelEntry = {
            id: 'ocg/go-glm-5.2',
            owned_by: 'ocode-go (main)',
        };
        const result = enrichModel(entry, emptyOrMeta)!;
        // Provider overrides should have the correct pricing
        expect(result.cost.input).toBe(1.4);
        expect(result.cost.output).toBe(4.4);
        expect(result.cost.cacheRead).toBe(0.26);
        expect(result.contextWindow).toBe(1_000_000);
        expect(result.maxTokens).toBe(131_072);
    });

    it('applies provider-specific overrides for OpenCode Go (2nd)', () => {
        const entry: CpaModelEntry = {
            id: 'ocg/go-deepseek-v4-pro',
            owned_by: 'ocode-go (2nd)',
        };
        const result = enrichModel(entry, emptyOrMeta)!;
        expect(result.cost.input).toBe(1.74);
        expect(result.cost.output).toBe(3.48);
        expect(result.cost.cacheRead).toBe(0.0145);
        expect(result.contextWindow).toBe(1_000_000);
        expect(result.maxTokens).toBe(384_000);
    });

    it('skips overrides when overridePrefixes map is empty (config-gated)', () => {
        const entry: CpaModelEntry = {
            id: 'ocg/go-glm-5.2',
            owned_by: 'ocode-go (main)',
        };
        // Empty map → no prefix matches → override table not consulted; cost
        // falls back to the zero-cost generic (the override would set 1.4/4.4).
        const result = enrichModel(entry, emptyOrMeta, {})!;
        expect(result.cost.input).toBe(0);
        expect(result.cost.output).toBe(0);
    });

    it('applies Go override for a prefix mapped to the go table', () => {
        // Pretend cliproxy renamed `ocg` → `ogo`. Same alias table applies
        // because the prefix is mapped to "go" in overridePrefixes.
        const entry: CpaModelEntry = {
            id: 'ogo/go-glm-5.2',
            owned_by: 'ocode-go (main)',
        };
        const result = enrichModel(entry, emptyOrMeta, { ogo: 'go' })!;
        expect(result.cost.input).toBe(1.4);
        expect(result.cost.output).toBe(4.4);
        expect(result.contextWindow).toBe(1_000_000);
        expect(result.maxTokens).toBe(131_072);
    });

    it('does not cross-contaminate tables on alias collision', () => {
        // A non-go family `foo` happens to ship a model aliased `go-glm-5.2`.
        // Dispatch must look in the `foo` table only, not leak into `go`.
        const entry: CpaModelEntry = {
            id: 'foo/go-glm-5.2',
            owned_by: 'foo-provider',
        };
        const result = enrichModel(entry, emptyOrMeta, { foo: 'foo' })!;
        // foo table is empty → no override → zero-cost generic fallback.
        expect(result.cost.input).toBe(0);
        expect(result.cost.output).toBe(0);
    });

    it('always includes compat: supportsDeveloperRole: false', () => {
        const entry: CpaModelEntry = {
            id: 'gemini-3-flash',
            owned_by: 'antigravity',
        };
        const result = enrichModel(entry, emptyOrMeta)!;
        expect(
            (result.compat as { supportsDeveloperRole?: boolean })
                ?.supportsDeveloperRole,
        ).toBe(false);
    });

    it('includes name field', () => {
        const entry: CpaModelEntry = {
            id: 'claude-sonnet-4-6',
            owned_by: 'antigravity',
        };
        const result = enrichModel(entry, emptyOrMeta)!;
        expect(result.name).toContain('Claude');
        expect(result.name).toContain('Antigravity');
    });
});

// ── STATIC_FALLBACK_MODELS ──

describe('STATIC_FALLBACK_MODELS', () => {
    it('has exactly 30 entries', () => {
        expect(STATIC_FALLBACK_MODELS.length).toBe(30);
    });

    it('has all 8 OpenCode Go models with ocg/ prefix', () => {
        const goModels = STATIC_FALLBACK_MODELS.filter((m) =>
            m.id.startsWith('ocg/'),
        );
        expect(goModels.length).toBe(8);
    });

    it('has all 11 OpenRouter pool models (unprefixed with slashes)', () => {
        const orModels = STATIC_FALLBACK_MODELS.filter(
            (m) =>
                !m.id.startsWith('ocg/') &&
                !m.id.startsWith('claude-') &&
                !m.id.startsWith('gemini-') &&
                !m.id.startsWith('gpt-'),
        );
        expect(orModels.length).toBe(11);
    });

    it('has all 11 Antigravity models', () => {
        const antigravityModels = STATIC_FALLBACK_MODELS.filter(
            (m) =>
                m.id.startsWith('claude-') ||
                m.id.startsWith('gemini-') ||
                m.id === 'gpt-oss-120b-medium',
        );
        expect(antigravityModels.length).toBe(11);
    });

    it('every model has input with text', () => {
        for (const m of STATIC_FALLBACK_MODELS) {
            expect(m.input).toContain('text');
        }
    });

    it("text-only models have input: ['text']", () => {
        const textOnly = STATIC_FALLBACK_MODELS.filter(
            (m) => !STATIC_IMAGE_MODELS.has(m.id),
        );
        for (const m of textOnly) {
            expect(m.input).toEqual(['text']);
        }
    });

    it("image-capable models have input: ['text', 'image']", () => {
        const imageModels = STATIC_FALLBACK_MODELS.filter((m) =>
            STATIC_IMAGE_MODELS.has(m.id),
        );
        expect(imageModels.length).toBeGreaterThan(0);
        for (const m of imageModels) {
            expect(m.input).toEqual(['text', 'image']);
        }
    });

    it('every model has compat: supportsDeveloperRole: false', () => {
        for (const m of STATIC_FALLBACK_MODELS) {
            expect(
                (m.compat as { supportsDeveloperRole?: boolean })
                    ?.supportsDeveloperRole,
            ).toBe(false);
        }
    });

    it('every model has valid contextWindow and maxTokens', () => {
        for (const m of STATIC_FALLBACK_MODELS) {
            expect(m.contextWindow).toBeGreaterThan(0);
            expect(m.maxTokens).toBeGreaterThan(0);
        }
    });
});

// ── OVERRIDE_TABLES ──

describe('OVERRIDE_TABLES', () => {
    it('exposes the "go" table for OpenCode Go models', () => {
        expect(OVERRIDE_TABLES.go).toBeDefined();
    });

    it('go table has 8 models with pricing overrides', () => {
        expect(Object.keys(OVERRIDE_TABLES.go).length).toBe(8);
    });

    it('keys go entries by the post-prefix alias (e.g. go-glm-5.2)', () => {
        expect(OVERRIDE_TABLES.go['go-glm-5.2']).toBeDefined();
        expect(OVERRIDE_TABLES.go['go-deepseek-v4-pro']).toBeDefined();
    });

    it('each go override has cost with all fields', () => {
        for (const [, override] of Object.entries(OVERRIDE_TABLES.go)) {
            expect(override.cost).toBeDefined();
            expect(override.cost!.input).not.toBeUndefined();
            expect(override.cost!.output).not.toBeUndefined();
        }
    });
});

// ── Integration: buildCpaModels ──

describe('buildCpaModels', () => {
    const origFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = origFetch;
        resetOrMetadataCache();
    });

    it('returns STATIC_FALLBACK_MODELS when CPA returns empty (CPA down)', async () => {
        // Mock both CPA and OR to fail
        globalThis.fetch = mock(() =>
            Promise.reject(new Error('network error')),
        ) as unknown as typeof fetch;
        const result = await buildCpaModels(
            'http://localhost:8317/v1',
            'test-key',
        );
        expect(result.source).toBe('fallback');
        expect(result.models.length).toBe(30);
        expect(result.models).toBe(STATIC_FALLBACK_MODELS);
    });

    it('returns STATIC_FALLBACK_MODELS when all entries filter to null', async () => {
        // CPA returns only prefixed variants (all filtered by enrichModel)
        let callCount = 0;
        globalThis.fetch = mock((_url: string, _opts?: RequestInit) => {
            callCount++;
            return Promise.resolve(
                new Response(
                    JSON.stringify({
                        data: [
                            {
                                id: 'or/deepseek/deepseek-v4-flash',
                                owned_by: 'openrouter',
                            },
                            { id: 'go-glm-5.2', owned_by: 'ocode-go (main)' },
                        ],
                    }),
                    {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    },
                ),
            );
        }) as unknown as typeof fetch;

        const result = await buildCpaModels(
            'http://localhost:8317/v1',
            'test-key',
        );
        expect(result.source).toBe('fallback');
        expect(result.models.length).toBe(30);
        expect(result.models).toBe(STATIC_FALLBACK_MODELS);
    });

    it('returns enriched models when CPA returns entries', async () => {
        // CPA call = call 1, OpenRouter call = call 2
        let callCount = 0;
        globalThis.fetch = mock((_url: string, _opts?: RequestInit) => {
            callCount++;
            if (callCount === 1) {
                // CPA /v1/models response
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            data: [
                                {
                                    id: 'deepseek/deepseek-v4-flash',
                                    owned_by: 'openrouter',
                                },
                                {
                                    id: 'claude-sonnet-4-6',
                                    owned_by: 'antigravity',
                                },
                            ],
                        }),
                        {
                            status: 200,
                            headers: { 'Content-Type': 'application/json' },
                        },
                    ),
                );
            }
            // OpenRouter /v1/models response
            return Promise.resolve(
                new Response(
                    JSON.stringify({
                        data: [
                            {
                                id: 'deepseek/deepseek-v4-flash',
                                name: 'DeepSeek V4 Flash',
                                context_length: 1_048_576,
                                pricing: {
                                    prompt: '0.00000012',
                                    completion: '0.00000018',
                                },
                                top_provider: { max_completion_tokens: 8192 },
                                supported_parameters: ['reasoning'],
                            },
                        ],
                    }),
                    {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    },
                ),
            );
        }) as unknown as typeof fetch;

        const result = await buildCpaModels(
            'http://localhost:8317/v1',
            'test-key',
        );
        expect(result.source).toBe('live');
        expect(result.models.length).toBe(2);
        expect(result.models[0].id).toBe('deepseek/deepseek-v4-flash');
        expect(result.models[1].id).toBe('claude-sonnet-4-6');
        // DeepSeek model should have OR metadata (context 1M+)
        expect(result.models[0].contextWindow).toBe(1_048_576);
        // Claude model should have family defaults (1M)
        expect(result.models[1].contextWindow).toBe(1_000_000);
    });

    it('fetchCpaModelIds returns empty on failed fetch', async () => {
        globalThis.fetch = mock(() =>
            Promise.reject(new Error('network error')),
        ) as unknown as typeof fetch;
        const result = await fetchCpaModelIds(
            'http://localhost:8317/v1',
            'test-key',
        );
        expect(result).toEqual([]);
    });

    it('fetchOpenRouterMetadata returns empty map on failed fetch without caching', async () => {
        globalThis.fetch = mock(() =>
            Promise.reject(new Error('network error')),
        ) as unknown as typeof fetch;
        const result = await fetchOpenRouterMetadata();
        expect(result.size).toBe(0);
        // Verify cache was NOT set (next call should retry)
        const retry = await fetchOpenRouterMetadata();
        expect(retry.size).toBe(0);
    });
});
