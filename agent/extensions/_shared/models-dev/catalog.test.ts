import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    createModelsDevCatalog,
    getModelsDevCatalog,
    resetModelsDevCatalogForTests,
} from './catalog';
import type { ModelsDevCatalog, ModelsDevFetchFn } from './catalog';

/** Raw models.dev catalog.json record (provider-scoped and base share the same shape). */
const providerModelRecord = {
    id: 'gpt-4o',
    name: 'GPT-4o',
    reasoning: true,
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: 128000, output: 16384 },
    cost: { input: 2.5, output: 10, cache_read: 1.25, cache_write: 2.5 },
};

const baseModelRecord = {
    id: 'openai/gpt-4o',
    name: 'GPT-4o',
    reasoning: true,
    modalities: { input: ['text'], output: ['text'] },
    limit: { context: 128000, output: 16384 },
    cost: { input: 2.5, output: 10, cache_read: 1.25, cache_write: 2.5 },
};

/** Smallest payload shaped like the current models.dev catalog.json. */
const rawPayload = {
    providers: {
        openai: {
            id: 'openai',
            name: 'OpenAI',
            doc: 'https://platform.openai.com',
            models: { 'gpt-4o': providerModelRecord },
        },
    },
    models: { 'openai/gpt-4o': baseModelRecord },
};

/** Version-1 cache envelope as persisted by the catalog. */
const cacheEnvelope = {
    version: 1,
    fetchedAt: 1_700_000_000_000,
    etag: 'W/"abc123"',
    providers: { openai: { models: { 'gpt-4o': providerModelRecord } } },
    models: { 'openai/gpt-4o': baseModelRecord },
};

const tempDirs: string[] = [];

function makeCatalog(
    options: {
        ttlMs?: number;
        timeoutMs?: number;
        now?: () => number;
        fetchFn?: ModelsDevFetchFn;
    } = {},
): { dir: string; cachePath: string; catalog: ModelsDevCatalog } {
    const dir = mkdtempSync(join(tmpdir(), 'models-dev-catalog-test-'));
    tempDirs.push(dir);
    const cachePath = join(dir, 'models-dev-catalog-v1.json');
    return { dir, cachePath, catalog: createModelsDevCatalog({ cachePath, ...options }) };
}

function makeCatalogWithCache(
    envelope: unknown,
    options: {
        ttlMs?: number;
        timeoutMs?: number;
        now?: () => number;
        fetchFn?: ModelsDevFetchFn;
    } = {},
): { dir: string; cachePath: string; catalog: ModelsDevCatalog } {
    const made = makeCatalog(options);
    writeFileSync(made.cachePath, JSON.stringify(envelope));
    return made;
}

afterEach(() => {
    resetModelsDevCatalogForTests();
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) rmSync(dir, { recursive: true, force: true });
    }
});

