/**
 * Tests for factory-models.ts — Factory AI model enrichment.
 *
 * Covers:
 *   - SDK facts (availability, id, display name, multiplier, reasoning,
 *     noImageSupport input) remain authoritative end-to-end
 *   - exact mapped catalog records fill context/output/cost
 *   - Factory-owned route costs stay explicit overrides over catalog costs
 *   - missing/unmapped metadata preserves provider fallback facts
 *   - both transform entrypoints produce identical capability/cost output
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type {
    ModelsDevMatch,
    ModelsDevModel,
    ModelsDevRef,
} from '../../_shared/models-dev/catalog';
import type { FactoryModelEntry } from './factory-models';
import {
    clearCachedFactoryModels,
    fetchFactoryModels,
    toProviderModels,
    toResolvedFactoryModels,
} from './factory-models';

// ── @factory/droid-sdk mock ──

let availableModels: unknown[] = [];
const closeSession = mock(async () => {});
const createSession = mock(async () => ({
    initResult: { availableModels },
    close: closeSession,
}));

mock.module('@factory/droid-sdk', () => ({
    createSession,
    ModelProvider: {
        ANTHROPIC: 'anthropic',
        OPENAI: 'openai',
        GENERIC_CHAT_COMPLETION_API: 'generic-chat-completion-api',
        FACTORY: 'factory',
        GOOGLE: 'google',
        XAI: 'xai',
        VOYAGE: 'voyage',
    },
    ReasoningEffort: {
        None: 'none',
        Dynamic: 'dynamic',
        Off: 'off',
        Minimal: 'minimal',
        Low: 'low',
        Medium: 'medium',
        High: 'high',
        ExtraHigh: 'xhigh',
        Max: 'max',
    },
}));

// ── Catalog lookup stub ──

function refKey(ref: ModelsDevRef): string {
    return ref.scope === 'provider'
        ? `p:${ref.providerId}/${ref.modelId}`
        : `m:${ref.modelId}`;
}

function lookupStub(matches: ModelsDevMatch[]): {
    lookupFirst: (refs: ModelsDevRef[]) => ModelsDevMatch | undefined;
} {
    const byKey = new Map<string, ModelsDevMatch>();
    for (const match of matches) byKey.set(refKey(match.ref), match);
    return {
        lookupFirst: (refs) => {
            for (const ref of refs) {
                const match = byKey.get(refKey(ref));
                if (match) return match;
            }
            return undefined;
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

function makeEntry(
    overrides: Partial<FactoryModelEntry> = {},
): FactoryModelEntry {
    return {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        shortName: 'Claude 4.6',
        provider: 'anthropic',
        multiplier: 1,
        reasoning: true,
        supportedReasoningEfforts: ['medium', 'high'],
        input: ['text', 'image'],
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        costInput: 3,
        costOutput: 15,
        ...overrides,
    };
}

beforeEach(() => {
    clearCachedFactoryModels();
    createSession.mockClear();
    closeSession.mockClear();
});

afterEach(() => {
    clearCachedFactoryModels();
});

// ── fetchFactoryModels: SDK facts authoritative ──

describe('fetchFactoryModels', () => {
    it('keeps SDK id, display name, short name, provider, and multiplier authoritative', async () => {
        availableModels = [
            {
                id: 'claude-sonnet-4-6',
                displayName: 'Claude Sonnet 4.6',
                shortDisplayName: 'Claude 4.6',
                modelProvider: 'anthropic',
                supportedReasoningEfforts: ['medium', 'high'],
                tokenMultiplier: 1,
            },
            {
                id: 'gpt-5.4',
                displayName: 'GPT 5.4',
                shortDisplayName: 'GPT 5.4',
                modelProvider: 'openai',
                supportedReasoningEfforts: ['none', 'off'],
                tokenMultiplier: 1.5,
            },
        ];
        const models = await fetchFactoryModels('test-key', '/workspace');

        expect(createSession).toHaveBeenCalledWith({
            apiKey: 'test-key',
            cwd: '/workspace',
        });
        expect(models).toHaveLength(2);
        expect(models[0]).toMatchObject({
            id: 'claude-sonnet-4-6',
            name: 'Claude Sonnet 4.6',
            shortName: 'Claude 4.6',
            provider: 'anthropic',
            multiplier: 1,
        });
        expect(models[1]).toMatchObject({
            id: 'gpt-5.4',
            name: 'GPT 5.4',
            multiplier: 1.5,
        });
        // One short-lived session for the whole discovery, closed exactly once.
        expect(closeSession).toHaveBeenCalledTimes(1);
    });

    it('derives reasoning from the supported reasoning efforts, never hardcodes it', async () => {
        availableModels = [
            {
                id: 'reasoning-model',
                displayName: 'Reasoning',
                shortDisplayName: 'R',
                modelProvider: 'anthropic',
                supportedReasoningEfforts: ['low', 'high'],
            },
            {
                id: 'plain-model',
                displayName: 'Plain',
                shortDisplayName: 'P',
                modelProvider: 'openai',
                supportedReasoningEfforts: ['none', 'off'],
            },
        ];
        const models = await fetchFactoryModels('test-key');

        expect(models[0].reasoning).toBe(true);
        expect(models[1].reasoning).toBe(false);
    });

    it('derives image input from noImageSupport, keeping the SDK decision', async () => {
        availableModels = [
            {
                id: 'image-capable',
                displayName: 'Image Capable',
                shortDisplayName: 'IC',
                modelProvider: 'google',
                supportedReasoningEfforts: ['high'],
            },
            {
                id: 'text-only',
                displayName: 'Text Only',
                shortDisplayName: 'TO',
                modelProvider: 'google',
                supportedReasoningEfforts: ['high'],
                noImageSupport: true,
            },
        ];
        const models = await fetchFactoryModels('test-key');

        expect(models[0].input).toEqual(['text', 'image']);
        expect(models[1].input).toEqual(['text']);
    });

    it('filters custom models out of the catalog', async () => {
        availableModels = [
            {
                id: 'claude-sonnet-4-6',
                displayName: 'Claude Sonnet 4.6',
                shortDisplayName: 'Claude 4.6',
                modelProvider: 'anthropic',
                supportedReasoningEfforts: ['high'],
            },
            {
                id: 'my-custom-model',
                displayName: 'My Custom',
                shortDisplayName: 'MC',
                modelProvider: 'factory',
                supportedReasoningEfforts: [],
                isCustom: true,
            },
        ];
        const models = await fetchFactoryModels('test-key');

        expect(models).toHaveLength(1);
        expect(models[0].id).toBe('claude-sonnet-4-6');
    });

    it('throws when the SDK exposes no usable models', async () => {
        availableModels = [
            {
                id: 'custom-only',
                displayName: 'Custom',
                shortDisplayName: 'C',
                modelProvider: 'factory',
                supportedReasoningEfforts: [],
                isCustom: true,
            },
        ];
        await expect(fetchFactoryModels('test-key')).rejects.toThrow(
            'no available models',
        );
    });
});

// ── toProviderModels enrichment ──

describe('toProviderModels enrichment', () => {
    it('fills context, output, and cost from an exact catalog record over fallback facts', () => {
        const catalog = lookupStub([
            providerMatch('anthropic', 'claude-sonnet-4-6', {
                name: 'Claude Sonnet 4.6',
                contextWindow: 200_000,
                maxTokens: 64_000,
                cost: { input: 2, output: 10, cacheRead: 1, cacheWrite: 0.5 },
            }),
        ]);
        const [model] = toProviderModels([makeEntry()], catalog);

        expect(model.id).toBe('claude-sonnet-4-6');
        expect(model.contextWindow).toBe(200_000);
        expect(model.maxTokens).toBe(64_000);
        expect(model.cost).toEqual({
            input: 2,
            output: 10,
            cacheRead: 1,
            cacheWrite: 0.5,
        });
    });

    it('keeps Factory-owned route costs as explicit overrides over catalog costs', () => {
        const catalog = lookupStub([
            baseMatch('zhipuai/glm-5.2', {
                name: 'GLM 5.2',
                contextWindow: 2_000_000,
                maxTokens: 163_840,
                cost: { input: 0.1, output: 0.3, cacheRead: 0.05, cacheWrite: 0.02 },
            }),
        ]);
        const entry = makeEntry({
            id: 'glm-5.2',
            name: 'GLM 5.2',
            provider: 'factory',
            costInput: 0.5,
            costOutput: 2,
        });
        const [model] = toProviderModels([entry], catalog);

        // Catalog metadata still fills context/max tokens…
        expect(model.contextWindow).toBe(2_000_000);
        expect(model.maxTokens).toBe(163_840);
        // …but the Factory route price is authoritative over any catalog cost.
        expect(model.cost).toEqual({
            input: 0.5,
            output: 2,
            cacheRead: 0.05,
            cacheWrite: 0.02,
        });
    });

    it('applies the kimi Factory route cost override over catalog cost', () => {
        const catalog = lookupStub([
            baseMatch('moonshotai/kimi-k2.6', {
                name: 'Kimi K2.6',
                cost: { input: 0.05, output: 0.1 },
            }),
        ]);
        const entry = makeEntry({
            id: 'kimi-k2.6',
            name: 'Kimi K2.6',
            provider: 'factory',
            costInput: 0.95,
            costOutput: 4,
        });
        const [model] = toProviderModels([entry], catalog);

        expect(model.cost).toEqual({
            input: 0.95,
            output: 4,
            cacheRead: 0,
            cacheWrite: 0,
        });
    });

    it('preserves provider fallback facts when the catalog has no record', () => {
        const [model] = toProviderModels([makeEntry()], emptyLookup);

        // anthropic sonnet-4-6 family fallback facts stay intact
        expect(model.contextWindow).toBe(1_000_000);
        expect(model.maxTokens).toBe(128_000);
        expect(model.cost).toEqual({
            input: 3,
            output: 15,
            cacheRead: 0,
            cacheWrite: 0,
        });
    });

    it('never lets the catalog change SDK identity, display name, reasoning, or input', () => {
        const catalog = lookupStub([
            providerMatch('anthropic', 'claude-sonnet-4-6', {
                name: 'COMPLETELY WRONG NAME',
                reasoning: false,
                inputModalities: ['text'],
            }),
        ]);
        const [model] = toProviderModels([makeEntry()], catalog);

        expect(model.id).toBe('claude-sonnet-4-6');
        expect(model.name).toBe('Claude Sonnet 4.6 [1×]');
        expect(model.reasoning).toBe(true);
        expect(model.input).toEqual(['text', 'image']);
    });
});

// ── toResolvedFactoryModels parity ──

describe('toResolvedFactoryModels', () => {
    it('produces identical capability and cost output as toProviderModels', () => {
        const catalog = lookupStub([
            baseMatch('zhipuai/glm-5.2', {
                name: 'GLM 5.2',
                contextWindow: 2_000_000,
                maxTokens: 163_840,
                cost: { input: 0.1, output: 0.3, cacheRead: 0.05, cacheWrite: 0.02 },
            }),
        ]);
        const entries = [
            makeEntry({
                id: 'glm-5.2',
                name: 'GLM 5.2',
                provider: 'factory',
                multiplier: 2,
                costInput: 0.5,
                costOutput: 2,
            }),
            makeEntry({ multiplier: 1 }),
        ];

        const providerModels = toProviderModels(entries, catalog);
        const resolved = toResolvedFactoryModels(
            'factory-ai',
            'https://api.factory.ai',
            'openai-completions',
            entries,
            catalog,
        );

        expect(resolved).toHaveLength(2);
        for (let i = 0; i < resolved.length; i++) {
            const r = resolved[i];
            const p = providerModels[i];
            expect(r.id).toBe(p.id);
            expect(r.name).toBe(p.name);
            expect(r.reasoning).toBe(p.reasoning);
            expect(r.input).toEqual(p.input);
            expect(r.contextWindow).toBe(p.contextWindow);
            expect(r.maxTokens).toBe(p.maxTokens);
            expect(r.cost).toEqual(p.cost);
        }
        // Resolved models carry the provider route identity.
        expect(resolved[0]).toMatchObject({
            provider: 'factory-ai',
            baseUrl: 'https://api.factory.ai',
        });
    });
});
