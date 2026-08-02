import { describe, expect, it, mock } from 'bun:test';

const handlers: Array<{
    event: string;
    handler: (event: unknown, ctx: unknown) => unknown;
}> = [];
const registrations: Array<{ name: string; models: unknown[] }> = [];
const fetchModels = mock(async () =>
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
};

mock.module('../_shared/models-dev/catalog', () => ({
    getModelsDevCatalog: () => catalog,
}));
mock.module('./config.ts', () => ({
    isProviderEnabled: (name: string) => name === 'cpa',
    isWidgetEnabled: () => false,
    loadAiProvidersConfig: () => ({
        cpa: {
            overridePrefixes: { ocg: 'go' },
            refreshTtlMs: 0,
            silentCatalogDiff: true,
        },
    }),
}));
mock.module('./providers/factory-ai.ts', () => ({
    registerFactoryProvider: () => ({
        providerId: 'factory-ai',
        refreshProjection: mock(async () => {}),
    }),
}));
mock.module('./widgets/factory-credits.ts', () => ({
    registerFactoryCreditsWidget: () => {},
}));
mock.module('./commands/providers.ts', () => ({
    registerProvidersCommand: () => {},
}));

const { default: aiProvidersExtension } = await import('./index.ts');

describe('aiProvidersExtension lifecycle composition', () => {
    it('uses one shared session_start to discover and re-register CPA once', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = fetchModels as unknown as typeof fetch;
        try {
            aiProvidersExtension({
                on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
                    handlers.push({ event, handler });
                },
                registerProvider: (name: string, config: { models?: unknown[] }) => {
                    registrations.push({ name, models: config.models ?? [] });
                },
                registerCommand: () => {},
            } as never);

            const sessionStarts = handlers.filter(
                (handler) => handler.event === 'session_start',
            );
            expect(sessionStarts).toHaveLength(1);
            expect(registrations.filter(({ name }) => name === 'cpa')).toHaveLength(1);

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
            expect(registrations.filter(({ name }) => name === 'cpa')).toHaveLength(2);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
