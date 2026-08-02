/**
 * Tests for CPA model enrichment engine.
 *
 * Tests familyDefaults prefix matching, enrichModel filtering and enrichment
 * pipeline, static fallback completeness, and buildCpaModels orchestration.
 *
 * Enrichment resolves models.dev metadata through the shared catalog
 * ({@link ModelsDevCatalog.lookupFirst}) with exact reference mapping from
 * models-dev/mapping — no OpenRouter endpoint is consulted.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';
import type {
    ModelsDevCatalog,
    ModelsDevMatch,
    ModelsDevModel,
    ModelsDevRef,
} from '../../_shared/models-dev/catalog';
import { OVERRIDE_TABLES } from '../constants/cpa-overrides';
import { STATIC_FALLBACK_MODELS } from '../constants/cpa-static-models';
import {
    enrichModel,
    familyDefaults,
    fetchCpaModelIds,
    buildCpaModels,
    STATIC_IMAGE_MODELS,
} from './cpa-models.ts';
import type { CpaModelEntry } from './cpa-models.ts';

// ── Catalog lookup stub ──

function refKey(ref: ModelsDevRef): string {
    return ref.scope === 'provider'
        ? `p:${ref.providerId}/${ref.modelId}`
        : `m:${ref.modelId}`;
}

/** Deterministic lookup stub returning real ModelsDevMatch values by exact ref. */
function lookupStub(
    matches: ModelsDevMatch[],
): Pick<ModelsDevCatalog, 'lookupFirst' | 'lookupMerge'> {
    const byKey = new Map<string, ModelsDevMatch>();
    for (const match of matches) byKey.set(refKey(match.ref), match);
    const lookupFn = (refs: readonly ModelsDevRef[]) => {
        for (const ref of refs) {
            const match = byKey.get(refKey(ref));
            if (match) return match;
        }
        return undefined;
    };
    return {
        lookupFirst: (refs) => lookupFn(refs),
        lookupMerge: (refs) => {
            let merged: Record<string, unknown> | undefined;
            for (const ref of refs) {
                const match = byKey.get(refKey(ref));
                if (!match) continue;
                const m = match.model as unknown as Record<string, unknown>;
                if (!merged) {
                    merged = { name: m.name };
                }
                for (const key of [
                    'reasoning',
                    'contextWindow',
                    'maxTokens',
                    'inputModalities',
                ]) {
                    if (
                        m[key] !== undefined &&
                        merged[key] === undefined
                    ) {
                        merged[key] = m[key];
                    }
                }
                if (m.cost) {
                    if (!merged.cost) merged.cost = {};
                    const mc = merged.cost as Record<string, number>;
                    const src = m.cost as Record<string, number>;
                    for (const ck of [
                        'input',
                        'output',
                        'cacheRead',
                        'cacheWrite',
                    ]) {
                        if (
                            src[ck] !== undefined &&
                            mc[ck] === undefined
                        ) {
                            mc[ck] = src[ck];
                        }
                    }
                }
            }
            return merged as ModelsDevModel | undefined;
        },
    };
}

function providerMatch(
    providerId: string,
    modelId: string,
    model: ModelsDevModel,
): ModelsDevMatch {
    return { ref: { scope: 'provider', providerId, modelId }, model };
}

function baseMatch(modelId: string, model: ModelsDevModel): ModelsDevMatch {
    return { ref: { scope: 'model', modelId }, model };
}

