import { describe, expect, it, mock } from 'bun:test';

const fetchFactoryModels = mock(async () => []);
const registerProvider = mock();
const handlers: Array<{
    event: string;
    handler: (event: unknown, ctx: unknown) => Promise<void>;
}> = [];

mock.module('./factory-models.ts', () => ({
    fetchFactoryModels,
    getCachedFactoryModels: () => [],
    toProviderModels: () => [],
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

describe('registerFactoryProvider', () => {
    it('refreshes the catalog with provider auth resolved by Pi', async () => {
        handlers.length = 0;
        fetchFactoryModels.mockClear();
        registerProvider.mockClear();

        registerFactoryProvider({
            registerProvider,
            on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
                handlers.push({ event, handler });
            },
        } as never);

        const sessionStart = handlers.find(({ event }) => event === 'session_start');
        expect(sessionStart).toBeDefined();

        const runtimeRegisterProvider = mock();
        await sessionStart!.handler({}, {
            cwd: '/workspace',
            modelRegistry: {
                getProviderAuth: async () => ({ auth: { apiKey: 'factory-key' } }),
                registerProvider: runtimeRegisterProvider,
            },
        });

        expect(fetchFactoryModels).toHaveBeenCalledWith('factory-key', '/workspace');
        expect(runtimeRegisterProvider).toHaveBeenCalledTimes(1);
    });
});
