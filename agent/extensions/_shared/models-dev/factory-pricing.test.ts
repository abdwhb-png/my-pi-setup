import { describe, expect, it } from 'bun:test';
import {
    FACTORY_ROUTE_COSTS,
    applyFactoryRouteCostOverride,
    mergeDefinedCosts,
} from './factory-pricing';

describe('mergeDefinedCosts', () => {
    it('preserves absent fields and applies explicit zero values', () => {
        expect(
            mergeDefinedCosts(
                { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
                { input: 0, cacheRead: undefined },
            ),
        ).toEqual({ input: 0, output: 2, cacheRead: 3, cacheWrite: 4 });
    });
});

describe('applyFactoryRouteCostOverride', () => {
    it('overrides only Factory route fields and preserves catalog cache prices', () => {
        const result = applyFactoryRouteCostOverride('glm-5.2', {
            input: 0.1,
            output: 0.3,
            cacheRead: 0.05,
            cacheWrite: 0.02,
        });

        expect(result).toEqual({
            cost: { input: 0.5, output: 2, cacheRead: 0.05, cacheWrite: 0.02 },
            overridden: true,
        });
    });

    it('returns every declared route through the same projection', () => {
        for (const [modelId, expected] of Object.entries(FACTORY_ROUTE_COSTS)) {
            const result = applyFactoryRouteCostOverride(modelId, {});
            expect(result.overridden, modelId).toBe(true);
            expect(result.cost, modelId).toEqual(expected);
        }
    });

    it('leaves unknown routes unchanged', () => {
        const base = { input: 7, cacheRead: 1 };
        expect(applyFactoryRouteCostOverride('unknown-route', base)).toEqual({
            cost: base,
            overridden: false,
        });
    });
});
