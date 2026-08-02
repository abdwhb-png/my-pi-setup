import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createModelsDevCatalog } from '../_shared/models-dev/catalog';
import type {
    ModelsDevCatalog,
    ModelsDevFetchFn,
} from '../_shared/models-dev/catalog';
import { lookupPricing } from './pricing';

/** Shared cost block reused across provider and base catalog records. */
const GPT4O_COST = {
    input: 2.5,
    output: 10,
    cache_read: 1.25,
    cache_write: 2.5,
};

const FLASH_COST = {
    input: 0.14,
    output: 0.28,
    cache_read: 0.014,
    cache_write: 0.14,
};

const PRO_COST = {
    input: 1.74,
    output: 3.48,
    cache_read: 0.174,
    cache_write: 0.87,
};

/** Version-1 cache envelope covering provider and base records. */
const catalogEnvelope = {
    version: 1,
    fetchedAt: 1_700_000_000_000,
    providers: {
        openai: {
            models: {
                'gpt-4o': { name: 'GPT-4o', cost: GPT4O_COST },
                'zero-cost': {
                    name: 'Zero Cost',
                    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
                },
                'no-cost': { name: 'No Cost' },
            },
        },
        openrouter: {
            models: {
                'deepseek/deepseek-v4-flash': {
                    name: 'DeepSeek V4 Flash',
                    cost: FLASH_COST,
                },
            },
        },
        'opencode-go': {
            models: {
                'deepseek-v4-flash': {
                    name: 'DeepSeek V4 Flash (Go)',
                    cost: FLASH_COST,
                },
            },
        },
    },
    models: {
        'deepseek/deepseek-v4-pro': { name: 'DeepSeek V4 Pro', cost: PRO_COST },
    },
};

/** Network payload with a different gpt-4o price to prove stale snapshot serving. */
const updatedPayload = {
    providers: {
        openai: {
            models: {
                'gpt-4o': {
                    name: 'GPT-4o',
                    cost: { input: 5, output: 20, cache_read: 2.5, cache_write: 5 },
                },
            },
        },
    },
    models: {},
};

const tempDirs: string[] = [];

function makeCatalog(
    options: {
        fetchFn?: ModelsDevFetchFn;
        ttlMs?: number;
    } = {},
): { cachePath: string; catalog: ModelsDevCatalog } {
    const dir = mkdtempSync(join(tmpdir(), 'usage-pricing-test-'));
    tempDirs.push(dir);
    const cachePath = join(dir, 'models-dev-catalog-v1.json');
    return {
        cachePath,
        catalog: createModelsDevCatalog({ cachePath, ...options }),
    };
}

function makeCatalogWithCache(
    envelope: unknown,
    options: {
        fetchFn?: ModelsDevFetchFn;
        ttlMs?: number;
    } = {},
): { cachePath: string; catalog: ModelsDevCatalog } {
    const made = makeCatalog(options);
    writeFileSync(made.cachePath, JSON.stringify(envelope));
    return made;
}

afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) rmSync(dir, { recursive: true, force: true });
    }
});

