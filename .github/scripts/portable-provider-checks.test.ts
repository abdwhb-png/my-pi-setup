import { expect, test } from 'bun:test';
import type {
    Model,
    Api,
} from '../../agent/node_modules/@earendil-works/pi-ai/dist/index.js';
import {
    parseProviderCases,
    qualifyProviders,
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
function runtime(selected = model) {
    let calls = 0;
    return {
        get calls() {
            return calls;
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
    for (const budget of [0, -1, NaN, Infinity, 11]) {
        const fixture = runtime();
        await expect(
            qualifyProviders(fixture, cases, budget),
        ).rejects.toThrow();
        expect(fixture.calls).toBe(0);
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
                expect(options?.signal).toBeInstanceOf(AbortSignal);
                return {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'PRIVATE RESPONSE CANARY' },
                    ],
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
