import { describe, expect, mock, test } from 'bun:test';
import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent';
import { createCpaCatalogGuard } from './cpa-catalog-guard.ts';

const liveModel: ProviderModelConfig = {
    id: 'ocg/go-deepseek-v4-pro',
    name: 'DeepSeek V4 Pro (Go)',
    reasoning: true,
    input: ['text'],
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    cost: { input: 1.74, output: 3.48, cacheRead: 0.0145, cacheWrite: 0 },
};

describe('createCpaCatalogGuard', () => {
    test('marks a CPA model stale when an authoritative live catalog removes it', async () => {
        const registerModels = mock(() => {});
        const guard = createCpaCatalogGuard({
            refreshTtlMs: 30_000,
            now: () => 1_000,
        });

        const result = await guard.refresh({
            force: true,
            activeModel: { provider: 'cpa', id: 'ocg/deepseek-v4-pro' },
            loadCatalog: async () => ({ models: [liveModel], source: 'live' }),
            registerModels,
            hasModel: (_provider, id) => id === liveModel.id,
        });

        expect(result).toEqual({
            state: 'stale',
            modelId: 'ocg/deepseek-v4-pro',
            refreshed: true,
        });
        expect(registerModels).toHaveBeenCalledWith([liveModel]);
    });

    test('keeps the current registry and fails open when CPA returns fallback', async () => {
        const registerModels = mock(() => {});
        const guard = createCpaCatalogGuard({
            refreshTtlMs: 30_000,
            now: () => 1_000,
        });

        const result = await guard.refresh({
            force: true,
            activeModel: { provider: 'cpa', id: 'ocg/go-deepseek-v4-pro' },
            loadCatalog: async () => ({
                models: [liveModel],
                source: 'fallback',
            }),
            registerModels,
            hasModel: () => false,
        });

        expect(result).toEqual({
            state: 'unverified',
            modelId: 'ocg/go-deepseek-v4-pro',
            refreshed: true,
        });
        expect(registerModels).not.toHaveBeenCalled();
    });

    test('reuses the last decision while the refresh TTL is fresh', async () => {
        let currentTime = 1_000;
        const loadCatalog = mock(async () => ({
            models: [liveModel],
            source: 'live' as const,
        }));
        const guard = createCpaCatalogGuard({
            refreshTtlMs: 30_000,
            now: () => currentTime,
        });
        const input = {
            activeModel: { provider: 'cpa', id: liveModel.id },
            loadCatalog,
            registerModels: () => {},
            hasModel: () => true,
        };

        await guard.refresh(input);
        currentTime = 2_000;
        const cached = await guard.refresh(input);

        expect(cached).toEqual({
            state: 'valid',
            modelId: liveModel.id,
            refreshed: false,
        });
        expect(loadCatalog).toHaveBeenCalledTimes(1);
    });

    test('shares one in-flight catalog refresh across concurrent callers', async () => {
        let resolveCatalog:
            | ((value: {
                  models: ProviderModelConfig[];
                  source: 'live';
              }) => void)
            | undefined;
        const catalogPromise = new Promise<{
            models: ProviderModelConfig[];
            source: 'live';
        }>((resolve) => {
            resolveCatalog = resolve;
        });
        const loadCatalog = mock(() => catalogPromise);
        const guard = createCpaCatalogGuard({
            refreshTtlMs: 30_000,
            now: () => 1_000,
        });
        const input = {
            activeModel: { provider: 'cpa', id: liveModel.id },
            loadCatalog,
            registerModels: () => {},
            hasModel: () => true,
        };

        const first = guard.refresh(input);
        const second = guard.refresh(input);
        resolveCatalog?.({ models: [liveModel], source: 'live' });

        expect(await first).toEqual({
            state: 'valid',
            modelId: liveModel.id,
            refreshed: true,
        });
        expect(await second).toEqual({
            state: 'valid',
            modelId: liveModel.id,
            refreshed: true,
        });
        expect(loadCatalog).toHaveBeenCalledTimes(1);
    });

    test('preserves a confirmed stale decision when a later refresh falls back', async () => {
        let catalog: {
            models: ProviderModelConfig[];
            source: 'live' | 'fallback';
        } = {
            models: [liveModel],
            source: 'live',
        };
        const guard = createCpaCatalogGuard({
            refreshTtlMs: 30_000,
            now: () => 1_000,
        });
        const input = {
            force: true,
            activeModel: { provider: 'cpa', id: 'ocg/deepseek-v4-pro' },
            loadCatalog: async () => catalog,
            registerModels: () => {},
            hasModel: () => false,
        };

        await guard.refresh(input);
        catalog = { models: [liveModel], source: 'fallback' };
        const result = await guard.refresh(input);

        expect(result).toEqual({
            state: 'stale',
            modelId: 'ocg/deepseek-v4-pro',
            refreshed: true,
        });
    });

    test('does not carry a stale decision to a different active model', async () => {
        let catalog: {
            models: ProviderModelConfig[];
            source: 'live' | 'fallback';
        } = {
            models: [liveModel],
            source: 'live',
        };
        const guard = createCpaCatalogGuard({
            refreshTtlMs: 30_000,
            now: () => 1_000,
        });
        const baseInput = {
            force: true,
            loadCatalog: async () => catalog,
            registerModels: () => {},
            hasModel: () => false,
        };

        await guard.refresh({
            ...baseInput,
            activeModel: { provider: 'cpa', id: 'ocg/deepseek-v4-pro' },
        });
        catalog = { models: [liveModel], source: 'fallback' };
        const result = await guard.refresh({
            ...baseInput,
            activeModel: { provider: 'cpa', id: liveModel.id },
        });

        expect(result).toEqual({
            state: 'unverified',
            modelId: liveModel.id,
            refreshed: true,
        });
    });
});
