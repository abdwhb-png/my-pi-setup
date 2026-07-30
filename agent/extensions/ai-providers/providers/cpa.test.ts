/**
 * Tests for cpa.ts — CPA provider registration.
 *
 * Covers:
 *   - registerCpaProvider registers with correct name, baseUrl, api, apiKey
 *   - Initial registration uses STATIC_FALLBACK_MODELS
 *   - Registers a session_start event handler
 *   - session_start handler calls buildCpaModels and re-registers
 *   - session_start handler does NOT re-register if dynamicModels is empty
 *   - session_start handler catches errors without throwing
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent';
import { STATIC_FALLBACK_MODELS } from '../constants/cpa-static-models';
import { resetOrMetadataCache } from './cpa-models.ts';
import { registerCpaProvider, getCliproxyApiKey } from './cpa.ts';

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

beforeEach(() => {
    resetOrMetadataCache();
});

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

    test('registers a session_start event handler', () => {
        const { pi, registeredHandlers } = createMockExtensionAPI();
        registerCpaProvider(pi, { buildModels: createMockBuildCpaModels() });

        const handlers = registeredHandlers.filter(
            (h) => h.event === 'session_start',
        );
        expect(handlers.length).toBe(1);
    });

    test('session_start handler calls buildModels with correct args', async () => {
        const { pi, registeredHandlers } = createMockExtensionAPI();
        const mockBuild = mock((_baseUrl: string, _apiKey: string) => {
            return Promise.resolve({
                models: [fakeModel],
                source: 'live' as const,
            });
        });

        registerCpaProvider(pi, { buildModels: mockBuild });

        const handler = registeredHandlers.find(
            (h) => h.event === 'session_start',
        );
        expect(handler).toBeDefined();

        const mockCtx = {
            modelRegistry: {
                registerProvider: () => {},
                authStorage: { get: () => undefined },
            },
        };

        await handler!.handler({}, mockCtx);

        expect(mockBuild).toHaveBeenCalledWith(
            'http://localhost:8317/v1',
            expect.any(String),
        );
    });

    test('session_start handler re-registers with dynamic models when available', async () => {
        const { pi, registeredProviders, registeredHandlers } =
            createMockExtensionAPI();
        const mockBuild = mock(() =>
            Promise.resolve({ models: [fakeModel], source: 'live' as const }),
        );

        registerCpaProvider(pi, { buildModels: mockBuild });

        // Initial registration
        expect(registeredProviders.length).toBe(1);
        expect(registeredProviders[0].config.models).toEqual(
            STATIC_FALLBACK_MODELS,
        );

        const handler = registeredHandlers.find(
            (h) => h.event === 'session_start',
        )!;
        const mockCtx = {
            modelRegistry: {
                find: () => undefined,
                authStorage: { get: () => undefined },
            },
        };

        await handler.handler({}, mockCtx);

        // Should have re-registered with dynamic models
        expect(registeredProviders.length).toBe(2);
        expect(registeredProviders[1].name).toBe('cpa');
        expect(registeredProviders[1].config.models).toEqual([fakeModel]);
    });

    test('session_start handler does NOT re-register if dynamicModels is empty', async () => {
        const { pi, registeredProviders, registeredHandlers } =
            createMockExtensionAPI();
        const mockBuild = mock(() =>
            Promise.resolve({
                models: STATIC_FALLBACK_MODELS,
                source: 'fallback' as const,
            }),
        );

        registerCpaProvider(pi, { buildModels: mockBuild });

        expect(registeredProviders.length).toBe(1);

        const handler = registeredHandlers.find(
            (h) => h.event === 'session_start',
        )!;
        const mockCtx = {
            modelRegistry: {
                registerProvider: () => {},
                authStorage: { get: () => undefined },
            },
        };

        await handler.handler({}, mockCtx);

        // No additional registration
        expect(registeredProviders.length).toBe(1);
    });

    test('session_start handler catches errors without throwing', async () => {
        const { pi, registeredHandlers } = createMockExtensionAPI();
        const mockBuild = mock(() => {
            return Promise.reject(new Error('Network failure'));
        });

        registerCpaProvider(pi, { buildModels: mockBuild });

        const handler = registeredHandlers.find(
            (h) => h.event === 'session_start',
        )!;
        const mockCtx = {
            modelRegistry: {
                registerProvider: () => {},
                authStorage: { get: () => undefined },
            },
        };

        // Should not throw
        await expect(handler.handler({}, mockCtx)).resolves.toBeUndefined();
    });

    test('blocks input and directs the user to /model when the active CPA model is stale', async () => {
        const { pi, registeredHandlers } = createMockExtensionAPI();
        const mockBuild = mock(() =>
            Promise.resolve({ models: [fakeModel], source: 'live' as const }),
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
            Promise.resolve({ models: [fakeModel], source: 'live' as const }),
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
            Promise.resolve({ models: [fakeModel], source: 'live' as const }),
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
            Promise.resolve({ models: [fakeModel], source: 'live' as const }),
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
                source: 'fallback' as const,
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
            Promise.resolve({ models: [fakeModel], source: 'live' as const }),
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
            Promise.resolve({ models: [fakeModel], source: 'live' as const }),
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
            Promise.resolve({ models: [fakeModel], source: 'live' as const }),
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
            Promise.resolve({ models: [fakeModel], source: 'live' as const }),
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

    test('routes catalog drift to console.warn at session_start', async () => {
        const { pi, registeredHandlers } = createMockExtensionAPI();
        // Live catalog includes a model NOT in STATIC_FALLBACK_MODELS → drift.
        const driftModel: ProviderModelConfig = {
            id: 'ocg/go-brand-new-drift-model',
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
                source: 'live' as const,
            }),
        );
        registerCpaProvider(pi, { buildModels: mockBuild });

        const warnSpy = mock(() => {});
        const originalWarn = console.warn;
        console.warn = warnSpy;
        const notify = mock(() => {});
        try {
            const handler = registeredHandlers.find(
                (h) => h.event === 'session_start',
            )!;
            await handler.handler(
                {},
                {
                    modelRegistry: { find: () => undefined },
                    hasUI: true,
                    ui: { notify },
                },
            );
        } finally {
            console.warn = originalWarn;
        }

        // Drift surfaces once via console.warn at startup.
        const driftCalls = (warnSpy.mock.calls as unknown[][])
            .map((c) => String(c[0]))
            .filter((m) => m.includes('Catalog drift'));
        expect(driftCalls.length).toBe(1);
        // Runtime sink (ui.notify) is not used for drift at startup.
        const driftNotify = (notify.mock.calls as unknown[][])
            .map((c) => String(c[0]))
            .filter((m) => m.includes('Catalog drift'));
        expect(driftNotify.length).toBe(0);
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
});
