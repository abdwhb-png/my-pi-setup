import { expect, test } from 'bun:test';
import type {
    Model,
    Api,
    AssistantMessage,
} from '../../agent/node_modules/@earendil-works/pi-ai/dist/index.js';
import {
    parseProviderCases,
    qualifyProviders,
    inspectProviderCases,
} from './portable-provider-checks.ts';

const cases = JSON.stringify([
    { provider: 'fixture', model: 'tiny', authMode: 'api-key' },
]);
const model: Model<Api> = {
    id: 'tiny',
    name: 'Fixture',
    provider: 'fixture',
    api: 'openai-completions',
    baseUrl: 'https://invalid.example',
    input: ['text'],
    reasoning: false,
    contextWindow: 1000,
    maxTokens: 16,
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
};
const response: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: 'PRIVATE RESPONSE CANARY' }],
    api: model.api,
    model: model.id,
    provider: model.provider,
    stopReason: 'stop',
    timestamp: 1,
    usage: {
        input: 4,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 5,
        cost: {
            input: 0.000004,
            output: 0.000001,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.000005,
        },
    },
};

function runtime(selected = model) {
    let calls = 0;
    let refreshCalls = 0;
    return {
        get calls() {
            return calls;
        },
        get refreshCalls() {
            return refreshCalls;
        },
        refresh: async () => {
            refreshCalls++;
            return { aborted: false, errors: new Map<string, Error>() };
        },
        getModel: () => selected,
        isUsingOAuth: () => false,
        isUsingSubscription: () => false,
        hasConfiguredAuth: () => true,
        completeSimple: async () => {
            calls++;
            throw new Error('fixture provider failure');
        },
    };
}

test('invalid or absent authorization prevents all provider calls', async () => {
    for (const budget of [-1, NaN, Infinity, 11]) {
        const fixture = runtime();
        await expect(
            qualifyProviders(fixture, cases, budget),
        ).rejects.toThrow();
        expect(fixture.calls).toBe(0);
        expect(fixture.refreshCalls).toBe(0);
    }
    expect(() => parseProviderCases('[]', 1)).toThrow();
    expect(() =>
        parseProviderCases(cases.replace('api-key', 'unknown'), 1),
    ).toThrow();
    expect(() =>
        parseProviderCases(
            JSON.stringify([...JSON.parse(cases), ...JSON.parse(cases)]),
            1,
        ),
    ).toThrow();
});

test('wrong auth mode and insufficient budget prevent all provider calls', async () => {
    const fixture = runtime();
    await expect(
        qualifyProviders(fixture, cases.replace('api-key', 'oauth'), 1),
    ).rejects.toThrow();
    expect(fixture.refreshCalls).toBe(0);
    await expect(qualifyProviders(fixture, cases, 0.0001)).rejects.toThrow();
    expect(fixture.calls).toBe(0);
});

test('a provider failure is not retried', async () => {
    const fixture = runtime();
    await expect(qualifyProviders(fixture, cases, 1)).rejects.toThrow(
        'fixture provider failure',
    );
    expect(fixture.calls).toBe(1);
});

test('negative configured input prices cannot be offset by output prices', async () => {
    const fixture = runtime({
        ...model,
        cost: { ...model.cost, input: -0.001 },
    });
    await expect(qualifyProviders(fixture, cases, 1)).rejects.toThrow(
        'Invalid configured model prices',
    );
    expect(fixture.calls).toBe(0);
});