const emptyLookup = lookupStub([]);

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
    it('returns null for or/ prefixed variants', () => {
        const entry: CpaModelEntry = {
            id: 'or/deepseek/deepseek-v4-flash',
            owned_by: 'openrouter',
        };
        expect(enrichModel(entry, emptyLookup, { ocg: 'go' })).toBeNull();
    });

    it('returns null for bare go- prefix without ocg/', () => {
        const entry: CpaModelEntry = {
            id: 'go-glm-5.2',
            owned_by: 'ocode-go (main)',
        };
        expect(enrichModel(entry, emptyLookup, { ocg: 'go' })).toBeNull();
    });

    it('returns config for ocg/ prefixed Go models', () => {
        const entry: CpaModelEntry = {
            id: 'ocg/go-glm-5.2',
            owned_by: 'ocode-go (main)',
        };
        const result = enrichModel(entry, emptyLookup, { ocg: 'go' });
        expect(result).not.toBeNull();
        expect(result!.id).toBe('ocg/go-glm-5.2');
    });

    it('returns config for unprefixed OpenRouter models', () => {
        const entry: CpaModelEntry = {
            id: 'deepseek/deepseek-v4-flash',
            owned_by: 'openrouter',
        };
        const result = enrichModel(entry, emptyLookup, { ocg: 'go' });
        expect(result).not.toBeNull();
        expect(result!.id).toBe('deepseek/deepseek-v4-flash');
    });

    it('returns config for Antigravity models', () => {
        const entry: CpaModelEntry = {
            id: 'claude-sonnet-4-6',
            owned_by: 'antigravity',
        };
        const result = enrichModel(entry, emptyLookup, { ocg: 'go' });
        expect(result).not.toBeNull();
    });

    it('returns config for Codex/OpenAI models', () => {
        const entry: CpaModelEntry = { id: 'gpt-5.4', owned_by: 'openai' };
        const result = enrichModel(entry, emptyLookup, { ocg: 'go' });
        expect(result).not.toBeNull();
    });

    it('returns config for unknown owned_by — never skipped', () => {
        const entry: CpaModelEntry = {
            id: 'claude-code-super',
            owned_by: 'claude-code',
        };
        const result = enrichModel(entry, emptyLookup, { ocg: 'go' });
        expect(result).not.toBeNull();
        expect(result!.id).toBe('claude-code-super');
    });

    it('still filters or/ and bare go- ids even when the catalog has them', () => {
        const catalog = lookupStub([
            providerMatch('openrouter', 'deepseek/deepseek-v4-flash', {
                name: 'DeepSeek V4 Flash',
                contextWindow: 1_048_576,
                maxTokens: 8192,
            }),
            providerMatch('opencode-go', 'glm-5.2', {
                name: 'GLM 5.2',
                contextWindow: 1_000_000,
            }),
        ]);
        expect(
            enrichModel(
                { id: 'or/deepseek/deepseek-v4-flash', owned_by: 'openrouter' },
                catalog,
                { ocg: 'go' },
            ),
        ).toBeNull();
        expect(
            enrichModel(
                { id: 'go-glm-5.2', owned_by: 'ocode-go (main)' },
                catalog,
                { ocg: 'go' },
            ),
        ).toBeNull();
    });
});

// ── enrichModel enrichment ──