describe('lookupPricing', () => {
    it('resolves ordinary provider/model keys to all four rates', async () => {
        const { catalog } = makeCatalogWithCache(catalogEnvelope);

        const result = await lookupPricing(['openai/gpt-4o'], catalog);

        const rates = result.get('openai/gpt-4o');
        expect(rates).toBeDefined();
        expect(rates!.modelKey).toBe('openai/gpt-4o');
        expect(rates!.inputPerMillion).toBe(2.5);
        expect(rates!.outputPerMillion).toBe(10);
        expect(rates!.cacheReadPerMillion).toBe(1.25);
        expect(rates!.cacheWritePerMillion).toBe(2.5);
        expect(rates!.source).toBe('cached');
    });

    it('maps CPA source keys through the shared mapping to the same catalog records as providers', async () => {
        const { catalog } = makeCatalogWithCache(catalogEnvelope);

        const providerRates = await lookupPricing(
            ['openrouter/deepseek/deepseek-v4-flash'],
            catalog,
        );
        const cpaRates = await lookupPricing(
            ['cpa/deepseek/deepseek-v4-flash'],
            catalog,
        );
        const cpaGoRates = await lookupPricing(
            ['cpa/ocg/go-deepseek-v4-flash'],
            catalog,
        );

        const fromProvider = providerRates.get(
            'openrouter/deepseek/deepseek-v4-flash',
        )!;
        const fromCpa = cpaRates.get('cpa/deepseek/deepseek-v4-flash')!;
        const fromCpaGo = cpaGoRates.get('cpa/ocg/go-deepseek-v4-flash')!;

        expect(fromCpa).toEqual({
            ...fromProvider,
            modelKey: 'cpa/deepseek/deepseek-v4-flash',
        });
        expect(fromCpaGo).toEqual({
            ...fromProvider,
            modelKey: 'cpa/ocg/go-deepseek-v4-flash',
        });
    });

    it('applies Factory route overrides while preserving catalog cache prices', async () => {
        const { catalog } = makeCatalogWithCache(catalogEnvelope);

        const result = await lookupPricing(
            ['factory-ai/deepseek-v4-pro'],
            catalog,
        );

        const rates = result.get('factory-ai/deepseek-v4-pro');
        expect(rates).toBeDefined();
        expect(rates!.inputPerMillion).toBe(0.5);
        expect(rates!.outputPerMillion).toBe(2);
        expect(rates!.cacheReadPerMillion).toBe(0.174);
        expect(rates!.cacheWritePerMillion).toBe(0.87);
        expect(rates!.source).toBe('override');
    });

    it('prices a known Factory route even without a models.dev match', async () => {
        const { catalog } = makeCatalogWithCache(catalogEnvelope);

        const result = await lookupPricing(['factory-ai/minimax-m3'], catalog);

        expect(result.get('factory-ai/minimax-m3')).toEqual({
            modelKey: 'factory-ai/minimax-m3',
            inputPerMillion: 0.5,
            outputPerMillion: 2,
            cacheReadPerMillion: 0,
            cacheWritePerMillion: 0,
            source: 'override',
        });
    });

    it('treats explicit zero costs as available but costless records as unavailable', async () => {
        const { catalog } = makeCatalogWithCache(catalogEnvelope);

        const result = await lookupPricing(
            ['openai/zero-cost', 'openai/no-cost'],
            catalog,
        );

        const zero = result.get('openai/zero-cost');
        expect(zero).toBeDefined();
        expect(zero!.inputPerMillion).toBe(0);
        expect(zero!.outputPerMillion).toBe(0);
        expect(zero!.cacheReadPerMillion).toBe(0);
        expect(zero!.cacheWritePerMillion).toBe(0);
        expect(zero!.source).toBe('cached');

        const noCost = result.get('openai/no-cost');
        expect(noCost).toBeDefined();
        expect(noCost!.source).toBe('unavailable');
        expect(noCost!.inputPerMillion).toBe(0);
        expect(noCost!.outputPerMillion).toBe(0);
        expect(noCost!.cacheReadPerMillion).toBe(0);
        expect(noCost!.cacheWritePerMillion).toBe(0);
    });

    it('never falls through to contains-style matching for near misses', async () => {
        const { catalog } = makeCatalogWithCache(catalogEnvelope);

        const result = await lookupPricing(
            ['openai/gpt-4o-mini', 'openai/gpt-4'],
            catalog,
        );

        expect(result.get('openai/gpt-4o-mini')?.source).toBe('unavailable');
        expect(result.get('openai/gpt-4')?.source).toBe('unavailable');
    });

    it('rejects malformed source keys as unavailable', async () => {
        const { catalog } = makeCatalogWithCache(catalogEnvelope);

        const result = await lookupPricing(
            ['', 'openai', '/gpt-4o', 'openai/', 'openai/   '],
            catalog,
        );

        for (const key of ['', 'openai', '/gpt-4o', 'openai/', 'openai/   ']) {
            expect(result.get(key)?.source, key).toBe('unavailable');
        }
    });

    it('returns an empty map for empty source keys without touching the catalog', async () => {
        const fetchFn = mock(async () => new Response('nope', { status: 500 }));
        const { catalog } = makeCatalog({ fetchFn });

        const result = await lookupPricing([], catalog);

        expect(result.size).toBe(0);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('maps cache provenance to cached and network provenance to models.dev', async () => {
        const cached = makeCatalogWithCache(catalogEnvelope);
        const cachedResult = await lookupPricing(['openai/gpt-4o'], cached.catalog);
        expect(cachedResult.get('openai/gpt-4o')?.source).toBe('cached');

        const fetchFn = mock(
            async () => new Response(JSON.stringify(updatedPayload), { status: 200 }),
        );
        const networked = makeCatalog({ fetchFn });
        const networkResult = await lookupPricing(['openai/gpt-4o'], networked.catalog);
        expect(networkResult.get('openai/gpt-4o')?.source).toBe('models.dev');
        expect(networkResult.get('openai/gpt-4o')?.inputPerMillion).toBe(5);
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('awaits exactly one refresh when no snapshot exists', async () => {
        const fetchFn = mock(
            async () => new Response(JSON.stringify(updatedPayload), { status: 200 }),
        );
        const { catalog } = makeCatalog({ fetchFn });

        const result = await lookupPricing(['openai/gpt-4o'], catalog);

        expect(result.get('openai/gpt-4o')?.inputPerMillion).toBe(5);
        expect(result.get('openai/gpt-4o')?.source).toBe('models.dev');
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('serves an existing snapshot immediately while refreshing in the background', async () => {
        const fetchFn = mock(
            async () => new Response(JSON.stringify(updatedPayload), { status: 200 }),
        );
        const { catalog } = makeCatalogWithCache(catalogEnvelope, {
            fetchFn,
            ttlMs: 0,
        });

        const result = await lookupPricing(['openai/gpt-4o'], catalog);

        // Served from the stale snapshot before the background refresh lands.
        expect(result.get('openai/gpt-4o')?.inputPerMillion).toBe(2.5);
        expect(result.get('openai/gpt-4o')?.source).toBe('cached');

        // The non-blocking freshness check still runs and lands.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(catalog.getStatus().provenance).toBe('network');
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('fetches once for many source keys sharing one snapshot', async () => {
        const fetchFn = mock(
            async () => new Response(JSON.stringify(updatedPayload), { status: 200 }),
        );
        const { catalog } = makeCatalog({ fetchFn });

        const result = await lookupPricing(
            ['openai/gpt-4o', 'openai/gpt-4o-mini', 'cpa/deepseek/deepseek-v4-flash'],
            catalog,
        );

        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(result.get('openai/gpt-4o')?.source).toBe('models.dev');
        expect(result.get('openai/gpt-4o-mini')?.source).toBe('unavailable');
        expect(result.get('cpa/deepseek/deepseek-v4-flash')?.source).toBe(
            'unavailable',
        );
    });
});
