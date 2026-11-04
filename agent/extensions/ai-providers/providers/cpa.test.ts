/**
 * Tests for cpa.ts — CPA provider registration.
 *
 * Covers:
 *   - registerCpaProvider registers with correct name, baseUrl, api, apiKey
 *   - Initial registration does not advertise unverified models
 *   - Does not register a provider-local session_start handler
 *   - Exposes a stable provider projection handle
 */

import {
    afterAll,
    afterEach,
    beforeEach,
    describe,
    test,
    expect,
    mock,
} from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RefreshModelsContext } from '@earendil-works/pi-ai';
import type {
    ExtensionAPI,
    ProviderConfig,
} from '@earendil-works/pi-coding-agent';
import { writeFixtureFile } from '../../_shared/testing/config-fixture.ts';
import { STATIC_FALLBACK_MODELS } from '../constants/cpa-static-models';
import type { ChatModelConfig } from '../rules/model-rules.ts';

import { createCpaCatalogCache } from './cpa-catalog-cache.ts';
import type { CpaModelEntry } from './cpa-models.ts';
import type { CpaCatalogResult } from './cpa-models.ts';
import type { LifecycleCtx } from './cpa.ts';

// The diagnostic path is captured at module load, so isolate before importing.
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = mkdtempSync(join(tmpdir(), 'cpa-provider-test-'));
const configPath = join(agentDir, 'config', 'ai-providers.json');
let previousBaseUrl: string | undefined;
let previousApiKey: string | undefined;
beforeEach(() => {
    previousBaseUrl = process.env.CLIPROXY_BASE_URL;
    delete process.env.CLIPROXY_BASE_URL;
    previousApiKey = process.env.CLIPROXY_API_KEY;
    process.env.CLIPROXY_API_KEY = 'fixture-cpa-key';
});
afterEach(() => {
    if (previousApiKey === undefined) delete process.env.CLIPROXY_API_KEY;
    else process.env.CLIPROXY_API_KEY = previousApiKey;
    if (previousBaseUrl === undefined) delete process.env.CLIPROXY_BASE_URL;
    else process.env.CLIPROXY_BASE_URL = previousBaseUrl;
    rmSync(configPath, { force: true });
    rmSync(join(agentDir, 'artifacts', 'cache', 'ai-providers'), {
        recursive: true,
        force: true,
    });
});
afterAll(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
});
process.env.PI_CODING_AGENT_DIR = agentDir;
const {
    registerCpaProvider: registerCpaProviderProduction,
    getCliproxyApiKey,
} = await import('./cpa.ts');

interface RegisteredProvider {
    name: string;
    config: ProviderConfig;
}

interface RegisteredHandler {
    event: string;
    handler: (...args: unknown[]) => unknown | Promise<unknown>;
}

function createMockExtensionAPI(): {
    pi: ExtensionAPI;
    registeredProviders: RegisteredProvider[];
    unregisteredProviders: string[];
    registeredHandlers: RegisteredHandler[];
    registeredCommands: Array<{
        name: string;
        handler: (...args: unknown[]) => unknown | Promise<unknown>;
    }>;
} {
    const registeredProviders: RegisteredProvider[] = [];
    const unregisteredProviders: string[] = [];
    const registeredHandlers: RegisteredHandler[] = [];
    const registeredCommands: Array<{
        name: string;
        handler: (...args: unknown[]) => unknown | Promise<unknown>;
    }> = [];

    // biome-ignore lint/suspicious/noExplicitAny: mock implementation with limited surface
    const pi = {
        unregisterProvider: (name: string) => {
            unregisteredProviders.push(name);
        },
        registerProvider: (name: string, config: Record<string, unknown>) => {
            registeredProviders.push({
                name,
                config: config as RegisteredProvider['config'],
            });
        },
        on: (
            event: string,
            handler: (...args: unknown[]) => unknown | Promise<unknown>,
        ) => {
            registeredHandlers.push({ event, handler });
        },
        registerCommand: (
            name: string,
            config: {
                handler: (...args: unknown[]) => unknown | Promise<unknown>;
            },
        ) => {
            registeredCommands.push({ name, handler: config.handler });
        },
    } as unknown as ExtensionAPI;

    return {
        pi,
        registeredProviders,
        unregisteredProviders,
        registeredHandlers,
        registeredCommands,
    };
}

function createMockBuildCpaModels() {
    return mock((_baseUrl: string, _apiKey: string) => {
        return Promise.resolve({
            models: [],
            entries: [],
            source: 'unavailable' as const,
            failure: { kind: 'network' as const },
        });
    });
}

const fakeModel: ChatModelConfig = {
    id: 'ocg/go-test',
    name: 'Test Model',
    reasoning: true,
    input: ['text'],
    contextWindow: 2000,
    maxTokens: 200,
    cost: { input: 0.5, output: 1.0, cacheRead: 0, cacheWrite: 0 },
};

const fakeEntry: CpaModelEntry = {
    id: 'ocg/go-test',
    owned_by: 'ocode-go (main)',
};

function registerCpaProvider(
    pi: ExtensionAPI,
    options: Parameters<typeof registerCpaProviderProduction>[1] = {},
) {
    return registerCpaProviderProduction(pi, {
        ...options,
        loadCachedEntries: options.loadCachedEntries ?? (() => undefined),
        saveCachedEntries: options.saveCachedEntries ?? (async () => undefined),
    });
}

// ── Tests ──

