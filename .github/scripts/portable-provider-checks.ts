import assert from 'node:assert/strict';
import type { ModelRuntime } from '../../agent/node_modules/@earendil-works/pi-coding-agent/dist/index.js';

export interface ProviderCase {
    provider: string;
    model: string;
    authMode: 'api-key' | 'oauth' | 'subscription';
}

export function parseProviderCases(
    input: string,
    budget: number,
): ProviderCase[] {
    assert(
        Number.isFinite(budget) && budget >= 0 && budget <= 10,
        'Explicit provider budget must be between zero and 10 USD',
    );
    const cases: unknown = JSON.parse(input);
    assert(
        Array.isArray(cases) && cases.length > 0 && cases.length <= 8,
        'Select one to eight provider cases',
    );
    const identities = new Set<string>();
    return cases.map((value: unknown): ProviderCase => {
        assert(
            value &&
                typeof value === 'object' &&
                'provider' in value &&
                'model' in value &&
                'authMode' in value,
        );
        assert(
            typeof value.provider === 'string' &&
                /^[\w.-]+$/.test(value.provider),
        );
        assert(
            typeof value.model === 'string' &&
                value.model.length > 0 &&
                value.model.length <= 200,
        );
        assert(
            value.authMode === 'api-key' ||
                value.authMode === 'oauth' ||
                value.authMode === 'subscription',
        );
        assert.deepEqual(Object.keys(value).toSorted(), [
            'authMode',
            'model',
            'provider',
        ]);
        const identity = `${value.provider}/${value.model}`;
        assert(!identities.has(identity), 'Duplicate provider/model case');
        identities.add(identity);
        return {
            provider: value.provider,
            model: value.model,
            authMode: value.authMode,
        };
    });
}

type QualificationRuntime = Pick<
    ModelRuntime,
    | 'refresh'
    | 'getModel'
    | 'isUsingOAuth'
    | 'isUsingSubscription'
    | 'hasConfiguredAuth'
    | 'completeSimple'
>;

export interface ProviderCheckEvent {
    provider: string;
    model: string;
    event: 'reserved' | 'request-started' | 'response-received';
    maximumCostUSD?: number;
    reportedCostUSD?: number;
    stopReason?: string;
    hasText?: boolean;
    hasThinking?: boolean;
}

export async function inspectProviderCases(
    runtime: QualificationRuntime,
    input: string,
    budget: number,
) {
    const cases = parseProviderCases(input, budget);
    for (const item of cases) {
        const actualMode = runtime.isUsingOAuth(item.provider)
            ? 'oauth'
            : runtime.isUsingSubscription(item.provider)
              ? 'subscription'
              : 'api-key';
        assert.equal(
            actualMode,
            item.authMode,
            'Configured authentication mode differs from the selected case',
        );
        assert(
            runtime.hasConfiguredAuth(item.provider),
            'Selected provider has no configured authentication',
        );
    }
    const refreshed = await runtime.refresh({
        providers: [...new Set(cases.map((item) => item.provider))],
        allowNetwork: true,
        signal: AbortSignal.timeout(30_000),
    });
    assert(
        !refreshed.aborted && refreshed.errors.size === 0,
        'Provider catalog refresh failed',
    );
    // Reserve a whole context window per request, using the refreshed model prices.
    const prepared = cases.map((item) => {
        const model = runtime.getModel(item.provider, item.model);
        assert(model, 'Selected provider model is unavailable');
        const rates = [model.cost, ...(model.cost.tiers ?? [])];
        assert(
            rates.every((rate) =>
                [
                    rate.input,
                    rate.output,
                    rate.cacheRead,
                    rate.cacheWrite,
                ].every((price) => Number.isFinite(price) && price >= 0),
            ),
            'Invalid configured model prices',
        );
        assert(
            Number.isSafeInteger(model.contextWindow) &&
                model.contextWindow > 0 &&
                model.maxTokens >= 16,
            'Invalid configured model token limits',
        );
        const reservation =
            (model.contextWindow *
                Math.max(
                    ...rates.flatMap((rate) => [
                        rate.input,
                        rate.cacheRead,
                        rate.cacheWrite,
                    ]),
                ) +
                16 * Math.max(...rates.map((rate) => rate.output))) /
            1_000_000;
        assert(
            Number.isFinite(reservation) && reservation >= 0,
            'Invalid configured model prices',
        );
        return { item, model, reservation };
    });
    assert(
        prepared.reduce((sum, entry) => sum + entry.reservation, 0) <= budget,
        'Configured worst-case token cost exceeds the approved budget',
    );
    return prepared;
}

export async function qualifyProviders(
    runtime: QualificationRuntime,
    input: string,
    budget: number,
    onProgress?: (event: ProviderCheckEvent) => void,
) {
    const prepared = await inspectProviderCases(runtime, input, budget);
    let spent = 0;
    const results = [];
    for (const { item, model, reservation } of prepared) {
        const identity = { provider: item.provider, model: item.model };
        onProgress?.({
            ...identity,
            event: 'reserved',
            maximumCostUSD: reservation,
        });
        onProgress?.({ ...identity, event: 'request-started' });
        const response = await runtime.completeSimple(
            model,
            {
                messages: [
                    {
                        role: 'user',
                        content: 'Reply with OK.',
                        timestamp: Date.now(),
                    },
                ],
            },
            {
                maxTokens: 16,
                maxRetries: 0,
                timeoutMs: 30_000,
                signal: AbortSignal.timeout(35_000),
            },
        );
        onProgress?.({
            ...identity,
            event: 'response-received',
            reportedCostUSD: response.usage.cost.total,
            stopReason: response.stopReason,
            hasText: response.content.some(
                (part) => part.type === 'text' && part.text.trim().length > 0,
            ),
            hasThinking: response.content.some(
                (part) => part.type === 'thinking',
            ),
        });
        assert(
            ['stop', 'length'].includes(response.stopReason),
            'Provider request failed',
        );
        assert(
            response.content.some(
                (part) => part.type === 'text' && part.text.trim().length > 0,
            ),
            'Provider returned no text',
        );
        const cost = response.usage.cost.total;
        assert(
            Number.isFinite(cost) && cost >= 0,
            'Provider returned invalid cost accounting',
        );
        spent += cost;
        assert(
            spent <= budget,
            'Reported provider cost exceeded the approved budget',
        );
        results.push({ ...item, status: 'passed', reportedCostUSD: cost });
    }
    return results;
}
