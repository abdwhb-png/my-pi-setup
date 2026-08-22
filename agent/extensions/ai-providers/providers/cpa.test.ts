/**
 * Tests for cpa.ts — CPA provider registration.
 *
 * Covers:
 *   - registerCpaProvider registers with correct name, baseUrl, api, apiKey
 *   - Initial registration uses STATIC_FALLBACK_MODELS
 *   - Does not register a provider-local session_start handler
 *   - Exposes a stable provider projection handle
 */

import { describe, test, expect, mock } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent';
import { STATIC_FALLBACK_MODELS } from '../constants/cpa-static-models';
import {
    registerCpaProvider as registerCpaProviderProduction,
    getCliproxyApiKey,
} from './cpa.ts';
import type { CpaModelEntry } from './cpa-models.ts';
import type { LifecycleCtx } from './cpa.ts';

interface RegisteredProvider {
    name: string;
    config: {
        name?: string;
        baseUrl?: string;
        api?: string;
        apiKey?: string;
        models?: unknown[];
    };
}

interface RegisteredHandler {
    event: string;
    handler: (...args: unknown[]) => unknown | Promise<unknown>;
}

function createMockExtensionAPI(): {
    pi: ExtensionAPI;
    registeredProviders: RegisteredProvider[];
    registeredHandlers: RegisteredHandler[];
    registeredCommands: Array<{
        name: string;
        handler: (...args: unknown[]) => unknown | Promise<unknown>;
    }>;
} {
    const registeredProviders: RegisteredProvider[] = [];
    const registeredHandlers: RegisteredHandler[] = [];
    const registeredCommands: Array<{
        name: string;
        handler: (...args: unknown[]) => unknown | Promise<unknown>;
    }> = [];

    // biome-ignore lint/suspicious/noExplicitAny: mock implementation with limited surface
    const pi = {
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

    return { pi, registeredProviders, registeredHandlers, registeredCommands };
}

function createMockBuildCpaModels() {
    return mock((_baseUrl: string, _apiKey: string) => {
        return Promise.resolve({
            models: STATIC_FALLBACK_MODELS,
            entries: [],
            source: 'fallback' as const,
        });
    });
}

const fakeModel: ProviderModelConfig = {
    id: 'ocg/go-test',
    name: 'Test Model',
    reasoning: true,
    input: ['text'],
    contextWindow: 2000,
    maxTokens: 200,
    cost: { input: 0.5, output: 1.0, cacheRead: 0, cacheWrite: 0 },
};

const fakeEntry: CpaModelEntry = { id: 'ocg/go-test', owned_by: 'ocode-go (main)' };

function registerCpaProvider(
    pi: ExtensionAPI,
    options: Parameters<typeof registerCpaProviderProduction>[1] = {},
) {
    return registerCpaProviderProduction(pi, {
        ...options,
        loadCachedEntries: options.loadCachedEntries ?? (() => undefined),
        saveCachedEntries:
            options.saveCachedEntries ?? (async () => undefined),
    });
}

// ── Tests ──

describe('registerCpaProvider', () => {
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
        expect(config.name).toBe('CLIProxyAPI (local)');
        expect(config.baseUrl).toBe('http://localhost:8317/v1');
        expect(config.api).toBe('openai-completions');
        expect(config.apiKey).toBe(getCliproxyApiKey());
    });

    test('initial registration uses STATIC_FALLBACK_MODELS', () => {
        const { pi, registeredProviders } = createMockExtensionAPI();
        registerCpaProvider(pi, { buildModels: createMockBuildCpaModels() });

        const models = registeredProviders[0].config.models;
        expect(models).toBeDefined();
        expect(Array.isArray(models)).toBe(true);
        expect(models!.length).toBe(STATIC_FALLBACK_MODELS.length);
        expect(models).toEqual(STATIC_FALLBACK_MODELS);
    });

    test('registers cached dynamic CPA models before session creation', () => {
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
            .models as ProviderModelConfig[];
        expect(models.map((model) => model.id)).toContain(fakeEntry.id);
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

        await handle.refreshProjection({
            model: { provider: 'cpa', id: fakeModel.id },
            modelRegistry: { find: () => fakeModel },
            hasUI: true,
            ui: { notify: mock(() => {}) },
        } as unknown as LifecycleCtx, { force: true });

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
            registeredHandlers.filter((handler) => handler.event === 'session_start'),
        ).toEqual([]);
    });

    test('blocks input and directs the user to /model when the active CPA model is stale', async () => {
        const { pi, registeredHandlers } = createMockExtensionAPI();
        const mockBuild = mock(() =>
            Promise.resolve({ models: [fakeModel], entries: [fakeEntry], source: 'live' as const }),
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
            Promise.resolve({ models: [fakeModel], entries: [fakeEntry], source: 'live' as const }),
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
            Promise.resolve({ models: [fakeModel], entries: [fakeEntry], source: 'live' as const }),
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
            Promise.resolve({ models: [fakeModel], entries: [fakeEntry], source: 'live' as const }),
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

    test('continues with one warning when the CPA catalog cannot be verified', async () => {
        const { pi, registeredHandlers } = createMockExtensionAPI();
        const mockBuild = mock(() =>
            Promise.resolve({
                models: STATIC_FALLBACK_MODELS,
                entries: [], source: 'fallback' as const,
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

        expect(first).toEqual({ action: 'continue' });
        expect(second).toEqual({ action: 'continue' });
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith(
            expect.stringContaining('indisponible'),
            'warning',
        );
    });

    test('cancels compaction when the active CPA model is stale', async () => {
        const { pi, registeredHandlers } = createMockExtensionAPI();
        const mockBuild = mock(() =>
            Promise.resolve({ models: [fakeModel], entries: [fakeEntry], source: 'live' as const }),
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
            Promise.resolve({ models: [fakeModel], entries: [fakeEntry], source: 'live' as const }),
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
            Promise.resolve({ models: [fakeModel], entries: [fakeEntry], source: 'live' as const }),
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
            Promise.resolve({ models: [fakeModel], entries: [fakeEntry], source: 'live' as const }),
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
            Promise.resolve({ models: [fakeModel], entries: [fakeEntry], source: 'live' as const }),
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
            expect.stringContaining('actualisé'),
            'info',
        );
    });

    test('returns a handle whose refreshProjection reports a stale active model', async () => {
        const { pi } = createMockExtensionAPI();
        const mockBuild = mock(() =>
            Promise.resolve({ models: [fakeModel], entries: [fakeEntry], source: 'live' as const }),
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
            Promise.resolve({ models: [fakeModel], entries: [fakeEntry], source: 'live' as const }),
        );
        const handle = registerCpaProvider(pi, { buildModels: mockBuild });

        const mockCtx = {
            model: { provider: 'cpa', id: fakeModel.id },
            modelRegistry: { find: () => fakeModel },
            hasUI: true,
            ui: { notify: mock(() => {}) },
        };

        // First call with force:true does a live fetch
        await handle.refreshProjection(mockCtx as unknown as LifecycleCtx, { force: true });
        expect(mockBuild).toHaveBeenCalledTimes(1);
        expect(registeredProviders).toHaveLength(2);

        // Second call without force re-registers from cache within TTL — no new fetch
        await handle.refreshProjection(mockCtx as unknown as LifecycleCtx);
        expect(mockBuild).toHaveBeenCalledTimes(1); // still 1
        expect(registeredProviders).toHaveLength(3); // third registration from cached data
    });

    test('refreshProjection re-enriches cached entries from the current models.dev snapshot', async () => {
        const { pi, registeredProviders } = createMockExtensionAPI();
        const entry: CpaModelEntry = { id: 'gpt-test', owned_by: 'openai' };
        const mockBuild = mock(() =>
            Promise.resolve({ models: [fakeModel], entries: [entry], source: 'live' as const }),
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
            model: { provider: 'cpa', id: fakeModel.id },
            modelRegistry: { find: () => fakeModel },
            hasUI: true,
            ui: { notify: mock(() => {}) },
        };

        await handle.refreshProjection(mockCtx as unknown as LifecycleCtx, { force: true });
        catalogContextWindow = 9_000;
        await handle.refreshProjection(mockCtx as unknown as LifecycleCtx);

        expect(mockBuild).toHaveBeenCalledTimes(1);
        expect(registeredProviders.at(-1)?.config.models).toHaveLength(1);
        const reprojected = registeredProviders.at(-1)?.config.models?.[0] as
            | ProviderModelConfig
            | undefined;
        expect(reprojected?.contextWindow).toBe(9_000);
    });

    test('refreshProjection with force:true triggers a live fetch even within TTL', async () => {
        const { pi, registeredProviders } = createMockExtensionAPI();
        const mockBuild = mock(() =>
            Promise.resolve({ models: [fakeModel], entries: [fakeEntry], source: 'live' as const }),
        );
        const handle = registerCpaProvider(pi, { buildModels: mockBuild });

        const mockCtx = {
            model: { provider: 'cpa', id: fakeModel.id },
            modelRegistry: { find: () => fakeModel },
            hasUI: true,
            ui: { notify: mock(() => {}) },
        };

        await handle.refreshProjection(mockCtx as unknown as LifecycleCtx, { force: true });
        await handle.refreshProjection(mockCtx as unknown as LifecycleCtx, { force: true });

        expect(mockBuild).toHaveBeenCalledTimes(2);
        expect(registeredProviders).toHaveLength(3);
    });

    test('refreshProjection performs the dynamic registration once', async () => {
        const { pi, registeredProviders } = createMockExtensionAPI();
        const mockBuild = mock(() =>
            Promise.resolve({ models: [fakeModel], entries: [fakeEntry], source: 'live' as const }),
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
        const driftModel: ProviderModelConfig = {
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
                entries: [fakeEntry], source: 'live' as const,
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
});