describe('registerCpaProvider', () => {
    test('resolves a recovered active model after publishing the live catalog', async () => {
        const { pi, registeredProviders } = createMockExtensionAPI();
        const handle = registerCpaProvider(pi, {
            buildModels: async () => ({
                source: 'live',
                entries: [fakeEntry],
                models: [fakeModel],
            }),
        });
        const notify = mock((_message: string, _level?: string) => {});
        await handle.refreshStartupProjection({
            model: { provider: 'cpa', id: fakeModel.id },
            modelRegistry: {
                find: (_provider: string, id: string) =>
                    registeredProviders
                        .at(-1)
                        ?.config.models?.find((model) => model.id === id),
            },
            hasUI: true,
            ui: { notify },
        } as unknown as LifecycleCtx);

        expect(registeredProviders.at(-1)?.config.models).toEqual([fakeModel]);
        expect(
            notify.mock.calls.filter(([, level]) => level === 'warning'),
        ).toEqual([]);
    });

    test('reports an active catalog model that Pi still cannot resolve after publication', async () => {
        const { pi } = createMockExtensionAPI();
        const handle = registerCpaProvider(pi, {
            buildModels: async () => ({
                source: 'live',
                entries: [fakeEntry],
                models: [fakeModel],
            }),
        });
        const notify = mock(() => {});
        await handle.refreshStartupProjection({
            model: { provider: 'cpa', id: fakeModel.id },
            modelRegistry: { find: () => undefined },
            hasUI: true,
            ui: { notify },
        } as unknown as LifecycleCtx);

        expect(notify).toHaveBeenCalledWith(
            expect.stringContaining(
                `The active CPA model ${fakeModel.id} no longer exists`,
            ),
            'warning',
        );
    });

    test('native catalog refresh withdraws CPA on failure and restores it after recovery', async () => {
        const { pi, registeredProviders, registeredHandlers } =
            createMockExtensionAPI();
        let catalog: CpaCatalogResult = {
            source: 'live',
            entries: [fakeEntry],
            models: [fakeModel],
        };
        const buildModels = mock(async () => catalog);
        const handle = registerCpaProvider(pi, { buildModels });
        const provider = registeredProviders[0]!.config;
        const nativeContext: RefreshModelsContext = {
            allowNetwork: true,
            force: true,
            signal: new AbortController().signal,
            publish: async ({ update }) => {
                update?.();
                return true;
            },
        };

        expect(provider.refreshModels).toBeFunction();
        expect(await provider.refreshModels!(nativeContext)).toEqual([
            fakeModel,
        ]);
        expect(handle.getAvailability().state).toBe('available');

        catalog = {
            source: 'unavailable',
            models: [],
            entries: [],
            failure: { kind: 'http', status: 401 },
        };
        expect(await provider.refreshModels!(nativeContext)).toEqual([]);
        expect(handle.getAvailability().state).toBe('unavailable');
        const input = registeredHandlers.find(
            ({ event }) => event === 'input',
        )!;
        expect(
            await input.handler(
                {},
                {
                    model: { provider: 'cpa', id: fakeModel.id },
                    hasUI: true,
                    ui: { notify: mock(() => {}) },
                    modelRegistry: { find: () => fakeModel },
                },
            ),
        ).toEqual({ action: 'handled' });
        expect(buildModels).toHaveBeenCalledTimes(2);

        catalog = { source: 'live', entries: [fakeEntry], models: [fakeModel] };
        expect(await provider.refreshModels!(nativeContext)).toEqual([
            fakeModel,
        ]);
        expect(handle.getAvailability().state).toBe('available');
        const fetches = buildModels.mock.calls.length;
        expect(
            await provider.refreshModels!({
                ...nativeContext,
                allowNetwork: false,
            }),
        ).toEqual([fakeModel]);
        expect(buildModels).toHaveBeenCalledTimes(fetches);
        catalog = { source: 'live', entries: [], models: [] };
        expect(await provider.refreshModels!(nativeContext)).toEqual([]);
        expect(handle.getAvailability().state).toBe('empty');
        expect(
            await provider.refreshModels!({
                ...nativeContext,
                allowNetwork: false,
            }),
        ).toEqual([]);
        expect(registeredProviders).toHaveLength(1);
    });

    test('cache-only native refresh never advertises an unverified disk catalog', async () => {
        const { pi, registeredProviders } = createMockExtensionAPI();
        const buildModels = createMockBuildCpaModels();
        const handle = registerCpaProvider(pi, {
            buildModels,
            loadCachedEntries: () => [fakeEntry],
        });
        const provider = registeredProviders[0]!.config;

        expect(
            await provider.refreshModels!({
                allowNetwork: false,
                signal: new AbortController().signal,
                publish: async () => true,
            }),
        ).toEqual([]);
        expect(buildModels).not.toHaveBeenCalled();
        expect(handle.getAvailability().state).toBe('checking');
    });

    test('a superseded native refresh cannot publish availability or persist its catalog', async () => {
        const { pi, registeredProviders } = createMockExtensionAPI();
        const buildModels = mock(
            async (): Promise<CpaCatalogResult> => ({
                source: 'live',
                entries: [fakeEntry],
                models: [fakeModel],
            }),
        );
        const saveCachedEntries = mock(async () => {});
        const handle = registerCpaProvider(pi, {
            buildModels,
            saveCachedEntries,
        });
        const provider = registeredProviders[0]!.config;
        const nativeContext: RefreshModelsContext = {
            allowNetwork: true,
            signal: new AbortController().signal,
            publish: async () => false,
        };

        expect(await provider.refreshModels!(nativeContext)).toEqual([]);
        expect(handle.getAvailability().state).toBe('checking');
        expect(saveCachedEntries).not.toHaveBeenCalled();
        expect(registeredProviders).toHaveLength(1);

        await handle.refreshStartupProjection({
            hasUI: true,
            ui: { notify: mock(() => {}) },
        } as unknown as LifecycleCtx);
        expect(handle.getAvailability().state).toBe('available');
        expect(registeredProviders.at(-1)?.config.models).toEqual([fakeModel]);
        expect(saveCachedEntries).toHaveBeenCalledWith([fakeEntry]);
        expect(buildModels).toHaveBeenCalledTimes(1);
    });

    test('an already aborted native refresh makes no catalog request', async () => {
        const { pi, registeredProviders } = createMockExtensionAPI();
        const buildModels = createMockBuildCpaModels();
        registerCpaProvider(pi, { buildModels });
        const provider = registeredProviders[0]!.config;
        const controller = new AbortController();
        controller.abort();
        const publish = mock(async () => true);

        expect(
            await provider.refreshModels!({
                allowNetwork: true,
                signal: controller.signal,
                publish,
            }),
        ).toEqual([]);
        expect(buildModels).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
    });

    test('a CPA outage does not contaminate a headless child using another provider', async () => {
        const { pi, registeredHandlers } = createMockExtensionAPI();
        const exitProcess = mock(() => {});
        const handle = registerCpaProvider(pi, {
            buildModels: createMockBuildCpaModels(),
            isSubagentChild: () => true,
            exitProcess,
        });
        const originalWarn = console.warn;
        const warn = mock(() => {});
        console.warn = warn;
        try {
            const ctx = {
                hasUI: false,
                model: { provider: 'openai', id: 'fixture' },
                modelRegistry: { find: () => undefined },
            } as unknown as LifecycleCtx;
            await handle.refreshStartupProjection(ctx);
            expect(warn).not.toHaveBeenCalled();
            const input = registeredHandlers.find(
                ({ event }) => event === 'input',
            )!;
            expect(
                await input.handler(
                    { text: 'blocked' },
                    { ...ctx, model: { provider: 'cpa', id: fakeModel.id } },
                ),
            ).toEqual({ action: 'handled' });
            expect(warn).toHaveBeenCalledTimes(1);
            expect(exitProcess).toHaveBeenCalledWith(1);
        } finally {
            console.warn = originalWarn;
        }
    });
    test('warns again after availability changes through an authoritative stale model', async () => {
        const { pi } = createMockExtensionAPI();
        let result: CpaCatalogResult = {
            source: 'unavailable',
            models: [],
            entries: [],
            failure: { kind: 'http', status: 401 },
        };
        const handle = registerCpaProvider(pi, {
            buildModels: mock(async () => result),
        });
        const notify = mock((_message: string, _level?: string) => {});
        const ctx = {
            model: { provider: 'cpa', id: fakeModel.id },
            hasUI: true,
            ui: { notify },
            modelRegistry: { find: () => undefined },
        } as unknown as LifecycleCtx;
        await handle.refreshProjection(ctx, { force: true });
        result = { source: 'live', models: [], entries: [] };
        await handle.refreshProjection(ctx, { force: true });
        result = {
            source: 'unavailable',
            models: [],
            entries: [],
            failure: { kind: 'http', status: 401 },
        };
        await handle.refreshProjection(ctx, { force: true });
        expect(
            notify.mock.calls.filter(([message]) => message.includes('401')),
        ).toHaveLength(2);
    });
    test('withdraws a verified catalog on failure and restores it only after a live refresh', async () => {
        const {
            pi,
            registeredProviders,
            unregisteredProviders,
            registeredHandlers,
        } = createMockExtensionAPI();
        let catalog: CpaCatalogResult = {
            source: 'live',
            entries: [fakeEntry],
            models: [fakeModel],
        };
        const buildModels = mock(async () => catalog);
        const saveCachedEntries = mock(async () => {});
        const handle = registerCpaProvider(pi, {
            buildModels,
            saveCachedEntries,
            loadCachedEntries: () => [fakeEntry],
        });
        const notify = mock((_message: string, _level?: string) => {});
        const ctx = {
            hasUI: true,
            ui: { notify },
            model: { provider: 'cpa', id: fakeModel.id },
            modelRegistry: { find: () => fakeModel },
        } as unknown as LifecycleCtx;
        await handle.refreshStartupProjection(ctx);
        expect(handle.getAvailability().state).toBe('available');
        expect(registeredProviders.at(-1)?.config.models).toEqual([fakeModel]);
        catalog = {
            source: 'unavailable',
            models: [],
            entries: [],
            failure: { kind: 'http', status: 401 },
        };
        await handle.refreshProjection(ctx, { force: true });
        expect(handle.getAvailability().state).toBe('unavailable');
        expect(handle.getAvailability().diagnostic).toContain('401');
        expect(unregisteredProviders).toEqual([]);
        expect(registeredProviders.at(-1)?.config.models).toEqual([]);
        expect(saveCachedEntries).toHaveBeenCalledTimes(1);
        const registrations = registeredProviders.length;
        const fetches = buildModels.mock.calls.length;
        await handle.refreshProjection(ctx);
        expect(registeredProviders).toHaveLength(registrations);
        expect(buildModels).toHaveBeenCalledTimes(fetches);
        const input = registeredHandlers.find(
            ({ event }) => event === 'input',
        )!;
        expect(await input.handler({ text: 'blocked' }, ctx)).toEqual({
            action: 'handled',
        });
        const compact = registeredHandlers.find(
            ({ event }) => event === 'session_before_compact',
        )!;
        expect(await compact.handler({}, ctx)).toEqual({ cancel: true });
        expect(
            notify.mock.calls.filter(([message]) =>
                String(message).includes('401'),
            ),
        ).toHaveLength(1);
        catalog = { source: 'live', entries: [fakeEntry], models: [fakeModel] };
        await handle.refreshProjection(ctx, { force: true });
        expect(handle.getAvailability().state).toBe('available');
        expect(await input.handler({ text: 'allowed' }, ctx)).toEqual({
            action: 'continue',
        });
        expect(saveCachedEntries).toHaveBeenCalledTimes(2);
    });

    test('verifies startup without a cache and treats an empty live catalog as authoritative', async () => {
        const { pi, registeredProviders, unregisteredProviders } =
            createMockExtensionAPI();
        const buildModels = mock(
            async (): Promise<CpaCatalogResult> => ({
                source: 'live',
                entries: [],
                models: [],
            }),
        );
        const saveCachedEntries = mock(async () => {});
        const handle = registerCpaProvider(pi, {
            buildModels,
            saveCachedEntries,
        });
        await handle.refreshStartupProjection({
            hasUI: true,
            ui: { notify: mock(() => {}) },
            modelRegistry: { find: () => undefined },
        } as unknown as LifecycleCtx);
        expect(buildModels).toHaveBeenCalledTimes(1);
        expect(registeredProviders[0]?.config.models).toEqual([]);
        expect(unregisteredProviders).toEqual([]);
        expect(registeredProviders.at(-1)?.config.models).toEqual([]);
        expect(handle.getAvailability().state).toBe('empty');
        expect(saveCachedEntries).toHaveBeenCalledWith([]);
    });
    test('uses the configured CPA endpoint for registration and catalog discovery', async () => {
        writeFixtureFile(
            configPath,
            JSON.stringify({
                cpa: { baseUrl: 'http://127.0.0.1:18317/v1' },
            }),
        );
        const { pi, registeredProviders } = createMockExtensionAPI();
        const buildModels = createMockBuildCpaModels();
        const handle = registerCpaProvider(pi, { buildModels });

        expect(registeredProviders[0].config.baseUrl).toBe(
            'http://127.0.0.1:18317/v1',
        );
        await handle.refreshProjection(
            {
                model: undefined,
                modelRegistry: { find: () => undefined },
                hasUI: false,
            } as unknown as LifecycleCtx,
            { force: true },
        );

        expect(buildModels).toHaveBeenCalledWith(
            'http://127.0.0.1:18317/v1',
            getCliproxyApiKey(),
        );
        expect(registeredProviders.at(-1)?.config.baseUrl).toBe(
            'http://127.0.0.1:18317/v1',
        );
    });

    test('prefers the normalized environment endpoint over the configured endpoint', async () => {
        writeFixtureFile(
            configPath,
            JSON.stringify({
                cpa: { baseUrl: 'http://127.0.0.1:18317/v1' },
            }),
        );
        process.env.CLIPROXY_BASE_URL =
            ' https://proxy.example.test/cpa/v1/// ';
        const { pi, registeredProviders } = createMockExtensionAPI();
        const buildModels = createMockBuildCpaModels();
        const handle = registerCpaProvider(pi, { buildModels });

        expect(registeredProviders[0].config.baseUrl).toBe(
            'https://proxy.example.test/cpa/v1',
        );
        await handle.refreshProjection(
            {
                model: undefined,
                modelRegistry: { find: () => undefined },
                hasUI: false,
            } as unknown as LifecycleCtx,
            { force: true },
        );
        expect(buildModels).toHaveBeenCalledWith(
            'https://proxy.example.test/cpa/v1',
            getCliproxyApiKey(),
        );
    });

    test.each([
        'invalid-endpoint',
        'ftp://proxy.example.test/v1',
        'https://user:fixture-password@proxy.example.test/v1',
        'https://proxy.example.test/v1?key=fixture-key',
        'https://proxy.example.test/v1?',
        'https://proxy.example.test/v1#fragment',
        'https://proxy.example.test/v1#',
    ])(
        'rejects an invalid CPA endpoint without registering a provider: %s',
        (baseUrl) => {
            process.env.CLIPROXY_BASE_URL = baseUrl;
            const { pi, registeredProviders } = createMockExtensionAPI();
            expect(() => registerCpaProvider(pi)).toThrow(
                'Invalid CPA base URL. Set CLIPROXY_BASE_URL or cpa.baseUrl to an absolute HTTP(S) URL without credentials, query parameters or a fragment.',
            );
            expect(registeredProviders).toHaveLength(0);
        },
    );

    test('ignores a blank environment override and normalizes the configured endpoint', () => {
        writeFixtureFile(
            configPath,
            JSON.stringify({
                cpa: { baseUrl: ' http://127.0.0.1:18317/v1/// ' },
            }),
        );
        process.env.CLIPROXY_BASE_URL = '  ';
        const { pi, registeredProviders } = createMockExtensionAPI();
        registerCpaProvider(pi);
        expect(registeredProviders[0].config.baseUrl).toBe(
            'http://127.0.0.1:18317/v1',
        );
    });

    test('keeps the verified catalog cache isolated when the CPA endpoint changes', async () => {
        const cachePath = join(
            agentDir,
            'artifacts',
            'cache',
            'ai-providers',
            'cpa-catalog.v1.json',
        );
        await createCpaCatalogCache({
            cachePath,
            endpoint: 'http://localhost:8317/v1',
        }).save([fakeEntry]);
        process.env.CLIPROXY_BASE_URL = 'http://127.0.0.1:18317/v1';
        const first = createMockExtensionAPI();
        const handle = registerCpaProviderProduction(first.pi, {
            buildModels: mock(async () => ({
                models: [fakeModel],
                entries: [fakeEntry],
                source: 'live' as const,
            })),
        });
        expect(first.registeredProviders[0].config.models).toEqual([]);

        await handle.refreshProjection(
            {
                model: undefined,
                modelRegistry: { find: () => undefined },
                hasUI: false,
            } as unknown as LifecycleCtx,
            { force: true },
        );

        const reloaded = createMockExtensionAPI();
        registerCpaProviderProduction(reloaded.pi);
        expect(reloaded.registeredProviders[0].config.models).toEqual([]);
        expect(
            createCpaCatalogCache({
                cachePath,
                endpoint: 'http://127.0.0.1:18317/v1',
            }).load(),
        ).toEqual([fakeEntry]);

        delete process.env.CLIPROXY_BASE_URL;
        const oldEndpoint = createMockExtensionAPI();
        registerCpaProviderProduction(oldEndpoint.pi);
        expect(oldEndpoint.registeredProviders[0].config.models).toEqual([]);
        expect(
            createCpaCatalogCache({
                cachePath,
                endpoint: 'http://localhost:8317/v1',
            }).load(),
        ).toBeUndefined();
    });

    test('registers with correct provider name', () => {
        const { pi, registeredProviders } = createMockExtensionAPI();
        registerCpaProvider(pi, { buildModels: createMockBuildCpaModels() });

        expect(registeredProviders.length).toBe(1);
        expect(registeredProviders[0].name).toBe('cpa');
    });

    test('registers with correct baseUrl, api, apiKey', () => {
        const { pi, registeredProviders } = createMockExtensionAPI();
        registerCpaProvider(pi, { buildModels: createMockBuildCpaModels() });

        const config = registeredProviders[0].config;
        expect(config.name).toBe('CLIProxyAPI');
        expect(config.baseUrl).toBe('http://localhost:8317/v1');
        expect(config.api).toBe('openai-completions');
        expect(config.apiKey).toBe(getCliproxyApiKey());
    });

    test('initial registration does not advertise unverified static models', () => {
        const { pi, registeredProviders } = createMockExtensionAPI();
        registerCpaProvider(pi, { buildModels: createMockBuildCpaModels() });

        const models = registeredProviders[0].config.models;
        expect(models).toBeDefined();
        expect(Array.isArray(models)).toBe(true);
        expect(models).toEqual([]);
    });

    test('does not advertise cached dynamic CPA models before live verification', () => {
        const { pi, registeredProviders } = createMockExtensionAPI();
        registerCpaProvider(pi, {
            buildModels: createMockBuildCpaModels(),
            loadCachedEntries: () => [fakeEntry],
            getCatalog: () => ({
                lookupFirst: () => undefined,
                lookupMerge: () => undefined,
            }),
        });

        const models = registeredProviders[0].config
            .models as ChatModelConfig[];
        expect(models).toEqual([]);
    });

    test('persists raw entries after a successful live catalog refresh', async () => {
        const { pi } = createMockExtensionAPI();
        const saveCachedEntries = mock(() => Promise.resolve());
        const mockBuild = mock(() =>
            Promise.resolve({
                models: [fakeModel],
                entries: [fakeEntry],
                source: 'live' as const,
            }),
        );
        const handle = registerCpaProvider(pi, {
            buildModels: mockBuild,
            saveCachedEntries,
        });

        await handle.refreshProjection(
            {
                model: { provider: 'cpa', id: fakeModel.id },
                modelRegistry: { find: () => fakeModel },
                hasUI: true,
                ui: { notify: mock(() => {}) },
            } as unknown as LifecycleCtx,
            { force: true },
        );

        expect(saveCachedEntries).toHaveBeenCalledWith([fakeEntry]);
    });

    test('provides a startup projection that refreshes the cached catalog live', async () => {
        const { pi } = createMockExtensionAPI();
        const mockBuild = mock(() =>
            Promise.resolve({
                models: [fakeModel],
                entries: [fakeEntry],
                source: 'live' as const,
            }),
        );
        const handle = registerCpaProvider(pi, {
            buildModels: mockBuild,
            loadCachedEntries: () => [fakeEntry],
        });

        await handle.refreshStartupProjection({
            model: { provider: 'cpa', id: fakeModel.id },
            modelRegistry: { find: () => fakeModel },
            hasUI: true,
            ui: { notify: mock(() => {}) },
        } as unknown as LifecycleCtx);

        expect(mockBuild).toHaveBeenCalledTimes(1);
    });

    test('leaves session_start ownership to the shared lifecycle', () => {
        const { pi, registeredHandlers } = createMockExtensionAPI();
        const handle = registerCpaProvider(pi, {
            buildModels: createMockBuildCpaModels(),
        });

        expect(handle.providerId).toBe('cpa');
        expect(
            registeredHandlers.filter(
                (handler) => handler.event === 'session_start',
            ),
        ).toEqual([]);
    });

    test('blocks input and directs the user to /model when the active CPA model is stale', async () => {
        const { pi, registeredHandlers } = createMockExtensionAPI();
        const mockBuild = mock(() =>
            Promise.resolve({
                models: [fakeModel],
                entries: [fakeEntry],
                source: 'live' as const,
            }),
        );
        registerCpaProvider(pi, { buildModels: mockBuild });
        const handler = registeredHandlers.find(
            (entry) => entry.event === 'input',
        );
        const notify = mock(() => {});
        const mockCtx = {
            model: { provider: 'cpa', id: 'ocg/deepseek-v4-pro' },
            modelRegistry: { find: () => undefined },
            hasUI: true,
            ui: { notify },
        };

        const result = await handler!.handler({ text: 'continue' }, mockCtx);

        expect(result).toEqual({ action: 'handled' });
        expect(notify).toHaveBeenCalledWith(
            expect.stringContaining('/model'),
            'warning',
        );
    });

    test('shuts down stale CPA input in standalone headless mode', async () => {
        const { pi, registeredHandlers } = createMockExtensionAPI();
        const mockBuild = mock(() =>
            Promise.resolve({
                models: [fakeModel],
                entries: [fakeEntry],
                source: 'live' as const,
            }),
        );
        registerCpaProvider(pi, { buildModels: mockBuild });
        const handler = registeredHandlers.find(
            (entry) => entry.event === 'input',
        )!;
        const warn = mock(() => {});
        const shutdown = mock(() => {});
        const originalWarn = console.warn;
        console.warn = warn;
        try {
            const result = await handler.handler(
                { text: 'continue' },
                {
                    model: { provider: 'cpa', id: 'ocg/missing-model' },
                    modelRegistry: { find: () => undefined },
                    hasUI: false,
                    shutdown,
                },
            );

            expect(result).toEqual({ action: 'handled' });
            expect(shutdown).toHaveBeenCalledTimes(1);
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('ocg/missing-model'),
            );
        } finally {
            console.warn = originalWarn;
        }
    });

    test('terminates a stale CPA subagent child so outer fallback can run', async () => {
        const { pi, registeredHandlers } = createMockExtensionAPI();
        const mockBuild = mock(() =>
            Promise.resolve({
                models: [fakeModel],
                entries: [fakeEntry],
                source: 'live' as const,
            }),
        );
        const exitProcess = mock(() => {});
        registerCpaProvider(pi, {
            buildModels: mockBuild,
            isSubagentChild: () => true,
            exitProcess,
        });
        const handler = registeredHandlers.find(
            (entry) => entry.event === 'input',
        )!;
        const shutdown = mock(() => {});
        const error = mock(() => {});
        const originalError = console.error;
        console.error = error;
        try {
            const result = await handler.handler(
                { text: 'continue' },
                {
                    model: { provider: 'cpa', id: 'ocg/missing-model' },
                    modelRegistry: { find: () => undefined },
                    hasUI: false,
                    shutdown,
                },
            );

            expect(result).toEqual({ action: 'handled' });
            expect(exitProcess).toHaveBeenCalledWith(1);
            expect(shutdown).not.toHaveBeenCalled();
            expect(error).toHaveBeenCalledWith(
                expect.stringContaining('Model ocg/missing-model not found'),
            );
        } finally {
            console.error = originalError;
        }
    });

    test('does not repeat the stale warning for the same model state', async () => {
        const { pi, registeredHandlers } = createMockExtensionAPI();
        const mockBuild = mock(() =>
            Promise.resolve({
                models: [fakeModel],
                entries: [fakeEntry],
                source: 'live' as const,
            }),
        );
        registerCpaProvider(pi, { buildModels: mockBuild });
        const handler = registeredHandlers.find(
            (entry) => entry.event === 'input',
        )!;
        const notify = mock(() => {});
        const mockCtx = {
            model: { provider: 'cpa', id: 'ocg/deepseek-v4-pro' },
            modelRegistry: { find: () => undefined },
            hasUI: true,
            ui: { notify },
        };

        await handler.handler({ text: 'first' }, mockCtx);
        await handler.handler({ text: 'second' }, mockCtx);

        // Only one stale warning (drift is dedup'd separately).
        const staleNotify = (notify.mock.calls as unknown[][]).filter((c) =>
            String(c[0]).includes('/model'),
        );
        expect(staleNotify.length).toBe(1);
    });

    test('blocks input with one warning when the CPA catalog cannot be verified', async () => {
        const { pi, registeredHandlers } = createMockExtensionAPI();
        const mockBuild = mock(() =>
            Promise.resolve({
                models: [],
                entries: [],
                source: 'unavailable' as const,
                failure: { kind: 'http' as const, status: 401 },
            }),
        );
        registerCpaProvider(pi, { buildModels: mockBuild });
        const handler = registeredHandlers.find(
            (entry) => entry.event === 'input',
        )!;
        const notify = mock(() => {});
        const mockCtx = {
            model: { provider: 'cpa', id: fakeModel.id },
            modelRegistry: { find: () => fakeModel },
            hasUI: true,
            ui: { notify },
        };

        const first = await handler.handler({ text: 'first' }, mockCtx);
        const second = await handler.handler({ text: 'second' }, mockCtx);

        expect(first).toEqual({ action: 'handled' });
        expect(second).toEqual({ action: 'handled' });
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith(
            expect.stringContaining('unavailable'),
            'warning',
        );
    });

    test('cancels compaction when the active CPA model is stale', async () => {
        const { pi, registeredHandlers } = createMockExtensionAPI();
        const mockBuild = mock(() =>
            Promise.resolve({
                models: [fakeModel],
                entries: [fakeEntry],
                source: 'live' as const,
            }),
        );
        registerCpaProvider(pi, { buildModels: mockBuild });
        const handler = registeredHandlers.find(
            (entry) => entry.event === 'session_before_compact',
        );
        const notify = mock(() => {});
        const mockCtx = {
            model: { provider: 'cpa', id: 'ocg/deepseek-v4-pro' },
            modelRegistry: { find: () => undefined },
            hasUI: true,
            ui: { notify },
        };

        const result = await handler!.handler({ preparation: {} }, mockCtx);

        expect(result).toEqual({ cancel: true });
        expect(notify).toHaveBeenCalledWith(
            expect.stringContaining('/model'),
            'warning',
        );
    });

    test('revalidates immediately after selecting a different CPA model', async () => {
        const { pi, registeredHandlers } = createMockExtensionAPI();
        const mockBuild = mock(() =>
            Promise.resolve({
                models: [fakeModel],
                entries: [fakeEntry],
                source: 'live' as const,
            }),
        );
        registerCpaProvider(pi, { buildModels: mockBuild });
        const modelSelect = registeredHandlers.find(
            (entry) => entry.event === 'model_select',
        );
        const input = registeredHandlers.find(
            (entry) => entry.event === 'input',
        )!;
        const mockCtx = {
            model: { provider: 'cpa', id: fakeModel.id },
            modelRegistry: {
                find: (_provider: string, id: string) =>
                    id === fakeModel.id ? fakeModel : undefined,
            },
            hasUI: true,
            ui: { notify: mock(() => {}) },
        };

        await modelSelect!.handler({ model: mockCtx.model }, mockCtx);
        const result = await input.handler({ text: 'continue' }, mockCtx);

        expect(result).toEqual({ action: 'continue' });
        expect(mockBuild).toHaveBeenCalledTimes(1);
    });

    test('warns immediately when a selected CPA model is stale', async () => {
        const { pi, registeredHandlers } = createMockExtensionAPI();
        const mockBuild = mock(() =>
            Promise.resolve({
                models: [fakeModel],
                entries: [fakeEntry],
                source: 'live' as const,
            }),
        );
        registerCpaProvider(pi, { buildModels: mockBuild });
        const modelSelect = registeredHandlers.find(
            (entry) => entry.event === 'model_select',
        )!;
        const notify = mock(() => {});
        const mockCtx = {
            model: { provider: 'cpa', id: 'ocg/deepseek-v4-pro' },
            modelRegistry: { find: () => undefined },
            hasUI: true,
            ui: { notify },
        };

        await modelSelect.handler({ model: mockCtx.model }, mockCtx);

        expect(notify).toHaveBeenCalledWith(
            expect.stringContaining('/model'),
            'warning',
        );
    });

    test('registers /cpa-refresh and reports a stale active model', async () => {
        const { pi, registeredCommands } = createMockExtensionAPI();
        const mockBuild = mock(() =>
            Promise.resolve({
                models: [fakeModel],
                entries: [fakeEntry],
                source: 'live' as const,
            }),
        );
        registerCpaProvider(pi, { buildModels: mockBuild });
        const command = registeredCommands.find(
            (entry) => entry.name === 'cpa-refresh',
        );
        const notify = mock(() => {});
        const mockCtx = {
            model: { provider: 'cpa', id: 'ocg/deepseek-v4-pro' },
            modelRegistry: { find: () => undefined },
            hasUI: true,
            ui: { notify },
        };

        await command!.handler('', mockCtx);

        expect(notify).toHaveBeenCalledWith(
            expect.stringContaining('/model'),
            'warning',
        );
    });

    test('returns a handle whose refreshProjection refreshes through the catalog guard', async () => {
        const { pi, registeredProviders } = createMockExtensionAPI();
        const mockBuild = mock(() =>
            Promise.resolve({
                models: [fakeModel],
                entries: [fakeEntry],
                source: 'live' as const,
            }),
        );

        const handle = registerCpaProvider(pi, { buildModels: mockBuild });
        expect(handle).toBeDefined();
        expect(typeof handle.refreshProjection).toBe('function');

        const notify = mock(() => {});
        const mockCtx = {
            model: { provider: 'cpa', id: fakeModel.id },
            modelRegistry: { find: () => fakeModel },
            hasUI: true,
            ui: { notify },
        };

        await handle.refreshProjection(mockCtx as unknown as LifecycleCtx);

        // refreshProjection runs the existing forced refresh: model reloaded,
        // provider re-registered, active model validated.
        expect(mockBuild).toHaveBeenCalledWith(
            'http://localhost:8317/v1',
            expect.any(String),
        );
        expect(registeredProviders.length).toBe(2);
        expect(registeredProviders[1].config.models).toEqual([fakeModel]);
        expect(notify).toHaveBeenCalledWith(
            expect.stringContaining('verified'),
            'info',
        );
    });

    test('returns a handle whose refreshProjection reports a stale active model', async () => {
        const { pi } = createMockExtensionAPI();
        const mockBuild = mock(() =>
            Promise.resolve({
                models: [fakeModel],
                entries: [fakeEntry],
                source: 'live' as const,
            }),
        );

        const handle = registerCpaProvider(pi, { buildModels: mockBuild });
        const notify = mock(() => {});
        const mockCtx = {
            model: { provider: 'cpa', id: 'ocg/deepseek-v4-pro' },
            modelRegistry: { find: () => undefined },
            hasUI: true,
            ui: { notify },
        };

        await handle.refreshProjection(mockCtx as unknown as LifecycleCtx);

        expect(notify).toHaveBeenCalledWith(
            expect.stringContaining('/model'),
            'warning',
        );
    });

    test('does NOT register a streamSimple (built-in openai-completions used)', () => {
        const { pi, registeredProviders } = createMockExtensionAPI();
        registerCpaProvider(pi, { buildModels: createMockBuildCpaModels() });

        const config = registeredProviders[0].config as Record<string, unknown>;
        expect(config.streamSimple).toBeUndefined();
    });

    test('does NOT register oauth (simple API key auth)', () => {
        const { pi, registeredProviders } = createMockExtensionAPI();
        registerCpaProvider(pi, { buildModels: createMockBuildCpaModels() });

        const config = registeredProviders[0].config as Record<string, unknown>;
        expect(config.oauth).toBeUndefined();
    });

    test('refreshProjection with force:false does not call buildModels again within TTL', async () => {
        const { pi, registeredProviders } = createMockExtensionAPI();
        const mockBuild = mock(() =>
            Promise.resolve({
                models: [fakeModel],
                entries: [fakeEntry],
                source: 'live' as const,
            }),
        );
        const handle = registerCpaProvider(pi, { buildModels: mockBuild });

        const mockCtx = {
            model: { provider: 'cpa', id: fakeModel.id },
            modelRegistry: { find: () => fakeModel },
            hasUI: true,
            ui: { notify: mock(() => {}) },
        };

        // First call with force:true does a live fetch
        await handle.refreshProjection(mockCtx as unknown as LifecycleCtx, {
            force: true,
        });
        expect(mockBuild).toHaveBeenCalledTimes(1);
        expect(registeredProviders).toHaveLength(2);

        // Second call without force re-registers from cache within TTL — no new fetch
        await handle.refreshProjection(mockCtx as unknown as LifecycleCtx);
        expect(mockBuild).toHaveBeenCalledTimes(1); // still 1
        expect(registeredProviders).toHaveLength(3); // third registration from cached data
    });

    test('refreshProjection re-enriches cached entries from the current models.dev snapshot', async () => {
        const { pi, registeredProviders, registeredHandlers } =
            createMockExtensionAPI();
        const entry: CpaModelEntry = { id: 'gpt-test', owned_by: 'openai' };
        const verifiedModel = { ...fakeModel, id: entry.id };
        const mockBuild = mock(() =>
            Promise.resolve({
                models: [verifiedModel],
                entries: [entry],
                source: 'live' as const,
            }),
        );
        let catalogContextWindow = 4_000;
        const catalog = {
            lookupFirst: () => undefined,
            lookupMerge: () => ({
                name: 'GPT Test',
                contextWindow: catalogContextWindow,
            }),
        };
        const handle = registerCpaProvider(pi, {
            buildModels: mockBuild,
            getCatalog: () => catalog,
        });
        const mockCtx = {
            model: { provider: 'cpa', id: verifiedModel.id },
            modelRegistry: { find: () => verifiedModel },
            hasUI: true,
            ui: { notify: mock(() => {}) },
        };

        await handle.refreshProjection(mockCtx as unknown as LifecycleCtx, {
            force: true,
        });
        catalogContextWindow = 9_000;
        await handle.refreshProjection(mockCtx as unknown as LifecycleCtx);

        expect(mockBuild).toHaveBeenCalledTimes(1);
        expect(registeredProviders.at(-1)?.config.models).toHaveLength(1);
        expect(registeredProviders.at(-1)?.config.models?.[0]).toMatchObject({
            contextWindow: 9_000,
        });
        const input = registeredHandlers.find(
            ({ event }) => event === 'input',
        )!;
        expect(await input.handler({}, mockCtx)).toEqual({
            action: 'continue',
        });
        const provider = registeredProviders.at(-1)!.config;
        const models = await provider.refreshModels!({
            allowNetwork: false,
            signal: new AbortController().signal,
            publish: async () => true,
        });
        expect(models).toHaveLength(1);
        expect(models[0]).toMatchObject({ contextWindow: 9_000 });
        expect(mockBuild).toHaveBeenCalledTimes(1);
    });

    test('refreshProjection with force:true triggers a live fetch even within TTL', async () => {
        const { pi, registeredProviders } = createMockExtensionAPI();
        const mockBuild = mock(() =>
            Promise.resolve({
                models: [fakeModel],
                entries: [fakeEntry],
                source: 'live' as const,
            }),
        );
        const handle = registerCpaProvider(pi, { buildModels: mockBuild });

        const mockCtx = {
            model: { provider: 'cpa', id: fakeModel.id },
            modelRegistry: { find: () => fakeModel },
            hasUI: true,
            ui: { notify: mock(() => {}) },
        };

        await handle.refreshProjection(mockCtx as unknown as LifecycleCtx, {
            force: true,
        });
        await handle.refreshProjection(mockCtx as unknown as LifecycleCtx, {
            force: true,
        });

        expect(mockBuild).toHaveBeenCalledTimes(2);
        expect(registeredProviders).toHaveLength(3);
    });

    test('refreshProjection performs the dynamic registration once', async () => {
        const { pi, registeredProviders } = createMockExtensionAPI();
        const mockBuild = mock(() =>
            Promise.resolve({
                models: [fakeModel],
                entries: [fakeEntry],
                source: 'live' as const,
            }),
        );
        const handle = registerCpaProvider(pi, { buildModels: mockBuild });

        await handle.refreshProjection({
            modelRegistry: { find: () => undefined },
            hasUI: true,
            ui: { notify: mock(() => {}) },
        } as unknown as LifecycleCtx);

        expect(mockBuild).toHaveBeenCalledTimes(1);
        expect(registeredProviders).toHaveLength(2);
        expect(registeredProviders[1].config.models).toEqual([fakeModel]);
    });

    test('routes catalog drift to ctx.ui.notify at runtime (input hook)', async () => {
        const { pi, registeredHandlers } = createMockExtensionAPI();
        const driftModel: ChatModelConfig = {
            id: 'ocg/go-runtime-drift-model',
            name: 'Drift',
            reasoning: true,
            input: ['text'],
            contextWindow: 2000,
            maxTokens: 200,
            cost: { input: 0.5, output: 1.0, cacheRead: 0, cacheWrite: 0 },
        };
        const mockBuild = mock(() =>
            Promise.resolve({
                models: [...STATIC_FALLBACK_MODELS, driftModel],
                entries: [fakeEntry],
                source: 'live' as const,
            }),
        );
        registerCpaProvider(pi, { buildModels: mockBuild });

        const warnSpy = mock(() => {});
        const originalWarn = console.warn;
        console.warn = warnSpy;
        // Theme mock: capture fg calls so themed sink formats with colors.
        const fg = mock((_color: string, text: string) => text);
        const notify = mock(() => {});
        try {
            const handler = registeredHandlers.find(
                (h) => h.event === 'input',
            )!;
            await handler.handler(
                { text: 'hello' },
                {
                    model: {
                        provider: 'cpa',
                        id: STATIC_FALLBACK_MODELS[0].id,
                    },
                    modelRegistry: { find: () => STATIC_FALLBACK_MODELS[0] },
                    hasUI: true,
                    ui: { notify, theme: { fg } },
                },
            );
        } finally {
            console.warn = originalWarn;
        }

        // Runtime sink: themed drift message goes to ui.notify (no console).
        // The themed body contains "[cpa]" + "new model(s)" + "missing fallback".
        const driftNotify = (notify.mock.calls as unknown[][])
            .map((c) => String(c[0]))
            .filter((m) => m.includes('new model') && m.includes('[cpa]'));
        expect(driftNotify.length).toBe(1);
        const driftConsole = (warnSpy.mock.calls as unknown[][])
            .map((c) => String(c[0]))
            .filter((m) => m.includes('Catalog drift'));
        expect(driftConsole.length).toBe(0);
    });

    test('does not write catalog drift to stderr in a headless child', async () => {
        const { pi, registeredHandlers } = createMockExtensionAPI();
        const driftModel: ChatModelConfig = {
            id: 'ocg/go-headless-drift-model',
            name: 'Headless drift',
            reasoning: true,
            input: ['text'],
            contextWindow: 2000,
            maxTokens: 200,
            cost: { input: 0.5, output: 1.0, cacheRead: 0, cacheWrite: 0 },
        };
        const mockBuild = mock(() =>
            Promise.resolve({
                models: [...STATIC_FALLBACK_MODELS, driftModel],
                entries: [fakeEntry],
                source: 'live' as const,
            }),
        );
        const saveHeadlessCatalogDrift = mock(() => {});
        registerCpaProvider(pi, {
            buildModels: mockBuild,
            saveHeadlessCatalogDrift,
        } as Parameters<typeof registerCpaProviderProduction>[1]);

        const warnSpy = mock(() => {});
        const originalWarn = console.warn;
        console.warn = warnSpy;
        try {
            const handler = registeredHandlers.find(
                (entry) => entry.event === 'input',
            )!;
            await handler.handler(
                { text: 'review memory' },
                {
                    model: {
                        provider: 'cpa',
                        id: STATIC_FALLBACK_MODELS[0].id,
                    },
                    modelRegistry: { find: () => STATIC_FALLBACK_MODELS[0] },
                    hasUI: false,
                    shutdown: mock(() => {}),
                },
            );
        } finally {
            console.warn = originalWarn;
        }

        const driftConsole = (warnSpy.mock.calls as unknown[][])
            .map((call) => String(call[0]))
            .filter((message) => message.includes('Catalog drift'));
        expect(driftConsole).toEqual([]);
        expect(saveHeadlessCatalogDrift).toHaveBeenCalledWith({
            newCount: 1,
            missingFallbackCount: 0,
        });
    });
});