test('a successful check bounds the request and records no response content', async () => {
    const fixture = runtime();
    const result = await qualifyProviders(
        {
            ...fixture,
            completeSimple: async (selected, context, options) => {
                expect(selected).toBe(model);
                expect(context.messages).toHaveLength(1);
                expect(context.tools).toBeUndefined();
                expect(options).toMatchObject({
                    maxTokens: 16,
                    maxRetries: 0,
                    timeoutMs: 30_000,
                });
                expect(options?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
                expect(options?.signal).toBeInstanceOf(AbortSignal);
                return response;
            },
        },
        cases,
        1,
    );
    expect(result).toEqual([
        {
            provider: 'fixture',
            model: 'tiny',
            authMode: 'api-key',
            status: 'passed',
            reportedCostUSD: 0.000005,
        },
    ]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE RESPONSE CANARY');
});

test('a fresh installation refreshes only selected catalogs before resolving models', async () => {
    const fixture = runtime();
    let refreshed = false;
    await expect(
        qualifyProviders(
            {
                ...fixture,
                getModel: () => (refreshed ? model : undefined),
                refresh: async (options) => {
                    expect(options?.providers).toEqual(['fixture']);
                    expect(options?.allowNetwork).toBe(true);
                    expect(options?.signal).toBeInstanceOf(AbortSignal);
                    refreshed = true;
                    return { aborted: false, errors: new Map<string, Error>() };
                },
            },
            cases,
            1,
        ),
    ).rejects.toThrow('fixture provider failure');
    expect(refreshed).toBe(true);
    expect(fixture.calls).toBe(1);
});

test('catalog failures and cancellation prevent completion requests', async () => {
    for (const result of [
        { aborted: true, errors: new Map<string, Error>() },
        {
            aborted: false,
            errors: new Map([['fixture', new Error('PRIVATE CATALOG ERROR')]]),
        },
    ]) {
        const fixture = runtime();
        await expect(
            qualifyProviders(
                { ...fixture, refresh: async () => result },
                cases,
                1,
            ),
        ).rejects.toThrow('Provider catalog refresh failed');
        expect(fixture.calls).toBe(0);
    }
});

test('request reservations survive a provider failure without response text', async () => {
    const events: unknown[] = [];
    const fixture = runtime();
    await expect(
        qualifyProviders(fixture, cases, 1, (event) => events.push(event)),
    ).rejects.toThrow('fixture provider failure');
    expect(events).toEqual([
        {
            provider: 'fixture',
            model: 'tiny',
            event: 'reserved',
            maximumCostUSD: 0.001016,
        },
        { provider: 'fixture', model: 'tiny', event: 'request-started' },
    ]);
});

test('failed responses preserve accounting without raw provider errors', async () => {
    const events: unknown[] = [];
    await expect(
        qualifyProviders(
            {
                ...runtime(),
                completeSimple: async () => ({
                    ...response,
                    stopReason: 'error' as const,
                    content: [],
                    errorMessage: '401 PRIVATE ERROR CANARY',
                }),
            },
            cases,
            1,
            (event) => events.push(event),
        ),
    ).rejects.toThrow('Provider request failed');
    expect(events.at(-1)).toMatchObject({
        event: 'response-received',
        failure: 'authentication-rejected',
        reportedCostUSD: 0.000005,
        stopReason: 'error',
        hasText: false,
    });
    expect(JSON.stringify(events)).not.toContain('PRIVATE ERROR CANARY');
});

test('catalog inspection reports the reservation without requesting a completion', async () => {
    const fixture = runtime();
    const prepared = await inspectProviderCases(fixture, cases, 1);
    expect(prepared[0].reservation).toBe(0.001016);
    expect(fixture.calls).toBe(0);
});

test('an explicit zero budget permits only zero-priced completions', async () => {
    const fixture = runtime({
        ...model,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    const results = await qualifyProviders(
        {
            ...fixture,
            completeSimple: async () => ({
                ...response,
                usage: {
                    ...response.usage,
                    cost: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        total: 0,
                    },
                },
            }),
        },
        cases,
        0,
    );
    expect(results[0].reportedCostUSD).toBe(0);
    const paid = runtime();
    await expect(qualifyProviders(paid, cases, 0)).rejects.toThrow(
        'Configured worst-case token cost exceeds the approved budget',
    );
    expect(paid.calls).toBe(0);
});

test('zero-budget qualification refuses a positive cache price before generation', async () => {
    const fixture = runtime({
        ...model,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 1 },
    });
    await expect(qualifyProviders(fixture, cases, 0)).rejects.toThrow(
        'Configured worst-case token cost exceeds the approved budget',
    );
    expect(fixture.calls).toBe(0);
});

test('request diagnostics expose only fixed parameter and rejection labels', async () => {
    const events: unknown[] = [];
    await expect(
        qualifyProviders(
            {
                ...runtime(),
                completeSimple: async () => ({
                    ...response,
                    stopReason: 'error' as const,
                    content: [],
                    errorMessage:
                        '400 Unsupported parameter max_tokens; sk-PRIVATE_SECRET_CANARY',
                }),
            },
            cases,
            1,
            (event) => events.push(event),
        ),
    ).rejects.toThrow('Provider request failed');
    expect(events.at(-1)).toMatchObject({
        failure: 'invalid-request',
        requestError: { parameters: ['max_tokens'], reasons: ['unsupported'] },
    });
    expect(JSON.stringify(events)).not.toContain('PRIVATE_SECRET_CANARY');
});
