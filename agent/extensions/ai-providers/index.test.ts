/**
 * Tests for index.ts — ai-providers extension composition.
 *
 * Uses mock.module() before the dynamic import so the real entry point is
 * exercised against mocked dependencies. Proves the real entry:
 *   - registers enabled providers and collects their handles
 *   - installs exactly one shared models.dev lifecycle, registered before
 *     the providers, reading the completed refresher list via closure
 *   - omits disabled providers (and their refreshers) entirely
 */

import { describe, expect, it, mock } from 'bun:test';

const order: string[] = [];
const registeredProviders: string[] = [];
let enabled: Record<string, boolean> = { 'factory-ai': true, cpa: true };
let capturedGetRefreshers: (() => unknown[]) | undefined;
const integrationCalls = mock(() => {});

mock.module('./config.ts', () => ({
    isProviderEnabled: (name: string) => enabled[name] ?? true,
    isWidgetEnabled: () => true,
}));
mock.module('./models-dev.ts', () => ({
    registerModelsDevIntegration: (
        _pi: unknown,
        _catalog: unknown,
        getRefreshers: () => unknown[],
    ) => {
        order.push('integration');
        capturedGetRefreshers = getRefreshers;
        integrationCalls();
    },
}));
mock.module('./providers/factory-ai.ts', () => ({
    registerFactoryProvider: () => {
        order.push('factory-ai');
        registeredProviders.push('factory-ai');
        return {
            providerId: 'factory-ai',
            refreshProjection: mock(async () => {}),
        };
    },
}));
mock.module('./providers/cpa.ts', () => ({
    registerCpaProvider: () => {
        order.push('cpa');
        registeredProviders.push('cpa');
        return { providerId: 'cpa', refreshProjection: mock(async () => {}) };
    },
}));
mock.module('./widgets/factory-credits.ts', () => ({
    registerFactoryCreditsWidget: () => {
        order.push('factory-widget');
    },
}));
mock.module('./commands/providers.ts', () => ({
    registerProvidersCommand: () => {
        order.push('providers-command');
    },
}));

const { default: aiProvidersExtension } = await import('./index.ts');

const mockPi = { on: mock(() => {}), registerProvider: mock(() => {}) };

describe('aiProvidersExtension composition', () => {
    it('registers enabled providers, collects handles, and installs one shared lifecycle', () => {
        enabled = { 'factory-ai': true, cpa: true };
        registeredProviders.length = 0;
        order.length = 0;
        capturedGetRefreshers = undefined;
        integrationCalls.mockClear();

        aiProvidersExtension(mockPi as never);

        // One shared lifecycle, registered before the providers, reading the
        // completed refresher list via closure.
        expect(integrationCalls).toHaveBeenCalledTimes(1);
        expect(order[0]).toBe('integration');
        expect(registeredProviders).toEqual(['factory-ai', 'cpa']);
        // Both enabled providers contributed their handles to the closure.
        const refreshers = capturedGetRefreshers!();
        expect(refreshers.length).toBe(2);
        for (const r of refreshers) {
            expect(typeof (r as { refreshProjection: unknown }).refreshProjection).toBe(
                'function',
            );
        }
    });

    it('omits disabled provider refreshers', () => {
        enabled = { 'factory-ai': false, cpa: true };
        registeredProviders.length = 0;
        order.length = 0;
        capturedGetRefreshers = undefined;
        integrationCalls.mockClear();

        aiProvidersExtension(mockPi as never);

        expect(registeredProviders).toEqual(['cpa']);
        expect(capturedGetRefreshers!().length).toBe(1);

        enabled = { 'factory-ai': true, cpa: false };
        registeredProviders.length = 0;
        order.length = 0;
        capturedGetRefreshers = undefined;

        aiProvidersExtension(mockPi as never);

        expect(registeredProviders).toEqual(['factory-ai']);
        expect(capturedGetRefreshers!().length).toBe(1);
    });

    it('installs the lifecycle even when every provider is disabled', () => {
        enabled = { 'factory-ai': false, cpa: false };
        registeredProviders.length = 0;
        order.length = 0;
        capturedGetRefreshers = undefined;
        integrationCalls.mockClear();

        aiProvidersExtension(mockPi as never);

        expect(integrationCalls).toHaveBeenCalledTimes(1);
        expect(registeredProviders).toEqual([]);
        expect(capturedGetRefreshers!().length).toBe(0);
    });

    it('keeps the global command registration', () => {
        enabled = { 'factory-ai': false, cpa: false };
        order.length = 0;

        aiProvidersExtension(mockPi as never);

        expect(order).toContain('providers-command');
    });
});
