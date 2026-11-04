import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const handlers: Array<{
    event: string;
    handler: (event: unknown, ctx: unknown) => unknown;
}> = [];
const registrations: Array<{ name: string; models: unknown[] }> = [];
const originalFetch = globalThis.fetch;
const originalKey = process.env.CLIPROXY_API_KEY;
const fetchModels = mock(
    async () =>
        new Response(
            JSON.stringify({ data: [{ id: 'gpt-5.4', owned_by: 'openai' }] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
);
const status = {
    provenance: 'cache' as const,
    fetchedAt: 1_700_000_000_000,
    etag: null,
    stale: false,
    providerCount: 1,
    baseCount: 1,
};
const catalog = {
    load: mock(async () => status),
    refresh: mock(async () => ({ status: 'fresh' as const, catalog: status })),
    getStatus: () => status,
    lookupFirst: () => undefined,
    lookupMerge: () => undefined,
};

mock.module('../_shared/models-dev/catalog', () => ({
    getModelsDevCatalog: () => catalog,
}));
mock.module('./config.ts', () => ({
    isProviderEnabled: (name: string) => name === 'cpa',
    isWidgetEnabled: () => false,
    loadAiProvidersConfig: () => ({
        modelRules: [],
        cpa: {
            refreshTtlMs: 30_000,
            silentCatalogDiff: true,
        },
    }),
}));
mock.module('./providers/cpa-catalog-cache.ts', () => ({
    createCpaCatalogCache: () => ({
        load: () => undefined,
        save: async () => {},
    }),
}));
mock.module('./commands/providers.ts', () => ({
    registerProvidersCommand: () => {},
}));

const { default: aiProvidersExtension } = await import('./index.ts');

beforeEach(() => {
    handlers.length = 0;
    registrations.length = 0;
    fetchModels.mockClear();
    globalThis.fetch = fetchModels as unknown as typeof fetch;
    process.env.CLIPROXY_API_KEY = 'fixture-key';
});
afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.CLIPROXY_API_KEY;
    else process.env.CLIPROXY_API_KEY = originalKey;
});

function createPi() {
    return {
        on: (
            event: string,
            handler: (event: unknown, ctx: unknown) => unknown,
        ) => {
            handlers.push({ event, handler });
        },
        registerProvider: (name: string, config: { models?: unknown[] }) => {
            registrations.push({ name, models: config.models ?? [] });
        },
        registerCommand: () => {},
        unregisterProvider: () => {},
    } as never;
}

describe('aiProvidersExtension lifecycle composition', () => {
    it('keeps the factory pending until CPA verification completes', async () => {
        let release: ((response: Response) => void) | undefined;
        const response = new Promise<Response>((resolve) => {
            release = resolve;
        });
        fetchModels.mockImplementationOnce(() => response);
        let completed = false;
        const initialization = aiProvidersExtension(createPi()).then(() => {
            completed = true;
        });
        try {
            await new Promise<void>((resolve) => queueMicrotask(resolve));
            expect(fetchModels).toHaveBeenCalledTimes(1);
            expect(completed).toBe(false);
            expect(registrations.at(-1)?.models).toEqual([]);
        } finally {
            release?.(
                Response.json({
                    data: [{ id: 'gpt-5.4', owned_by: 'openai' }],
                }),
            );
            await initialization;
        }
        expect(completed).toBe(true);
        expect(registrations.at(-1)?.models).toEqual([
            expect.objectContaining({ id: 'gpt-5.4' }),
        ]);
    });

    it('completes initialization without advertising models when CPA rejects authentication', async () => {
        fetchModels.mockImplementationOnce(
            async () => new Response('', { status: 401 }),
        );
        await aiProvidersExtension(createPi());
        expect(fetchModels).toHaveBeenCalledTimes(1);
        expect(registrations.every(({ models }) => models.length === 0)).toBe(
            true,
        );
        expect(
            handlers.filter(({ event }) => event === 'session_start'),
        ).toHaveLength(1);
    });

    it('publishes verified CPA models before factory completion and reuses the verification at session start', async () => {
        await aiProvidersExtension(createPi());

        expect(registrations.at(-1)?.models).toEqual([
            expect.objectContaining({ id: 'gpt-5.4' }),
        ]);
        expect(fetchModels).toHaveBeenCalledTimes(1);
        const sessionStarts = handlers.filter(
            (handler) => handler.event === 'session_start',
        );
        expect(sessionStarts).toHaveLength(1);
        expect(registrations.filter(({ name }) => name === 'cpa')).toHaveLength(
            2,
        );

        await sessionStarts[0].handler(
            {},
            {
                cwd: '/workspace',
                hasUI: true,
                ui: { notify: mock(() => {}) },
                modelRegistry: { find: () => undefined },
            },
        );

        expect(fetchModels).toHaveBeenCalledTimes(1);
        expect(registrations.filter(({ name }) => name === 'cpa')).toHaveLength(
            2,
        );
    });
});
