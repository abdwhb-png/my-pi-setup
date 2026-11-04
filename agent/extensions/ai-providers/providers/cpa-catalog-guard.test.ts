import { describe, expect, mock, test } from 'bun:test';
import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent';
import { createCpaCatalogGuard } from './cpa-catalog-guard.ts';
import type { CpaCatalogResult } from './cpa-models.ts';

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
        const guard = createCpaCatalogGuard({
            refreshTtlMs: 30_000,
            now: () => 1_000,
        });

        const result = await guard.refresh({
            force: true,
            activeModel: { provider: 'cpa', id: 'ocg/deepseek-v4-pro' },
            loadCatalog: async () => ({
                models: [liveModel],
                entries: [],
                source: 'live',
            }),
        });

        expect(result).toEqual({
            catalog: { models: [liveModel], entries: [], source: 'live' },
            state: 'stale',
            modelId: 'ocg/deepseek-v4-pro',
            refreshed: true,
        });
    });

    test('withdraws the current catalog when CPA cannot be verified', async () => {
        const guard = createCpaCatalogGuard({
            refreshTtlMs: 30_000,
            now: () => 1_000,
        });

        const result = await guard.refresh({
            force: true,
            activeModel: { provider: 'cpa', id: 'ocg/go-deepseek-v4-pro' },
            loadCatalog: async () => ({
                models: [],
                entries: [],
                source: 'unavailable',
                failure: { kind: 'http', status: 401 },
            }),
        });

        expect(result).toEqual({
            catalog: {
                models: [],
                entries: [],
                source: 'unavailable',
                failure: { kind: 'http', status: 401 },
            },
            state: 'unverified',
            modelId: 'ocg/go-deepseek-v4-pro',
            refreshed: true,
            failure: { kind: 'http', status: 401 },
        });
    });

    test('reuses the last decision while the refresh TTL is fresh', async () => {
        let currentTime = 1_000;
        const loadCatalog = mock(async () => ({
            models: [liveModel],
            entries: [],
            source: 'live' as const,
        }));
        const guard = createCpaCatalogGuard({
            refreshTtlMs: 30_000,
            now: () => currentTime,
        });
        const input = {
            activeModel: { provider: 'cpa', id: liveModel.id },
            loadCatalog,
        };

        await guard.refresh(input);
        currentTime = 2_000;
        const cached = await guard.refresh(input);

        expect(cached).toEqual({
            catalog: { models: [liveModel], entries: [], source: 'live' },
            state: 'valid',
            modelId: liveModel.id,
            refreshed: false,
        });
        expect(loadCatalog).toHaveBeenCalledTimes(1);
    });

    test('shares one in-flight catalog refresh across concurrent callers', async () => {
        let resolveCatalog: ((value: CpaCatalogResult) => void) | undefined;
        const catalogPromise = new Promise<CpaCatalogResult>((resolve) => {
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
        };

        const first = guard.refresh(input);
        const second = guard.refresh(input);
        resolveCatalog?.({ models: [liveModel], entries: [], source: 'live' });

        expect(await first).toEqual({
            catalog: { models: [liveModel], entries: [], source: 'live' },
            state: 'valid',
            modelId: liveModel.id,
            refreshed: true,
        });
        expect(await second).toEqual({
            catalog: { models: [liveModel], entries: [], source: 'live' },
            state: 'valid',
            modelId: liveModel.id,
            refreshed: true,
        });
        expect(loadCatalog).toHaveBeenCalledTimes(1);
    });

    test('marks verification unavailable when a later refresh fails after a stale decision', async () => {
        let catalog: CpaCatalogResult = {
            models: [liveModel],
            entries: [],
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
        };

        await guard.refresh(input);
        catalog = {
            models: [],
            entries: [],
            source: 'unavailable',
            failure: { kind: 'network' },
        };
        const result = await guard.refresh(input);

        expect(result).toEqual({
            catalog: {
                models: [],
                entries: [],
                source: 'unavailable',
                failure: { kind: 'network' },
            },
            state: 'unverified',
            modelId: 'ocg/deepseek-v4-pro',
            refreshed: true,
            failure: { kind: 'network' },
        });
    });

    test('does not carry a stale decision to a different active model', async () => {
        let catalog: CpaCatalogResult = {
            models: [liveModel],
            entries: [],
            source: 'live',
        };
        const guard = createCpaCatalogGuard({
            refreshTtlMs: 30_000,
            now: () => 1_000,
        });
        const baseInput = {
            force: true,
            loadCatalog: async () => catalog,
        };

        await guard.refresh({
            ...baseInput,
            activeModel: { provider: 'cpa', id: 'ocg/deepseek-v4-pro' },
        });
        catalog = {
            models: [],
            entries: [],
            source: 'unavailable',
            failure: { kind: 'network' },
        };
        const result = await guard.refresh({
            ...baseInput,
            activeModel: { provider: 'cpa', id: liveModel.id },
        });

        expect(result).toEqual({
            catalog: {
                models: [],
                entries: [],
                source: 'unavailable',
                failure: { kind: 'network' },
            },
            state: 'unverified',
            modelId: liveModel.id,
            refreshed: true,
            failure: { kind: 'network' },
        });
    });
});