describe('enrichModel enrichment pipeline', () => {
    it('applies generic fallback for unknown model', () => {
        const entry: CpaModelEntry = {
            id: 'unknown-model-42',
            owned_by: 'mystery-provider',
        };
        const result = enrichModel(entry, emptyLookup, { ocg: 'go' })!;
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
        const result = enrichModel(entry, emptyLookup, { ocg: 'go' })!;
        expect(result.contextWindow).toBe(1_000_000);
        expect(result.maxTokens).toBe(384_000);
    });

    it('applies catalog metadata over generic/family/static fallback', () => {
        const catalog = lookupStub([
            providerMatch('openrouter', 'deepseek/deepseek-v4-flash', {
                name: 'DeepSeek V4 Flash',
                contextWindow: 1_048_576,
                maxTokens: 8192,
                reasoning: false,
                inputModalities: ['text', 'image'],
                cost: {
                    input: 0.12,
                    output: 0.18,
                    cacheRead: 0.05,
                    cacheWrite: 0.01,
                },
            }),
        ]);
        const entry: CpaModelEntry = {
            id: 'deepseek/deepseek-v4-flash',
            owned_by: 'openrouter',
        };
        const result = enrichModel(entry, catalog, { ocg: 'go' })!;
        // catalog overrides family (1M/384K/true) and static (no image)
        expect(result.contextWindow).toBe(1_048_576);
        expect(result.maxTokens).toBe(8192);
        expect(result.reasoning).toBe(false);
        expect(result.input).toEqual(['text', 'image']);
        // all four cost fields from the catalog record
        expect(result.cost).toEqual({
            input: 0.12,
            output: 0.18,
            cacheRead: 0.05,
            cacheWrite: 0.01,
        });
    });

    it('applies explicit zero catalog cost while missing fields preserve fallback', () => {
        // cost.input is an explicit zero (a real free-tier price): it must be
        // applied, not skipped like the old OpenRouter > 0 guard did. Absent
        // cost fields and contextWindow preserve the fallback values.
        const catalog = lookupStub([
            providerMatch('openrouter', 'deepseek/deepseek-v4-flash', {
                name: 'DeepSeek V4 Flash',
                cost: { input: 0, output: 0.28 },
            }),
        ]);
        const entry: CpaModelEntry = {
            id: 'deepseek/deepseek-v4-flash',
            owned_by: 'openrouter',
        };
        const result = enrichModel(entry, catalog, { ocg: 'go' })!;
        expect(result.cost.input).toBe(0);
        expect(result.cost.output).toBe(0.28);
        // missing cacheRead/cacheWrite preserved from fallback (generic zeros)
        expect(result.cost.cacheRead).toBe(0);
        expect(result.cost.cacheWrite).toBe(0);
        // missing contextWindow/maxTokens preserved from family fallback
        expect(result.contextWindow).toBe(1_000_000);
        expect(result.maxTokens).toBe(384_000);
    });

    it('applies overrides last: explicit zero wins over nonzero catalog value', () => {
        // go-deepseek-v4-flash override cost has an explicit cacheWrite: 0.
        // Applied after the catalog layer, it must overwrite the catalog's
        // nonzero cacheWrite — and the other defined override fields win too.
        const catalog = lookupStub([
            providerMatch('opencode-go', 'deepseek-v4-flash', {
                name: 'DeepSeek V4 Flash',
                contextWindow: 100_000,
                maxTokens: 10_000,
                cost: {
                    input: 0.3,
                    output: 0.6,
                    cacheRead: 0.1,
                    cacheWrite: 0.1,
                },
            }),
        ]);
        const entry: CpaModelEntry = {
            id: 'ocg/go-deepseek-v4-flash',
            owned_by: 'ocode-go (main)',
        };
        const result = enrichModel(entry, catalog, { ocg: 'go' })!;
        expect(result.cost).toEqual({
            input: 0.14,
            output: 0.28,
            cacheRead: 0.0028,
            cacheWrite: 0,
        });
        expect(result.contextWindow).toBe(1_000_000);
        expect(result.maxTokens).toBe(384_000);
    });

    it('applies provider-specific overrides for OpenCode Go', () => {
        const entry: CpaModelEntry = {
            id: 'ocg/go-glm-5.2',
            owned_by: 'ocode-go (main)',
        };
        const result = enrichModel(entry, emptyLookup, { ocg: 'go' })!;
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
        const result = enrichModel(entry, emptyLookup, { ocg: 'go' })!;
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
        const result = enrichModel(entry, emptyLookup, {})!;
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
        const result = enrichModel(entry, emptyLookup, { ogo: 'go' })!;
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
        const result = enrichModel(entry, emptyLookup, { foo: 'foo' })!;
        // foo table is empty → no override → zero-cost generic fallback.
        expect(result.cost.input).toBe(0);
        expect(result.cost.output).toBe(0);
    });

    it('enriches Antigravity models via exact base mapping without fuzzy lookup', () => {
        const catalog = lookupStub([
            baseMatch('anthropic/claude-sonnet-4-6', {
                name: 'Claude Sonnet 4.6',
                contextWindow: 1_000_000,
                maxTokens: 64_000,
                cost: { input: 3, output: 15 },
            }),
        ]);
        const entry: CpaModelEntry = {
            id: 'claude-sonnet-4-6',
            owned_by: 'antigravity',
        };
        const result = enrichModel(entry, catalog, { ocg: 'go' })!;
        expect(result.contextWindow).toBe(1_000_000);
        expect(result.maxTokens).toBe(64_000);
        expect(result.cost.input).toBe(3);
        expect(result.cost.output).toBe(15);
        expect(result.id).toBe('claude-sonnet-4-6');
    });

    it('preserves fallback when the catalog has no exact record', () => {
        const entry: CpaModelEntry = {
            id: 'deepseek-v4-flash',
            owned_by: 'some-provider',
        };
        const result = enrichModel(entry, emptyLookup, { ocg: 'go' })!;
        // family fallback intact; no catalog values leaked in
        expect(result.contextWindow).toBe(1_000_000);
        expect(result.maxTokens).toBe(384_000);
        expect(result.cost.input).toBe(0);
        expect(result.reasoning).toBe(true);
    });

    it('never enriches a free OpenRouter route from its paid record', () => {
        const catalog = lookupStub([
            providerMatch('openrouter', 'deepseek/deepseek-v4-flash', {
                name: 'DeepSeek V4 Flash',
                cost: { input: 7, output: 11 },
            }),
        ]);
        const result = enrichModel(
            {
                id: 'deepseek/deepseek-v4-flash:free',
                owned_by: 'openrouter',
            },
            catalog,
            { ocg: 'go' },
        )!;
        expect(result.cost.input).toBe(0);
        expect(result.cost.output).toBe(0);
    });

    it('does not apply catalog metadata through an unknown owner', () => {
        const catalog = lookupStub([
            providerMatch('openai', 'claude-code-super', {
                name: 'Wrong provider record',
                contextWindow: 999,
                cost: { input: 7, output: 11 },
            }),
        ]);
        const result = enrichModel(
            { id: 'claude-code-super', owned_by: 'claude-code' },
            catalog,
            { ocg: 'go' },
        )!;
        expect(result.contextWindow).toBe(1_000_000);
        expect(result.cost.input).toBe(0);
        expect(result.cost.output).toBe(0);
    });

    it('never changes model id, route display name, or compat from catalog metadata', () => {
        const catalog = lookupStub([
            providerMatch('openai', 'gpt-5.4', {
                name: 'COMPLETELY DIFFERENT NAME',
                contextWindow: 999_999,
                maxTokens: 777_777,
                cost: { input: 0.01, output: 0.02 },
            }),
        ]);
        const entry: CpaModelEntry = { id: 'gpt-5.4', owned_by: 'openai' };
        const result = enrichModel(entry, catalog, { ocg: 'go' })!;
        // specs still enrich…
        expect(result.contextWindow).toBe(999_999);
        expect(result.maxTokens).toBe(777_777);
        expect(result.cost.input).toBe(0.01);
        // …but identity/display/compat come from the entry, never the catalog
        expect(result.id).toBe('gpt-5.4');
        expect(result.name).toBe('GPT 5.4 (Codex)');
        expect(
            (result.compat as { supportsDeveloperRole?: boolean })
                ?.supportsDeveloperRole,
        ).toBe(false);
    });

    it('narrows to text-only when the catalog record explicitly omits image', () => {
        // gemini-3.5-flash is in STATIC_IMAGE_MODELS → currently ["text","image"]
        // A catalog record with inputModalities: ["text"] is explicit text-only evidence.
        const catalog = lookupStub([
            baseMatch('google/gemini-3.5-flash', {
                name: 'Gemini 3.5 Flash',
                inputModalities: ['text'],
            }),
        ]);
        const entry: CpaModelEntry = {
            id: 'gemini-3.5-flash',
            owned_by: 'antigravity',
        };
        const result = enrichModel(entry, catalog, { ocg: 'go' })!;
        expect(result.input).toEqual(['text']);
    });

    it('preserves static image capability when the catalog record has no inputModalities', () => {
        const catalog = lookupStub([
            baseMatch('google/gemini-3.5-flash', {
                name: 'Gemini 3.5 Flash',
            }),
        ]);
        const entry: CpaModelEntry = {
            id: 'gemini-3.5-flash',
            owned_by: 'antigravity',
        };
        const result = enrichModel(entry, catalog, { ocg: 'go' })!;
        expect(result.input).toEqual(['text', 'image']);
    });

    it('always includes compat: supportsDeveloperRole: false', () => {
        const entry: CpaModelEntry = {
            id: 'gemini-3-flash-preview',
            owned_by: 'antigravity',
        };
        const result = enrichModel(entry, emptyLookup, { ocg: 'go' })!;
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
        const result = enrichModel(entry, emptyLookup, { ocg: 'go' })!;
        expect(result.name).toContain('Claude');
        expect(result.name).toContain('Antigravity');
    });
});