describe('lookupMerge', () => {
    it('merges provider and base records field-by-field, first ref wins per field', async () => {
        const envelope = {
            version: 1,
            fetchedAt: 1_700_000_000_000,
            providers: {
                openai: {
                    models: {
                        'gpt-5.4': {
                            name: 'GPT 5.4',
                            cost: { input: 1.25, output: 10, cache_read: 0.5, cache_write: 0.25 },
                        },
                    },
                },
            },
            models: {
                'openai/gpt-5.4': {
                    name: 'GPT 5.4 Base',
                    reasoning: true,
                    contextWindow: 1_000_000,
                    maxTokens: 128_000,
                    inputModalities: ['text', 'image'],
                    cost: { input: 2.5, output: 10, cache_read: 1.25, cache_write: 2.5 },
                },
            },
        };
        const { catalog } = makeCatalogWithCache(envelope);
        await catalog.load();

        const merged = catalog.lookupMerge([
            { scope: 'provider' as const, providerId: 'openai', modelId: 'gpt-5.4' },
            { scope: 'model' as const, modelId: 'openai/gpt-5.4' },
        ]);

        expect(merged).toBeDefined();
        // Provider name wins (first ref)
        expect(merged!.name).toBe('GPT 5.4');
        // Base fills reasoning, context, maxTokens, input (absent in provider)
        expect(merged!.reasoning).toBe(true);
        expect(merged!.contextWindow).toBe(1_000_000);
        expect(merged!.maxTokens).toBe(128_000);
        expect(merged!.inputModalities).toEqual(['text', 'image']);
        // Provider cost wins per-field (first ref)
        expect(merged!.cost).toEqual({ input: 1.25, output: 10, cacheRead: 0.5, cacheWrite: 0.25 });
    });

    it('preserves explicit zero and false from first matching ref', async () => {
        const envelope = {
            version: 1,
            fetchedAt: 1_700_000_000_000,
            providers: {
                acme: {
                    models: {
                        'acme/free': {
                            name: 'Free Tier',
                            reasoning: false,
                            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        },
                    },
                },
            },
            models: {
                'acme/free': {
                    name: 'Free Tier Base',
                    reasoning: true,
                    contextWindow: 200_000,
                    cost: { input: 5, output: 10, cacheRead: 5, cacheWrite: 10 },
                },
            },
        };
        const { catalog } = makeCatalogWithCache(envelope);
        await catalog.load();

        const merged = catalog.lookupMerge([
            { scope: 'provider' as const, providerId: 'acme', modelId: 'acme/free' },
            { scope: 'model' as const, modelId: 'acme/free' },
        ]);

        expect(merged!.reasoning).toBe(false);
        expect(merged!.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        // contextWindow filled from base (absent in provider)
        expect(merged!.contextWindow).toBe(200_000);
    });

    it('returns undefined when no ref matches', async () => {
        const { catalog } = makeCatalogWithCache(cacheEnvelope);
        await catalog.load();

        expect(catalog.lookupMerge([
            { scope: 'provider', providerId: 'nonexistent', modelId: 'no-match' },
        ])).toBeUndefined();
    });

    it('returns the only match when one ref matches', async () => {
        const { catalog } = makeCatalogWithCache(cacheEnvelope);
        await catalog.load();

        const merged = catalog.lookupMerge([
            { scope: 'provider', providerId: 'openai', modelId: 'gpt-4o' },
            { scope: 'model', modelId: 'openai/gpt-4o-missing' },
        ]);

        expect(merged!.name).toBe('GPT-4o');
        expect(merged!.reasoning).toBe(true);
    });
});

describe('lookupFirst', () => {
    it('resolves exact provider and base references, never partial IDs', async () => {
        const { catalog } = makeCatalogWithCache(cacheEnvelope);
        await catalog.load();

        const providerRef = { scope: 'provider' as const, providerId: 'openai', modelId: 'gpt-4o' };
        const baseRef = { scope: 'model' as const, modelId: 'openai/gpt-4o' };

        const match = catalog.lookupFirst([providerRef, baseRef]);
        expect(match).toBeDefined();
        expect(match?.ref).toEqual(providerRef);
        expect(match?.model.name).toBe('GPT-4o');

        expect(catalog.lookupFirst([baseRef])?.model.name).toBe('GPT-4o');

        expect(
            catalog.lookupFirst([{ scope: 'provider', providerId: 'openai', modelId: 'gpt-4o-mini' }]),
        ).toBeUndefined();
        expect(catalog.lookupFirst([{ scope: 'model', modelId: 'openai/gpt-4' }])).toBeUndefined();
        expect(catalog.lookupFirst([{ scope: 'provider', providerId: 'open', modelId: 'gpt-4o' }])).toBeUndefined();
        expect(catalog.lookupFirst([])).toBeUndefined();
    });

    it('keeps missing costs absent while explicit zeros remain intact', async () => {
        const envelope = {
            version: 1,
            fetchedAt: 1_700_000_000_000,
            providers: {
                acme: {
                    models: {
                        noCost: { name: 'No Cost', limit: { context: 1000, output: 500 } },
                        zeroCost: { name: 'Zero Cost', cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } },
                    },
                },
            },
            models: {},
        };
        const { catalog } = makeCatalogWithCache(envelope);
        await catalog.load();

        const noCost = catalog.lookupFirst([{ scope: 'provider', providerId: 'acme', modelId: 'noCost' }]);
        expect(noCost?.model.cost).toBeUndefined();
        expect(noCost?.model.contextWindow).toBe(1000);

        const zeroCost = catalog.lookupFirst([{ scope: 'provider', providerId: 'acme', modelId: 'zeroCost' }]);
        expect(zeroCost?.model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    });

    it('defaults missing names to the record ID when a structural witness exists', async () => {
        // { reasoning: true } has one valid witness → name fallback applies.
        const envelope = {
            version: 1,
            fetchedAt: 1_700_000_000_000,
            providers: {},
            models: {
                'acme/solo': { reasoning: true },
            },
        };
        const { catalog } = makeCatalogWithCache(envelope);
        await catalog.load();

        const match = catalog.lookupFirst([{ scope: 'model', modelId: 'acme/solo' }]);
        expect(match?.model.name).toBe('acme/solo');
        expect(match?.model.reasoning).toBe(true);
    });

    it('skips records with no structural witness (empty, invalid-only, unknown-only)', async () => {
        const envelope = {
            version: 1,
            fetchedAt: 1_700_000_000_000,
            providers: {},
            models: {
                'acme/empty': {},
                'acme/invalid-only': { reasoning: 'yes' },
                'acme/unknown-only': { deprecated: true, version: 2 },
                'acme/valid': { name: 'Valid' },
            },
        };
        const { catalog } = makeCatalogWithCache(envelope);
        await catalog.load();

        expect(catalog.lookupFirst([{ scope: 'model', modelId: 'acme/empty' }])).toBeUndefined();
        expect(catalog.lookupFirst([{ scope: 'model', modelId: 'acme/invalid-only' }])).toBeUndefined();
        expect(catalog.lookupFirst([{ scope: 'model', modelId: 'acme/unknown-only' }])).toBeUndefined();
        const valid = catalog.lookupFirst([{ scope: 'model', modelId: 'acme/valid' }]);
        expect(valid?.model.name).toBe('Valid');
    });

    it('keeps an empty modality array as valid and ignores arrays with non-string items', async () => {
        const envelope = {
            version: 1,
            fetchedAt: 1_700_000_000_000,
            providers: {},
            models: {
                'acme/empty': { name: 'Empty', modalities: { input: [], output: ['text'] } },
                'acme/dirty': { name: 'Dirty', modalities: { input: ['text', 42], output: ['text'] } },
            },
        };
        const { catalog } = makeCatalogWithCache(envelope);
        await catalog.load();

        const empty = catalog.lookupFirst([{ scope: 'model', modelId: 'acme/empty' }]);
        expect(empty?.model.inputModalities).toEqual([]);

        const dirty = catalog.lookupFirst([{ scope: 'model', modelId: 'acme/dirty' }]);
        expect(dirty?.model.inputModalities).toBeUndefined();
    });

    it('normalizes only structurally valid fields', async () => {
        const envelope = {
            version: 1,
            fetchedAt: 1_700_000_000_000,
            providers: {},
            models: {
                'acme/messy': {
                    name: 'Messy',
                    reasoning: 'yes',
                    modalities: { input: ['text', 42], output: ['text'] },
                    limit: { context: -5, output: 2.5 },
                    cost: { input: -1, output: 3, cache_read: 7, cache_write: 0 },
                },
            },
        };
        const { catalog } = makeCatalogWithCache(envelope);
        await catalog.load();

        const match = catalog.lookupFirst([{ scope: 'model', modelId: 'acme/messy' }]);
        expect(match?.model.reasoning).toBeUndefined();
        expect(match?.model.inputModalities).toBeUndefined();
        expect(match?.model.contextWindow).toBeUndefined();
        expect(match?.model.maxTokens).toBeUndefined();
        expect(match?.model.cost).toEqual({ output: 3, cacheRead: 7, cacheWrite: 0 });
    });

    it('skips individually malformed models without discarding valid siblings', async () => {
        const envelope = {
            version: 1,
            fetchedAt: 1_700_000_000_000,
            providers: {
                acme: {
                    models: {
                        good: { name: 'Good' },
                        bad: ['array'],
                        worse: 42,
                    },
                },
                ghost: { models: 'nope' },
            },
            models: {},
        };
        const { catalog } = makeCatalogWithCache(envelope);
        await catalog.load();

        const status = catalog.getStatus();
        expect(status.providerCount).toBe(1);
        expect(catalog.lookupFirst([{ scope: 'provider', providerId: 'acme', modelId: 'good' }])?.model.name).toBe(
            'Good',
        );
        expect(catalog.lookupFirst([{ scope: 'provider', providerId: 'acme', modelId: 'bad' }])).toBeUndefined();
        expect(catalog.lookupFirst([{ scope: 'provider', providerId: 'acme', modelId: 'worse' }])).toBeUndefined();
    });
});

describe('envelope validation', () => {
    it('rejects fetched payloads with no valid provider or base models', async () => {
        const fetchFn: ModelsDevFetchFn = async () =>
            new Response(JSON.stringify({ providers: {}, models: {} }), { status: 200 });
        const { catalog } = makeCatalog({ fetchFn });
        const result = await catalog.refresh({ force: true });

        expect(result.status).toBe('failed');
        expect(result.error).toMatch(/payload/i);
        expect(result.catalog.provenance).toBe('unavailable');
    });

    it('treats a cache envelope with no records as unavailable', async () => {
        const envelope = {
            version: 1,
            fetchedAt: 1_700_000_000_000,
            providers: { openai: { models: {} } },
            models: {},
        };
        const { catalog } = makeCatalogWithCache(envelope);
        await catalog.load();

        expect(catalog.getStatus().provenance).toBe('unavailable');
    });

    it('returns unavailable for missing, malformed, or version-mismatched cache without throwing', async () => {
        const missing = makeCatalog();
        await missing.catalog.load();
        expect(missing.catalog.getStatus().provenance).toBe('unavailable');

        const malformed = makeCatalog();
        writeFileSync(malformed.cachePath, '{broken');
        await malformed.catalog.load();
        expect(malformed.catalog.getStatus().provenance).toBe('unavailable');

        const wrongVersion = makeCatalog();
        writeFileSync(
            wrongVersion.cachePath,
            JSON.stringify({ version: 2, providers: rawPayload.providers, models: rawPayload.models }),
        );
        await wrongVersion.catalog.load();
        expect(wrongVersion.catalog.getStatus().provenance).toBe('unavailable');

        const missingVersion = makeCatalog();
        writeFileSync(
            missingVersion.cachePath,
            JSON.stringify({ providers: rawPayload.providers, models: rawPayload.models }),
        );
        await missingVersion.catalog.load();
        expect(missingVersion.catalog.getStatus().provenance).toBe('unavailable');

        const wrongRoot = makeCatalog();
        writeFileSync(wrongRoot.cachePath, JSON.stringify(['not', 'an', 'envelope']));
        await wrongRoot.catalog.load();
        expect(wrongRoot.catalog.getStatus().provenance).toBe('unavailable');
    });

    it('rejects cache envelopes with missing, non-finite, or negative fetchedAt as unavailable', async () => {
        const base = { version: 1, providers: rawPayload.providers, models: rawPayload.models };
        const scenarios: Array<{ name: string; envelope: unknown }> = [
            { name: 'missing fetchedAt', envelope: { ...base } },
            { name: 'non-numeric fetchedAt', envelope: { ...base, fetchedAt: '1700000000000' } },
            { name: 'non-finite fetchedAt', envelope: { ...base, fetchedAt: Infinity } },
            { name: 'negative fetchedAt', envelope: { ...base, fetchedAt: -5 } },
        ];

        for (const scenario of scenarios) {
            const { catalog } = makeCatalogWithCache(scenario.envelope);
            await catalog.load();
            expect(catalog.getStatus().provenance, scenario.name).toBe('unavailable');
        }
    });
});

describe('load', () => {
    it('reads disk at most once per catalog instance', async () => {
        const { cachePath, catalog } = makeCatalogWithCache(cacheEnvelope);
        await catalog.load();
        expect(catalog.getStatus().provenance).toBe('cache');

        rmSync(cachePath);
        await catalog.load();
        expect(catalog.getStatus().provenance).toBe('cache');
    });
});

describe('refresh', () => {
    it('returns fresh from a version-1 cache without any network access', async () => {
        const fetchFn = mock(async () => new Response('should not be called', { status: 500 }));
        const { catalog } = makeCatalogWithCache(cacheEnvelope, {
            fetchFn,
            ttlMs: 86_400_000,
            now: () => 1_700_000_100_000,
        });

        await catalog.load();
        const result = await catalog.refresh();

        expect(result.status).toBe('fresh');
        expect(result.catalog.stale).toBe(false);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('force bypasses a fresh cache and fetches', async () => {
        const fetchFn = mock(async () => new Response(JSON.stringify(rawPayload), { status: 200 }));
        const { catalog } = makeCatalogWithCache(cacheEnvelope, {
            fetchFn,
            ttlMs: 86_400_000,
            now: () => 1_700_000_100_000,
        });

        await catalog.load();
        const result = await catalog.refresh({ force: true });

        expect(result.status).toBe('updated');
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('keeps a stale cache readable and sends If-None-Match with the cached ETag', async () => {
        const seenHeaders: Array<Record<string, string>> = [];
        const fetchFn: ModelsDevFetchFn = async (_url, init) => {
            seenHeaders.push(init.headers as Record<string, string>);
            return new Response(JSON.stringify(rawPayload), { status: 200, headers: { etag: 'W/"abc123"' } });
        };
        const { catalog } = makeCatalogWithCache(cacheEnvelope, {
            fetchFn,
            ttlMs: 86_400_000,
            now: () => 1_700_086_500_000,
        });

        await catalog.load();
        expect(catalog.getStatus().stale).toBe(true);
        expect(catalog.lookupFirst([{ scope: 'model', modelId: 'openai/gpt-4o' }])?.model.name).toBe('GPT-4o');

        const result = await catalog.refresh();

        expect(result.status).toBe('updated');
        expect(result.catalog.provenance).toBe('network');
        expect(seenHeaders).toHaveLength(1);
        expect(seenHeaders[0]?.['If-None-Match']).toBe('W/"abc123"');
    });

    it('normalizes a raw network payload that carries its own version field', async () => {
        const fetchFn: ModelsDevFetchFn = async () =>
            new Response(
                JSON.stringify({ version: 2, providers: rawPayload.providers, models: rawPayload.models }),
                { status: 200 },
            );
        const { catalog } = makeCatalog({ fetchFn, ttlMs: 0 });

        const result = await catalog.refresh();

        expect(result.status).toBe('updated');
        expect(result.catalog.providerCount).toBe(1);
        expect(result.catalog.baseCount).toBe(1);
        expect(result.catalog.provenance).toBe('network');
        expect(catalog.lookupFirst([{ scope: 'model', modelId: 'openai/gpt-4o' }])?.model.name).toBe('GPT-4o');
    });

    it('fails a 304 when no cached snapshot exists', async () => {
        const fetchFn: ModelsDevFetchFn = async () => new Response(null, { status: 304 });
        const { catalog } = makeCatalog({ fetchFn, ttlMs: 0 });

        await catalog.load();
        expect(catalog.getStatus().provenance).toBe('unavailable');

        const result = await catalog.refresh();

        expect(result.status).toBe('failed');
        expect(result.error).toBeTruthy();
        expect(result.catalog.provenance).toBe('unavailable');
    });

    it('fails and keeps stale memory when 304 persistence fails', async () => {
        const fetchFn: ModelsDevFetchFn = async () => new Response(null, { status: 304 });
        const { cachePath, catalog } = makeCatalogWithCache(cacheEnvelope, {
            fetchFn,
            ttlMs: 0,
            now: () => 1_700_086_500_000,
        });

        await catalog.load();
        expect(catalog.getStatus().stale).toBe(true);

        // Block persistence by replacing the cache file with a directory.
        rmSync(cachePath);
        mkdirSync(cachePath);
        const result = await catalog.refresh();

        expect(result.status).toBe('failed');
        expect(result.error).toMatch(/persist/i);
        expect(catalog.getStatus().stale).toBe(true);
        expect(catalog.getStatus().etag).toBe('W/"abc123"');
    });

    it('advances freshness on HTTP 304 without replacing normalized records', async () => {
        const fetchFn: ModelsDevFetchFn = async () => new Response(null, { status: 304 });
        const { catalog } = makeCatalogWithCache(cacheEnvelope, {
            fetchFn,
            ttlMs: 86_400_000,
            now: () => 1_700_086_500_000,
        });

        await catalog.load();
        const result = await catalog.refresh();

        expect(result.status).toBe('not-modified');
        expect(result.catalog.stale).toBe(false);
        expect(result.catalog.etag).toBe('W/"abc123"');
        expect(catalog.lookupFirst([{ scope: 'model', modelId: 'openai/gpt-4o' }])?.model.name).toBe('GPT-4o');
    });

    it('preserves the last known good snapshot on malformed, incompatible, non-2xx, timeout, and thrown responses', async () => {
        const scenarios: Array<{ name: string; fetchFn: ModelsDevFetchFn }> = [
            {
                name: 'malformed JSON',
                fetchFn: async () => new Response('{not json', { status: 200 }),
            },
            {
                name: 'incompatible root',
                fetchFn: async () => new Response(JSON.stringify(['nope']), { status: 200 }),
            },
            {
                name: 'non-2xx',
                fetchFn: async () => new Response('nope', { status: 500 }),
            },
            {
                name: 'timeout',
                fetchFn: async (_url, init) =>
                    new Promise<Response>((_resolve, reject) => {
                        init.signal?.addEventListener('abort', () => {
                            reject(new DOMException('The operation was aborted.', 'AbortError'));
                        });
                    }),
            },
            {
                name: 'thrown fetch',
                fetchFn: async () => {
                    throw new Error('boom');
                },
            },
        ];

        for (const scenario of scenarios) {
            const { catalog } = makeCatalogWithCache(cacheEnvelope, {
                fetchFn: scenario.fetchFn,
                ttlMs: 0,
                timeoutMs: 20,
            });
            await catalog.load();

            const result = await catalog.refresh();

            expect(result.status, scenario.name).toBe('failed');
            expect(result.error, scenario.name).toBeTruthy();
            expect(result.catalog.provenance, scenario.name).toBe('cache');
            expect(catalog.lookupFirst([{ scope: 'model', modelId: 'openai/gpt-4o' }])?.model.name, scenario.name).toBe(
                'GPT-4o',
            );
            expect(catalog.getStatus().stale, scenario.name).toBe(true);
        }
    });

    it('clears the request abort timer after a fast successful refresh', async () => {
        let abortedAfterSettle = false;
        const fetchFn: ModelsDevFetchFn = async (_url, init) => {
            init.signal?.addEventListener('abort', () => {
                abortedAfterSettle = true;
            });
            return new Response(JSON.stringify(rawPayload), { status: 200 });
        };
        const { catalog } = makeCatalog({ fetchFn, ttlMs: 0, timeoutMs: 30 });

        const result = await catalog.refresh();
        expect(result.status).toBe('updated');

        // Outlive the would-be 30ms timeout to prove the timer was cleared.
        await new Promise((resolve) => setTimeout(resolve, 70));
        expect(abortedAfterSettle).toBe(false);
    });

    it('shares one fetch across concurrent refreshes', async () => {
        let fetchCount = 0;
        const fetchFn: ModelsDevFetchFn = async () => {
            fetchCount += 1;
            return new Response(JSON.stringify(rawPayload), { status: 200 });
        };
        const { catalog } = makeCatalog({ fetchFn, ttlMs: 0 });

        const results = await Promise.all([catalog.refresh(), catalog.refresh()]);

        expect(fetchCount).toBe(1);
        expect(results[0].status).toBe('updated');
        expect(results[1].status).toBe('updated');
    });

    it('queues a forced refresh behind a fresh non-forced refresh', async () => {
        const fetchFn = mock(
            async () => new Response(JSON.stringify(rawPayload), { status: 200 }),
        );
        const { catalog } = makeCatalogWithCache(cacheEnvelope, {
            fetchFn,
            ttlMs: 86_400_000,
            now: () => 1_700_000_100_000,
        });

        const [fresh, forced] = await Promise.all([
            catalog.refresh(),
            catalog.refresh({ force: true }),
        ]);

        expect(fresh.status).toBe('fresh');
        expect(forced.status).toBe('updated');
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('shares one fetch across concurrent forced refreshes', async () => {
        const fetchFn = mock(
            async () => new Response(JSON.stringify(rawPayload), { status: 200 }),
        );
        const { catalog } = makeCatalog({ fetchFn, ttlMs: 86_400_000 });

        const results = await Promise.all([
            catalog.refresh({ force: true }),
            catalog.refresh({ force: true }),
        ]);

        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(results[0].status).toBe('updated');
        expect(results[1].status).toBe('updated');
    });

    it('rejects HTTP 200 with only invalid/empty records and keeps disk + memory intact', async () => {
        const fetchFn: ModelsDevFetchFn = async () =>
            new Response(
                JSON.stringify({
                    providers: {
                        acme: { models: { 'acme/empty': {}, 'acme/bad': { reasoning: 'yes' } } },
                    },
                    models: { 'acme/empty2': {}, 'acme/bad2': { deprecated: true } },
                }),
                { status: 200, headers: { etag: 'W/"new-etag"' } },
            );
        const { cachePath, catalog } = makeCatalogWithCache(cacheEnvelope, {
            fetchFn,
            ttlMs: 0,
            now: () => 1_700_086_500_000,
        });

        await catalog.load();
        const diskBefore = readFileSync(cachePath, 'utf-8');
        const statusBefore = catalog.getStatus();

        const result = await catalog.refresh();

        expect(result.status).toBe('failed');
        expect(result.error).toMatch(/payload/i);
        // Provenance, ETag, counts unchanged
        expect(catalog.getStatus().provenance).toBe('cache');
        expect(catalog.getStatus().etag).toBe(statusBefore.etag);
        expect(catalog.getStatus().providerCount).toBe(statusBefore.providerCount);
        expect(catalog.getStatus().baseCount).toBe(statusBefore.baseCount);
        // Memory intact
        expect(catalog.lookupFirst([{ scope: 'model', modelId: 'openai/gpt-4o' }])?.model.name).toBe('GPT-4o');
        // Invalid IDs absent
        expect(catalog.lookupFirst([{ scope: 'model', modelId: 'acme/empty' }])).toBeUndefined();
        expect(catalog.lookupFirst([{ scope: 'model', modelId: 'acme/bad' }])).toBeUndefined();
        // Disk unchanged
        expect(readFileSync(cachePath, 'utf-8')).toBe(diskBefore);
    });

    it('accepts HTTP 200 where invalid siblings coexist with one valid record', async () => {
        const fetchFn: ModelsDevFetchFn = async () =>
            new Response(
                JSON.stringify({
                    providers: {
                        acme: {
                            models: {
                                'acme/good': providerModelRecord,
                                'acme/empty': {},
                                'acme/bad': { reasoning: 'yes' },
                            },
                        },
                    },
                    models: {},
                }),
                { status: 200 },
            );
        const { catalog } = makeCatalogWithCache(cacheEnvelope, {
            fetchFn,
            ttlMs: 0,
            now: () => 1_700_086_500_000,
        });

        await catalog.load();
        const result = await catalog.refresh();

        expect(result.status).toBe('updated');
        expect(catalog.lookupFirst([{ scope: 'provider', providerId: 'acme', modelId: 'acme/good' }])?.model.name).toBe('GPT-4o');
        expect(catalog.lookupFirst([{ scope: 'provider', providerId: 'acme', modelId: 'acme/empty' }])).toBeUndefined();
        expect(catalog.lookupFirst([{ scope: 'provider', providerId: 'acme', modelId: 'acme/bad' }])).toBeUndefined();
    });

    it('persists a version-1 envelope atomically and leaves no temporary file', async () => {
        const fetchFn: ModelsDevFetchFn = async () =>
            new Response(JSON.stringify(rawPayload), { status: 200, headers: { etag: 'W/"abc"' } });
        const { dir, cachePath, catalog } = makeCatalog({
            fetchFn,
            ttlMs: 0,
            now: () => 1_700_000_000_000,
        });

        const result = await catalog.refresh();

        expect(result.status).toBe('updated');
        expect(result.catalog.providerCount).toBe(1);
        expect(result.catalog.baseCount).toBe(1);
        expect(result.catalog.provenance).toBe('network');

        const written = JSON.parse(readFileSync(cachePath, 'utf-8')) as {
            version: number;
            fetchedAt: number;
            etag: string;
            providers: { openai: { models: Record<string, { name: string; inputModalities?: string[] }> } };
            models: Record<string, { name: string }>;
        };
        expect(written.version).toBe(1);
        expect(written.fetchedAt).toBe(1_700_000_000_000);
        expect(written.etag).toBe('W/"abc"');
        expect(written.providers.openai.models['gpt-4o'].name).toBe('GPT-4o');
        expect(written.providers.openai.models['gpt-4o'].inputModalities).toEqual(['text', 'image']);
        expect(written.models['openai/gpt-4o'].name).toBe('GPT-4o');

        expect(readdirSync(dir).filter((file) => file.endsWith('.tmp'))).toEqual([]);
    });

    it('keeps current memory when persistence fails after a valid 200', async () => {
        const fetchFn: ModelsDevFetchFn = async () => new Response(JSON.stringify(rawPayload), { status: 200 });
        const { cachePath, catalog } = makeCatalog({ fetchFn, ttlMs: 0 });

        await catalog.load();
        expect(catalog.getStatus().provenance).toBe('unavailable');

        mkdirSync(cachePath);
        const result = await catalog.refresh();

        expect(result.status).toBe('failed');
        expect(result.error).toMatch(/persist/i);
        expect(catalog.getStatus().provenance).toBe('unavailable');
        expect(catalog.lookupFirst([{ scope: 'model', modelId: 'openai/gpt-4o' }])).toBeUndefined();
    });
});

describe('process singleton', () => {
    it('returns the same global instance and reset removes it', () => {
        resetModelsDevCatalogForTests();
        const first = getModelsDevCatalog();
        const second = getModelsDevCatalog();
        expect(first).toBe(second);

        resetModelsDevCatalogForTests();
        const third = getModelsDevCatalog();
        expect(third).not.toBe(first);
    });
});
