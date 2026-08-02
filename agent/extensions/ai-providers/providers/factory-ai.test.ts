import { describe, expect, it, mock } from 'bun:test';

let cachedModels: Array<{ id: string; name: string }> = [];
const registerProvider = mock();
const handlers: Array<{
    event: string;
    handler: (event: unknown, ctx: unknown) => Promise<void>;
}> = [];
const fetchFactoryModels = mock(async (_apiKey: string, _cwd?: string) => {
    cachedModels = [{ id: 'glm-5.2', name: 'GLM 5.2' }];
    return cachedModels;
});

mock.module('./factory-models.ts', () => ({
    fetchFactoryModels,
    getCachedFactoryModels: () => cachedModels,
    setCachedFactoryModels: (models: Array<{ id: string; name: string }>) => {
        cachedModels = models;
    },
    clearCachedFactoryModels: () => {
        cachedModels = [];
    },
    toProviderModels: (models: Array<{ id: string; name: string }> = []) =>
        models.map((m) => ({ id: m.id, name: m.name })),
    toResolvedFactoryModels: () => [],
}));
mock.module('../shared/oauth.ts', () => ({
    createFactoryOAuth: () => ({
        name: 'Factory AI',
        login: async () => ({ access: '', refresh: '', expires: 0 }),
        refreshToken: async (credentials: unknown) => credentials,
        getApiKey: () => '',
    }),
    getGoogleAccessToken: () => '',
    refreshGoogleAccessToken: async (credentials: unknown) => credentials,
}));
mock.module('../shared/sdk-bridge.ts', () => ({ streamFactory: mock() }));

const { registerFactoryProvider } = await import('./factory-ai.ts');

function makePi() {
    const registered = {
        registerProvider,
        on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
            handlers.push({ event, handler });
        },
    };
    return registered;
}

function authCtx(apiKey: string | undefined, cwd = '/workspace') {
    return {
        cwd,
        modelRegistry: {
            getProviderAuth: async () =>
                apiKey === undefined
                    ? undefined
                    : { auth: { apiKey } },
        },
    };
}

describe('registerFactoryProvider', () => {
    it('returns a handle exposing refreshProjection', () => {
        cachedModels = [];
        registerProvider.mockClear();

        const handle = registerFactoryProvider(makePi() as never);

        expect(handle).toBeDefined();
        expect(handle.providerId).toBe('factory-ai');
        expect(typeof handle.refreshProjection).toBe('function');
    });

    it('resolves Pi provider auth and discovers SDK models only with credentials', async () => {
        cachedModels = [];
        registerProvider.mockClear();
        fetchFactoryModels.mockClear();

        const handle = registerFactoryProvider(makePi() as never);
        expect(registerProvider).toHaveBeenCalledTimes(1); // initial registration

        await handle.refreshProjection(authCtx('factory-key') as never);

        // SDK discovery ran with the Pi-resolved API key and session cwd.
        expect(fetchFactoryModels).toHaveBeenCalledWith('factory-key', '/workspace');
        // Provider re-registered through pi.registerProvider.
        expect(registerProvider).toHaveBeenCalledTimes(2);
    });

    it('skips SDK discovery without credentials and still re-projects', async () => {
        cachedModels = [];
        registerProvider.mockClear();
        fetchFactoryModels.mockClear();

        const handle = registerFactoryProvider(makePi() as never);

        await handle.refreshProjection(authCtx(undefined) as never);

        expect(fetchFactoryModels).not.toHaveBeenCalled();
        expect(registerProvider).toHaveBeenCalledTimes(2);
    });

    it('re-projects from cache without a second SDK fetch after catalog refresh', async () => {
        cachedModels = [];
        registerProvider.mockClear();
        fetchFactoryModels.mockClear();

        const handle = registerFactoryProvider(makePi() as never);

        // First projection discovers the SDK catalog (credentials present).
        await handle.refreshProjection(authCtx('factory-key') as never);
        expect(fetchFactoryModels).toHaveBeenCalledTimes(1);

        // Second projection (e.g. after a models.dev catalog refresh) must not
        // re-fetch the SDK — the cached entries are re-enriched in place.
        await handle.refreshProjection(authCtx('factory-key') as never);
        expect(fetchFactoryModels).toHaveBeenCalledTimes(1);
        expect(registerProvider).toHaveBeenCalledTimes(3);
    });

    it('rediscovers live SDK models on an explicit forced projection', async () => {
        cachedModels = [];
        registerProvider.mockClear();
        fetchFactoryModels.mockClear();

        const handle = registerFactoryProvider(makePi() as never);
        const ctx = authCtx('factory-key') as never;
        await handle.refreshProjection(ctx);
        await handle.refreshProjection(ctx, { force: true });

        expect(fetchFactoryModels).toHaveBeenCalledTimes(2);
        expect(registerProvider).toHaveBeenCalledTimes(3);
    });

    it('keeps cached availability on a forced projection without credentials', async () => {
        cachedModels = [{ id: 'glm-5.2', name: 'GLM 5.2' }];
        registerProvider.mockClear();
        fetchFactoryModels.mockClear();

        const handle = registerFactoryProvider(makePi() as never);
        await handle.refreshProjection(authCtx(undefined) as never, { force: true });

        expect(fetchFactoryModels).not.toHaveBeenCalled();
        expect(registerProvider).toHaveBeenCalledTimes(2);
    });

    it('removes the standalone session_start handler (shared lifecycle owns it)', () => {
        handlers.length = 0;
        registerFactoryProvider(makePi() as never);

        const sessionStart = handlers.find(({ event }) => event === 'session_start');
        expect(sessionStart).toBeUndefined();
    });
});