// ── STATIC_FALLBACK_MODELS ──

describe('STATIC_FALLBACK_MODELS', () => {
    it('has exactly 28 entries', () => {
        expect(STATIC_FALLBACK_MODELS.length).toBe(28);
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

    it('has exactly the nine live Antigravity models', () => {
        const antigravityModels = STATIC_FALLBACK_MODELS.filter(
            (m) =>
                m.id.startsWith('claude-') ||
                m.id.startsWith('gemini-') ||
                m.id === 'gpt-oss-120b-medium',
        );
        expect(antigravityModels.map((model) => model.id).sort()).toEqual([
            'claude-opus-4-6-thinking',
            'claude-sonnet-4-6',
            'gemini-3-flash-preview',
            'gemini-3.1-flash-image',
            'gemini-3.1-flash-lite',
            'gemini-3.1-pro-preview',
            'gemini-3.5-flash',
            'gemini-3.6-flash',
            'gpt-oss-120b-medium',
        ]);
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

    it('tracks only live image-capable Antigravity ids', () => {
        const ids = [...STATIC_IMAGE_MODELS]
            .filter((id) => id.startsWith('claude-') || id.startsWith('gemini-'))
            .sort();
        expect(ids).toEqual([
            'claude-opus-4-6-thinking',
            'claude-sonnet-4-6',
            'gemini-3-flash-preview',
            'gemini-3.1-flash-image',
            'gemini-3.1-flash-lite',
            'gemini-3.1-pro-preview',
            'gemini-3.5-flash',
            'gemini-3.6-flash',
        ]);
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
    });

    it('returns STATIC_FALLBACK_MODELS when CPA returns empty (CPA down)', async () => {
        // CPA availability fails → static fallback, no metadata request at all
        globalThis.fetch = mock(() =>
            Promise.reject(new Error('network error')),
        ) as unknown as typeof fetch;
        const result = await buildCpaModels(
            'http://localhost:8317/v1',
            'test-key',
            { catalog: emptyLookup },
        );
        expect(result.source).toBe('fallback');
        expect(result.models.length).toBe(28);
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
            { catalog: emptyLookup },
        );
        expect(result.source).toBe('fallback');
        expect(result.models.length).toBe(28);
        expect(result.models).toBe(STATIC_FALLBACK_MODELS);
        // no metadata request behind the availability fetch
        expect(callCount).toBe(1);
    });

    it('fetches only CPA availability and enriches via the injected catalog', async () => {
        let callCount = 0;
        globalThis.fetch = mock((_url: string, _opts?: RequestInit) => {
            callCount++;
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
        }) as unknown as typeof fetch;

        const catalog = lookupStub([
            providerMatch('openrouter', 'deepseek/deepseek-v4-flash', {
                name: 'DeepSeek V4 Flash',
                contextWindow: 1_048_576,
                maxTokens: 8192,
                cost: { input: 0.12, output: 0.18 },
            }),
        ]);

        const result = await buildCpaModels(
            'http://localhost:8317/v1',
            'test-key',
            { catalog },
        );
        expect(result.source).toBe('live');
        // exactly one fetch: the CPA availability request. The catalog is
        // consulted in memory — no external metadata request.
        expect(callCount).toBe(1);
        expect(result.models.length).toBe(2);
        expect(result.models[0].id).toBe('deepseek/deepseek-v4-flash');
        // DeepSeek model enriched from catalog metadata
        expect(result.models[0].contextWindow).toBe(1_048_576);
        // Claude model has family defaults (no catalog record)
        expect(result.models[1].contextWindow).toBe(1_000_000);
    });

    it('defaults the catalog to the process-wide getModelsDevCatalog()', async () => {
        // Without an options.catalog, buildCpaModels must still produce live
        // models (lookupFirst on the default catalog is snapshot-only: no
        // network request when the catalog was never loaded).
        let callCount = 0;
        globalThis.fetch = mock((_url: string, _opts?: RequestInit) => {
            callCount++;
            return Promise.resolve(
                new Response(
                    JSON.stringify({
                        data: [{ id: 'gpt-5.4', owned_by: 'openai' }],
                    }),
                    {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    },
                ),
            );
        }) as unknown as typeof fetch;

        const result = await buildCpaModels('http://localhost:8317/v1', 'test-key');
        expect(result.source).toBe('live');
        expect(callCount).toBe(1);
        expect(result.models[0].id).toBe('gpt-5.4');
        // family fallback applied (catalog unavailable or empty snapshot)
        expect(result.models[0].contextWindow).toBe(1_000_000);
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
});
